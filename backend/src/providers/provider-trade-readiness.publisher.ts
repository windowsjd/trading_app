import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  readProviderTradeReadinessConfig,
  type ProviderTradeReadinessConfig,
} from './provider-trade-readiness.config';
import {
  PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
  ProviderTradeReadinessStore,
  type SharedAssetRecord,
  type SharedProviderMeta,
} from './provider-trade-readiness.store';
import {
  ProviderTradeRouteRegistry,
  type TradeRouteProvider,
} from './provider-trade-route.registry';

const PROVIDERS: readonly TradeRouteProvider[] = ['kis', 'binance'];

/**
 * Mirrors this process's canonical trade-route registry into the shared Redis
 * readiness view, on a timer.
 *
 * A timer rather than write-through on every registry mutation, because:
 *   - the TTL is the owner heartbeat and has to be refreshed regardless of
 *     whether anything changed;
 *   - registry mutations happen on the socket hot path (`markFrame` fires on
 *     EVERY frame) and must never await a Redis round trip.
 *
 * It publishes ONLY for providers this process actually owns and has an
 * established connection for. A process that owns nothing publishes nothing,
 * so it can never mask the real owner.
 *
 * On shutdown it compare-and-deletes its own generation, so a fast restart
 * does not leave a stale "connected" record behind. The delete is a no-op if
 * another instance has already taken over — that is precisely the late-release
 * race the store's compare-and-delete exists for.
 */
@Injectable()
export class ProviderTradeReadinessPublisher
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ProviderTradeReadinessPublisher.name);
  private readonly config: ProviderTradeReadinessConfig;
  private timer: NodeJS.Timeout | null = null;
  private publishing = false;
  /** Generations this process published, so shutdown can release exactly them. */
  private readonly published = new Map<TradeRouteProvider, string>();

  constructor(
    private readonly routes: ProviderTradeRouteRegistry,
    @Optional() private readonly store?: ProviderTradeReadinessStore,
    // @Optional so Nest does not try to resolve a plain object type as a
    // provider; the default is what production actually uses.
    @Optional()
    config: ProviderTradeReadinessConfig = readProviderTradeReadinessConfig(),
  ) {
    this.config = config;
  }

  isEnabled(): boolean {
    return this.config.enabled && this.store?.isAvailable() === true;
  }

  onModuleInit(): void {
    if (!this.isEnabled()) return;
    this.timer = setInterval(() => {
      void this.publishOnce();
    }, this.config.publishIntervalMs);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.store) return;
    for (const [provider, generation] of this.published) {
      await this.store
        .release({
          provider,
          generation,
          ownerInstance: this.config.instanceId,
        })
        .catch(() => undefined);
    }
    this.published.clear();
  }

  /**
   * One publish pass. Exposed for tests and for the ops smoke script; a
   * failure is logged and swallowed, because losing the shared view must
   * degrade readiness to fail-closed, never take down the socket owner.
   */
  async publishOnce(now = Date.now()): Promise<void> {
    if (!this.store || this.publishing) return;
    this.publishing = true;
    try {
      for (const provider of PROVIDERS) {
        await this.publishProvider(provider, now);
      }
    } catch (error) {
      this.logger.warn(
        `Shared trade readiness publish failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.publishing = false;
    }
  }

  private async publishProvider(
    provider: TradeRouteProvider,
    now: number,
  ): Promise<void> {
    const store = this.store;
    if (!store) return;
    const snapshot = this.routes.exportSharedState(provider);
    if (!snapshot) {
      // Not the owner (or not connected). Release only what THIS process
      // published; another instance's record is protected by the store's
      // compare-and-delete.
      const previous = this.published.get(provider);
      if (previous) {
        this.published.delete(provider);
        await store
          .release({
            provider,
            generation: previous,
            ownerInstance: this.config.instanceId,
          })
          .catch(() => undefined);
      }
      return;
    }

    // Assets first: a reader that resolves the new generation from the meta
    // must find its hash already populated, otherwise every asset would read
    // as "not subscribed" for one publish interval after a reconnect.
    const records: SharedAssetRecord[] = snapshot.assets.map((entry) => ({
      schemaVersion: PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
      assetId: entry.asset.assetId,
      providerSymbol: entry.asset.providerSymbol,
      symbol: entry.asset.symbol,
      market: entry.asset.market,
      assetType: entry.asset.assetType,
      settlementCurrency: entry.asset.settlementCurrency,
      sourceName: entry.asset.sourceName,
      state: entry.state,
      generation: snapshot.generation,
      acknowledgedAt: entry.acknowledgedAt,
      updatedAt: entry.updatedAt,
    }));
    await store.publishAssets({
      provider,
      generation: snapshot.generation,
      records,
      ttlSeconds: this.config.ttlSeconds,
    });

    const meta: SharedProviderMeta = {
      schemaVersion: PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
      provider,
      ownerInstance: this.config.instanceId,
      source: snapshot.source,
      generation: snapshot.generation,
      connected: snapshot.connected,
      connectedAt: snapshot.connectedAt,
      lastFrameAt: snapshot.lastFrameAt,
      lastUpdatedAt: now,
      degradedReason: null,
    };
    const accepted = await store.publishProvider({
      meta,
      ttlSeconds: this.config.ttlSeconds,
    });
    if (!accepted) {
      // A newer owner holds the key. Stop tracking the generation so shutdown
      // does not try to release someone else's record.
      this.published.delete(provider);
      return;
    }

    const previous = this.published.get(provider);
    if (previous && previous !== snapshot.generation) {
      // Reconnect: drop the superseded generation's hash immediately instead
      // of waiting for its TTL. The meta already points at the new one, so no
      // reader can still resolve the old key.
      await store
        .releaseSupersededAssets({
          provider,
          supersededGeneration: previous,
          ownerInstance: this.config.instanceId,
        })
        .catch(() => undefined);
    }
    this.published.set(provider, snapshot.generation);
  }
}
