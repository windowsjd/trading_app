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
 *
 * OWNER FENCING
 * -------------
 * Before it may publish anything, this publisher acquires a FENCE TOKEN from
 * the store (see `ProviderTradeReadinessStore`). The token — not a timestamp —
 * is what makes two instances that both believe they own the socket resolvable
 * into exactly one shared-view owner:
 *
 *   - no token means no publish, so a process that lost the race stays silent
 *     instead of overwriting the winner with its own subscription set;
 *   - a refused publish means a newer token exists. The publisher drops its
 *     token immediately and stops publishing that provider. It re-attempts
 *     acquisition on the next tick, which can only succeed once the incumbent
 *     stops heartbeating and its record expires.
 *
 * Losing the shared view NEVER touches the socket: this process keeps owning
 * its connection and keeps answering readiness from its own registry. Only the
 * cross-instance mirror changes hands.
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
  /** Fence tokens currently held. No entry means "not the shared-view owner". */
  private readonly fenceTokens = new Map<TradeRouteProvider, number>();
  /** Last observed rival, for diagnostics only; never a control input. */
  private readonly fencedOutBy = new Map<TradeRouteProvider, string>();

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
      const fenceToken = this.fenceTokens.get(provider);
      // Without the token this process cannot prove the record is its own, and
      // a release that cannot be proven must not happen.
      if (fenceToken === undefined) continue;
      await this.store
        .release({
          provider,
          generation,
          ownerInstance: this.config.instanceId,
          fenceToken,
        })
        .catch(() => undefined);
    }
    this.published.clear();
    this.fenceTokens.clear();
  }

  /**
   * Diagnostics for the ops snapshot: which providers this process currently
   * owns in the SHARED view, and under which fence token.
   */
  ownershipSnapshot(): Record<
    string,
    {
      fenceToken: number | null;
      generation: string | null;
      fencedOutBy?: string;
    }
  > {
    const snapshot: Record<
      string,
      {
        fenceToken: number | null;
        generation: string | null;
        fencedOutBy?: string;
      }
    > = {};
    for (const provider of PROVIDERS) {
      const rival = this.fencedOutBy.get(provider);
      snapshot[provider] = {
        fenceToken: this.fenceTokens.get(provider) ?? null,
        generation: this.published.get(provider) ?? null,
        ...(rival === undefined ? {} : { fencedOutBy: rival }),
      };
    }
    return snapshot;
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
      const fenceToken = this.fenceTokens.get(provider);
      // Give up the claim as well: a process with nothing to publish must not
      // keep another instance from taking the provider over. Deleting the meta
      // also makes every reader fail closed immediately, which is the correct
      // answer while this process has no established connection.
      this.published.delete(provider);
      this.fenceTokens.delete(provider);
      if (previous && fenceToken !== undefined) {
        await store
          .release({
            provider,
            generation: previous,
            ownerInstance: this.config.instanceId,
            fenceToken,
          })
          .catch(() => undefined);
      }
      return;
    }

    const fenceToken = await this.ensureFenceToken(provider);
    if (fenceToken === null) return;

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
    const assetsAccepted = await store.publishAssets({
      provider,
      generation: snapshot.generation,
      ownerInstance: this.config.instanceId,
      fenceToken,
      records,
      ttlSeconds: this.config.ttlSeconds,
    });
    if (!assetsAccepted) {
      this.handleFencedOut(provider, 'assets');
      return;
    }

    const meta: SharedProviderMeta = {
      schemaVersion: PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
      provider,
      ownerInstance: this.config.instanceId,
      source: snapshot.source,
      generation: snapshot.generation,
      fenceToken,
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
      this.handleFencedOut(provider, 'meta');
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
          fenceToken,
        })
        .catch(() => undefined);
    }
    this.published.set(provider, snapshot.generation);
    this.fencedOutBy.delete(provider);
  }

  /**
   * The token this process publishes under, acquiring one if it holds none.
   * Returns null when another instance owns the shared view — the correct
   * outcome is silence, not a retry storm.
   */
  private async ensureFenceToken(
    provider: TradeRouteProvider,
  ): Promise<number | null> {
    const held = this.fenceTokens.get(provider);
    if (held !== undefined) return held;
    const store = this.store;
    if (!store) return null;

    const claim = await store
      .acquireOwnership({ provider, ownerInstance: this.config.instanceId })
      .catch(() => ({
        acquired: false as const,
        fenceToken: null,
        heldBy: null,
      }));
    if (!claim.acquired || claim.fenceToken === null) {
      if (claim.heldBy && this.fencedOutBy.get(provider) !== claim.heldBy) {
        this.fencedOutBy.set(provider, claim.heldBy);
        this.logger.warn(
          JSON.stringify({
            event: 'limit_order_shared_readiness_not_owner',
            provider,
            heldBy: claim.heldBy,
            instanceId: this.config.instanceId,
          }),
        );
      }
      return null;
    }
    this.fenceTokens.set(provider, claim.fenceToken);
    this.logger.log(
      JSON.stringify({
        event: 'limit_order_shared_readiness_owner_acquired',
        provider,
        fenceToken: claim.fenceToken,
        instanceId: this.config.instanceId,
      }),
    );
    return claim.fenceToken;
  }

  /**
   * A newer fence token exists. Surrender the claim so the shared view keeps
   * exactly one publisher; the local socket and the local registry are
   * untouched, so path A and owner-instance readiness keep working.
   */
  private handleFencedOut(
    provider: TradeRouteProvider,
    stage: 'assets' | 'meta',
  ): void {
    const surrendered = this.fenceTokens.get(provider) ?? null;
    this.fenceTokens.delete(provider);
    this.published.delete(provider);
    this.logger.warn(
      JSON.stringify({
        event: 'limit_order_shared_readiness_fenced_out',
        provider,
        stage,
        surrenderedFenceToken: surrendered,
        instanceId: this.config.instanceId,
      }),
    );
  }
}
