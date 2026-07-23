import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  readProviderTradeReadinessConfig,
  type ProviderTradeReadinessConfig,
} from './provider-trade-readiness.config';
import {
  assertReadinessKeySlots,
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
 * OWNERSHIP = THE PROVIDER OWNER LEASE
 * ------------------------------------
 * Publishing rights are derived from the SAME Redis lease the live-candle
 * supervisor holds while it owns the provider socket — never from a parallel
 * readiness-only token, and never from the local registry alone:
 *
 *   - the registry snapshot must carry the lease (key + token) the supervisor
 *     registered. A claim with no lease — the legacy streaming service, or a
 *     process whose supervisor lost its lease mid-connection — publishes
 *     NOTHING; there is no cross-process evidence to fence the write against.
 *   - the store exchanges that lease for a monotonic FENCING EPOCH, and every
 *     write re-verifies lease + epoch inside Redis atomically. Losing the
 *     lease revokes publish rights at the very next write.
 *   - a refused write means "fenced out": the cached epoch is dropped and the
 *     publisher goes silent for that provider. It re-attempts on later ticks,
 *     which can only succeed while it actually holds the live lease again.
 *
 * Losing the shared view NEVER touches the socket: this process keeps owning
 * its connection and keeps answering readiness from its own registry. Only
 * the cross-instance mirror changes hands.
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
  /**
   * Fencing epochs held, keyed by the lease token they were issued to. A new
   * lease (a new ownership, even by the same process) never reuses an epoch.
   */
  private readonly epochs = new Map<
    TradeRouteProvider,
    { leaseToken: string; fencingEpoch: number }
  >();
  /** Last refusal reason per provider, for diagnostics only. */
  private readonly refusals = new Map<TradeRouteProvider, string>();
  /** Providers warned about a lease-less claim, so the log fires once. */
  private readonly warnedNoLease = new Set<TradeRouteProvider>();

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
    // Fail fast, not on the first publish: a clustered Redis rejects the
    // fenced scripts unless every readiness key shares the lease key's slot.
    for (const provider of PROVIDERS) assertReadinessKeySlots(provider);
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
      const epoch = this.epochs.get(provider);
      // Without the epoch this process cannot prove the record is its own,
      // and a release that cannot be proven must not happen.
      if (!epoch) continue;
      await this.store
        .release({
          provider,
          generation,
          ownerInstance: this.config.instanceId,
          fencingEpoch: epoch.fencingEpoch,
        })
        .catch(() => undefined);
    }
    this.published.clear();
    this.epochs.clear();
  }

  /**
   * Diagnostics for the ops snapshot: which providers this process currently
   * publishes in the SHARED view, and under which fencing epoch.
   */
  ownershipSnapshot(): Record<
    string,
    {
      fencingEpoch: number | null;
      generation: string | null;
      refusedBecause?: string;
    }
  > {
    const snapshot: Record<
      string,
      {
        fencingEpoch: number | null;
        generation: string | null;
        refusedBecause?: string;
      }
    > = {};
    for (const provider of PROVIDERS) {
      const refusal = this.refusals.get(provider);
      snapshot[provider] = {
        fencingEpoch: this.epochs.get(provider)?.fencingEpoch ?? null,
        generation: this.published.get(provider) ?? null,
        ...(refusal === undefined ? {} : { refusedBecause: refusal }),
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
      // compare-and-delete. The claim is dropped as well: a process with
      // nothing to publish must not keep another instance out, and deleting
      // the meta makes every reader fail closed immediately.
      await this.releasePublished(provider, 'route_released');
      return;
    }

    if (!snapshot.ownerLease) {
      // A local claim with no Redis lease behind it. The legacy streaming
      // service claims routes this way; a supervisor that lost its lease
      // mid-connection clears the lease (`clearOwnerLease`) the same instant.
      // Neither can prove ownership to another instance, so neither may
      // publish — AND whatever THIS process already published is now a stale
      // record with no live lease behind it. It must not sit in Redis until
      // its TTL lapses: readers fail closed on the lease check either way,
      // but the record's continued existence invites diagnosis confusion and
      // depends on every reader running the new read path. Compare-and-delete
      // it NOW; the store's guard (owner + generation + epoch against the
      // STORED meta) makes this a no-op if a new owner already republished.
      await this.releasePublished(provider, 'owner_lease_missing');
      if (!this.warnedNoLease.has(provider)) {
        this.warnedNoLease.add(provider);
        this.logger.warn(
          JSON.stringify({
            event: 'limit_order_shared_readiness_no_owner_lease',
            provider,
            source: snapshot.source,
            instanceId: this.config.instanceId,
            effect:
              'shared readiness is not published; own stale record released; only the lease-holding supervisor may publish',
          }),
        );
      }
      return;
    }
    this.warnedNoLease.delete(provider);

    const lease = snapshot.ownerLease;
    // A NEW lease token (a new ownership, even by the same process) makes
    // everything published under the OLD token stale-by-authority. Release it
    // before acquiring under the new token, so no reader window mixes the two.
    const cached = this.epochs.get(provider);
    if (cached && cached.leaseToken !== lease.token) {
      await this.releasePublished(provider, 'lease_token_rotated');
    }
    const fencingEpoch = await this.ensureFencingEpoch(provider, lease.token);
    if (fencingEpoch === null) {
      // The route claims a lease this process cannot exchange for an epoch —
      // the live lease belongs to someone else (or Redis refused). Anything
      // this process previously published is unprovable now; release it under
      // the guarded compare-and-delete rather than waiting for the TTL.
      await this.releasePublished(provider, 'epoch_refused');
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
    const assetsAccepted = await store.publishAssets({
      provider,
      generation: snapshot.generation,
      leaseToken: lease.token,
      fencingEpoch,
      records,
      ttlSeconds: this.config.ttlSeconds,
    });
    if (!assetsAccepted) {
      await this.handleFencedOut(provider, 'assets');
      return;
    }

    const meta: SharedProviderMeta = {
      schemaVersion: PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
      provider,
      ownerInstance: this.config.instanceId,
      source: snapshot.source,
      generation: snapshot.generation,
      fencingEpoch,
      leaseTokenDigest: digestLeaseToken(lease.token),
      connected: snapshot.connected,
      connectedAt: snapshot.connectedAt,
      lastFrameAt: snapshot.lastFrameAt,
      lastUpdatedAt: now,
      degradedReason: null,
    };
    const accepted = await store.publishProvider({
      meta,
      leaseToken: lease.token,
      ttlSeconds: this.config.ttlSeconds,
    });
    if (!accepted) {
      await this.handleFencedOut(provider, 'meta');
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
          fencingEpoch,
        })
        .catch(() => undefined);
    }
    this.published.set(provider, snapshot.generation);
    this.refusals.delete(provider);
  }

  /**
   * The fencing epoch this process publishes under, exchanged for the CURRENT
   * lease token. A cached epoch is only reused while the lease token is the
   * same one it was issued to; a new lease always re-acquires. Returns null
   * when the lease is not actually held in Redis — the correct outcome is
   * silence, not a retry storm.
   */
  private async ensureFencingEpoch(
    provider: TradeRouteProvider,
    leaseToken: string,
  ): Promise<number | null> {
    const held = this.epochs.get(provider);
    if (held && held.leaseToken === leaseToken) return held.fencingEpoch;
    this.epochs.delete(provider);
    const store = this.store;
    if (!store) return null;

    const claim = await store
      .acquireOwnership({ provider, leaseToken })
      .catch(() => ({
        acquired: false as const,
        fencingEpoch: null,
        reason: 'redis_error',
      }));
    if (!claim.acquired || claim.fencingEpoch === null) {
      const reason = claim.reason ?? 'refused';
      if (this.refusals.get(provider) !== reason) {
        this.refusals.set(provider, reason);
        this.logger.warn(
          JSON.stringify({
            event: 'limit_order_shared_readiness_not_owner',
            provider,
            reason,
            instanceId: this.config.instanceId,
          }),
        );
      }
      return null;
    }
    this.epochs.set(provider, {
      leaseToken,
      fencingEpoch: claim.fencingEpoch,
    });
    this.refusals.delete(provider);
    this.logger.log(
      JSON.stringify({
        event: 'limit_order_shared_readiness_owner_acquired',
        provider,
        fencingEpoch: claim.fencingEpoch,
        instanceId: this.config.instanceId,
      }),
    );
    return claim.fencingEpoch;
  }

  /**
   * The lease or epoch no longer belongs to this process. Surrender the claim
   * so the shared view keeps exactly one publisher; the local socket and the
   * local registry are untouched, so path A and owner-instance readiness keep
   * working.
   *
   * Also attempts a guarded release of what this process previously
   * published: if a new owner already republished, the compare-and-delete is
   * a no-op; if the refusal came from a lease that merely EXPIRED (no
   * successor yet), the release removes this process's now-unprovable record
   * instead of leaving it to its TTL.
   */
  private async handleFencedOut(
    provider: TradeRouteProvider,
    stage: 'assets' | 'meta',
  ): Promise<void> {
    const surrendered = this.epochs.get(provider)?.fencingEpoch ?? null;
    this.refusals.set(provider, `fenced_out_${stage}`);
    this.logger.warn(
      JSON.stringify({
        event: 'limit_order_shared_readiness_fenced_out',
        provider,
        stage,
        surrenderedFencingEpoch: surrendered,
        instanceId: this.config.instanceId,
      }),
    );
    await this.releasePublished(provider, `fenced_out_${stage}`);
  }

  /**
   * Guarded compare-and-delete of the record THIS process published, then
   * drops the local claim. Deleting a successor's record is impossible: the
   * store's release script verifies owner instance, generation AND fencing
   * epoch against the STORED meta before touching anything.
   */
  private async releasePublished(
    provider: TradeRouteProvider,
    cause: string,
  ): Promise<void> {
    const generation = this.published.get(provider);
    const epoch = this.epochs.get(provider);
    this.published.delete(provider);
    this.epochs.delete(provider);
    // Without the epoch this process cannot prove the record is its own, and
    // a release that cannot be proven must not happen.
    if (!this.store || !generation || !epoch) return;
    const released = await this.store
      .release({
        provider,
        generation,
        ownerInstance: this.config.instanceId,
        fencingEpoch: epoch.fencingEpoch,
      })
      .catch(() => false);
    this.logger.warn(
      JSON.stringify({
        event: 'limit_order_shared_readiness_stale_release',
        provider,
        cause,
        generation,
        fencingEpoch: epoch.fencingEpoch,
        released,
        instanceId: this.config.instanceId,
      }),
    );
  }
}

/** Non-secret digest for diagnostics; never used in any comparison. */
export function digestLeaseToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}
