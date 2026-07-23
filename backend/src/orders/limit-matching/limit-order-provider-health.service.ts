import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import { AssetType } from '../../generated/prisma/client';
import { BinanceWebSocketStreamingService } from '../../providers/binance/binance-websocket-streaming.service';
import { KisWebSocketStreamingService } from '../../providers/kis/kis-websocket-streaming.service';
import {
  readProviderTradeReadinessConfig,
  type ProviderTradeReadinessConfig,
} from '../../providers/provider-trade-readiness.config';
import { ProviderTradeReadinessStore } from '../../providers/provider-trade-readiness.store';
import {
  ProviderTradeRouteRegistry,
  tradeRouteProviderForAssetType,
  type AssetTradeReadiness,
  type ProviderTradeSource,
  type TradeRouteProvider,
} from '../../providers/provider-trade-route.registry';
import { readLimitOrderMatchingConfig } from './limit-order-matching.config';
import { LimitOrderPriceEventPublisher } from './limit-order-price-event.publisher';

export type LimitOrderProviderAssetRequest = {
  assetId: string;
  symbol: string;
  market: string;
  assetType: AssetType;
};

/**
 * Which authority answered a readiness check.
 *
 *   'local'  — this process owns the provider socket; its registry mirrors the
 *              live connection and is the authority.
 *   'shared' — this process does NOT own the socket; the verdict came from the
 *              cross-instance Redis view published by whichever instance does.
 *   'legacy' — neither a registry owner nor a shared view exists, so the
 *              per-provider streaming status answered.
 */
export type LimitOrderProviderReadinessOwnerMode =
  | 'local'
  | 'shared'
  | 'legacy';

/**
 * Evidence that per-asset provider readiness was established, carried from the
 * pre-transaction check into the create transaction.
 *
 * WHY THIS TYPE EXISTS
 * --------------------
 * The create transaction cannot re-run the shared (Redis) check: it holds the
 * event-boundary advisory lock, and a network round trip under that lock
 * stalls the matcher and every other create. Before this proof existed the
 * in-transaction re-check was a purely synchronous call that, on an instance
 * which does NOT own the provider socket, silently fell through to the LEGACY
 * per-provider streaming status. On a dedicated API pod that status is not
 * connected, so the same request that passed the shared pre-check then failed
 * inside the transaction with 503 — the identical request succeeded or failed
 * depending on which pod served it, which is precisely what shared readiness
 * exists to eliminate.
 *
 * The proof makes the in-transaction step verify the SAME verdict the
 * pre-check reached, in memory, with no fallback to a different authority.
 */
export type LimitOrderProviderReadinessProof = {
  provider: TradeRouteProvider;
  assetId: string;
  source: ProviderTradeSource;
  /** Connection generation the verdict belongs to; 'legacy' when unknown. */
  generation: string;
  ownerMode: LimitOrderProviderReadinessOwnerMode;
  checkedAt: number;
  expiresAt: number;
};

const PROOF_OWNER_MODES: ReadonlySet<string> = new Set([
  'local',
  'shared',
  'legacy',
]);
const PROOF_SOURCES: ReadonlySet<string> = new Set([
  'live_candle_supervisor',
  'legacy_streaming',
]);
/**
 * A checkedAt slightly ahead of `now` is a benign monotonic/clock artifact of
 * reading Date.now() twice; one materially in the future is an unorderable
 * proof and is rejected as invalid.
 */
const PROOF_FUTURE_SKEW_TOLERANCE_MS = 1000;

/**
 * Per-ASSET readiness gate for automatic limit-order matching.
 *
 * "The provider socket is connected" is not sufficient: a limit order may only
 * be accepted when the exact asset it targets is actually subscribed on the
 * canonical connection of the CURRENT connection generation, the subscription
 * was acknowledged, it was not dropped by the shard cap, and the connection
 * has produced a frame recently. Anything less is fail-closed, because an
 * accepted order on an unsubscribed asset would reserve the user's cash while
 * no trade event can ever fill it.
 *
 * RESOLUTION ORDER
 * ----------------
 * 1. This process owns the provider route -> the local registry is the fast
 *    path AND the authority; it mirrors the socket directly.
 * 2. Otherwise, when shared readiness is enabled, the Redis view published by
 *    whichever instance DOES own the socket. Without this, a multi-instance
 *    deployment answers the same request differently depending on which pod
 *    received it: the owner accepts, every other pod rejects.
 * 3. Otherwise the legacy per-provider streaming status, so a deployment that
 *    runs neither a supervisor nor a registry-aware streaming service still
 *    fails closed rather than silently accepting.
 *
 * Every unresolved case is fail-closed. There is no fail-open branch.
 */
@Injectable()
export class LimitOrderProviderHealthService {
  private readonly config = readLimitOrderMatchingConfig();
  private readonly sharedConfig: ProviderTradeReadinessConfig;

  constructor(
    private readonly routes: ProviderTradeRouteRegistry,
    @Optional()
    private readonly publisher?: LimitOrderPriceEventPublisher,
    @Optional()
    private readonly kisStreaming?: KisWebSocketStreamingService,
    @Optional()
    private readonly binanceStreaming?: BinanceWebSocketStreamingService,
    @Optional()
    private readonly sharedReadiness?: ProviderTradeReadinessStore,
    // @Optional so Nest does not attempt to resolve a plain object type as a
    // provider; the default is what production actually uses.
    @Optional()
    sharedConfig: ProviderTradeReadinessConfig = readProviderTradeReadinessConfig(),
  ) {
    this.sharedConfig = sharedConfig;
  }

  /**
   * Synchronous LOCAL-ONLY check: this process's registry, or the legacy
   * streaming status when it owns no route. It never consults the shared view.
   *
   * Deliberately NOT used by the create path. On an instance that does not own
   * the provider socket it can only answer from an authority that structurally
   * does not know whether the asset is subscribed, which is what made
   * non-owner API pods reject creates the shared pre-check had accepted. Use
   * `assertAvailableAsync` + `assertReadinessProof` there. This entry point
   * remains the definition of the local verdict, and is what the owner-side
   * behaviour is pinned against.
   */
  assertAvailable(request: LimitOrderProviderAssetRequest): void {
    if (!this.config.enabled) return;
    this.assertPublisherActive();
    const provider = tradeRouteProviderForAssetType(request.assetType);
    const owner = this.routes.getOwner(provider);
    if (owner) {
      const readiness = this.localReadiness(request.assetId, provider);
      if (!readiness.ready) this.fail(readiness);
      return;
    }
    this.assertLegacyStreamingConnected(provider);
  }

  /**
   * Full check including the shared cross-instance readiness view, returning a
   * PROOF the create transaction re-verifies in memory.
   *
   * When shared readiness is enabled and this instance is NOT the owner, the
   * shared view is authoritative and its verdict is final — falling back to
   * the legacy streaming status afterwards would re-introduce exactly the
   * inconsistency the shared view exists to remove.
   */
  async assertAvailableAsync(
    request: LimitOrderProviderAssetRequest,
    now = Date.now(),
  ): Promise<LimitOrderProviderReadinessProof | null> {
    if (!this.config.enabled) return null;
    this.assertPublisherActive();

    const provider = tradeRouteProviderForAssetType(request.assetType);
    const owner = this.routes.getOwner(provider);

    // The canonical connection registry is authoritative when THIS process has
    // claimed the provider. It is the only place that knows WHICH assets are
    // subscribed on the live connection generation.
    if (owner) {
      const readiness = this.localReadiness(request.assetId, provider);
      if (!readiness.ready) this.fail(readiness);
      return this.proof(request.assetId, readiness, 'local', now);
    }

    if (this.sharedConfig.enabled) {
      if (!this.sharedReadiness?.isAvailable()) {
        this.unavailable(
          'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
          'Shared provider trade readiness is enabled but its Redis backend is not wired.',
        );
      }
      const readiness = await this.sharedReadiness.checkAssetReadiness({
        assetId: request.assetId,
        provider,
        livenessMaxAgeMs: this.config.providerLivenessMaxAgeMs,
      });
      if (!readiness.ready) this.fail(readiness);
      return this.proof(request.assetId, readiness, 'shared', now);
    }

    this.assertLegacyStreamingConnected(provider);
    return {
      provider,
      assetId: request.assetId,
      source: 'legacy_streaming',
      generation: 'legacy',
      ownerMode: 'legacy',
      checkedAt: now,
      expiresAt: now + this.config.providerReadinessProofMaxAgeMs,
    };
  }

  /**
   * In-transaction re-verification. Purely in memory: it is called while the
   * event-boundary advisory lock is held, so it must never perform a network
   * round trip.
   *
   * The rules, in order of authority:
   *
   *   1. The proof must cover THIS asset on THIS provider and must not have
   *      expired. An expired proof is not evidence of anything, so it is
   *      fail-closed like every other unresolved case.
   *   2. If this process owns the provider NOW, its registry is fresher than
   *      any proof and decides. A reconnect between the two checks therefore
   *      still rejects the create.
   *   3. If the proof was issued by this process as the owner but the route has
   *      since been released, the socket that backed the proof is gone —
   *      fail-closed.
   *   4. A 'legacy' proof re-checks the legacy streaming status, which is also
   *      in-process memory.
   *   5. Otherwise the proof came from the shared view and stands. This is the
   *      whole point: a non-owner API instance must NOT re-decide readiness
   *      from a local authority that structurally cannot know the answer.
   */
  assertReadinessProof(
    proof: LimitOrderProviderReadinessProof | null,
    request: LimitOrderProviderAssetRequest,
    now = Date.now(),
  ): void {
    if (!this.config.enabled) return;
    this.assertPublisherActive();

    const provider = tradeRouteProviderForAssetType(request.assetType);
    if (!proof) {
      this.unavailable(
        'LIMIT_ORDER_PROVIDER_READINESS_PROOF_INVALID',
        'No provider readiness proof was established for this order.',
      );
    }
    // Structural validation BEFORE any semantic decision: a proof whose shape
    // cannot be trusted (unknown ownerMode/source, inverted or absurd
    // timestamps) must not even reach the expiry comparison — an attacker- or
    // bug-shaped object with expiresAt=Infinity would otherwise pass it.
    if (
      !PROOF_OWNER_MODES.has(proof.ownerMode) ||
      !PROOF_SOURCES.has(proof.source) ||
      !Number.isFinite(proof.checkedAt) ||
      !Number.isFinite(proof.expiresAt) ||
      proof.checkedAt > proof.expiresAt ||
      proof.expiresAt - proof.checkedAt >
        this.config.providerReadinessProofMaxAgeMs ||
      // A checkedAt in the future means the two readings cannot be ordered
      // (clock jump, serialized proof from another host). Not evidence.
      proof.checkedAt > now + PROOF_FUTURE_SKEW_TOLERANCE_MS ||
      typeof proof.generation !== 'string' ||
      proof.generation.length === 0
    ) {
      this.unavailable(
        'LIMIT_ORDER_PROVIDER_READINESS_PROOF_INVALID',
        'The provider readiness proof is structurally invalid.',
      );
    }
    if (proof.provider !== provider || proof.assetId !== request.assetId) {
      this.unavailable(
        'LIMIT_ORDER_PROVIDER_READINESS_PROOF_INVALID',
        'The provider readiness proof does not cover the ordered asset.',
      );
    }
    if (now > proof.expiresAt) {
      this.unavailable(
        'LIMIT_ORDER_PROVIDER_READINESS_PROOF_EXPIRED',
        `The provider readiness proof expired ${now - proof.expiresAt}ms ago.`,
      );
    }

    const owner = this.routes.getOwner(provider);
    if (owner) {
      const readiness = this.localReadiness(request.assetId, provider);
      if (!readiness.ready) this.fail(readiness);
      // The local registry is fresher than any proof: when THIS process owns
      // the socket, a generation that moved since the proof was issued means
      // the subscription evidence the proof was based on no longer exists.
      if (
        proof.ownerMode === 'local' &&
        readiness.generation !== proof.generation
      ) {
        this.unavailable(
          'LIMIT_ORDER_PROVIDER_GENERATION_CHANGED',
          `The ${provider} connection generation changed after the readiness check.`,
        );
      }
      return;
    }
    if (proof.ownerMode === 'local') {
      this.unavailable(
        'LIMIT_ORDER_PROVIDER_GENERATION_CHANGED',
        `This instance released the ${provider} trade route after the readiness check.`,
      );
    }
    if (proof.ownerMode === 'legacy') {
      this.assertLegacyStreamingConnected(provider);
    }
  }

  private proof(
    assetId: string,
    readiness: Extract<AssetTradeReadiness, { ready: true }>,
    ownerMode: LimitOrderProviderReadinessOwnerMode,
    now: number,
  ): LimitOrderProviderReadinessProof {
    return {
      provider: readiness.provider,
      assetId,
      source: readiness.source,
      generation: readiness.generation,
      ownerMode,
      checkedAt: now,
      expiresAt: now + this.config.providerReadinessProofMaxAgeMs,
    };
  }

  private localReadiness(
    assetId: string,
    provider: ReturnType<typeof tradeRouteProviderForAssetType>,
  ): AssetTradeReadiness {
    return this.routes.checkAssetReadiness({
      assetId,
      provider,
      livenessMaxAgeMs: this.config.providerLivenessMaxAgeMs,
    });
  }

  private assertPublisherActive(): void {
    if (!this.publisher?.isActive()) {
      this.unavailable(
        'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
        'The normalized trade publisher is not active.',
      );
    }
  }

  private assertLegacyStreamingConnected(
    provider: ReturnType<typeof tradeRouteProviderForAssetType>,
  ): void {
    const status =
      provider === 'binance'
        ? this.binanceStreaming?.getStatus()
        : this.kisStreaming?.getStatus();
    if (!status?.enabled || !status.running || !status.connected) {
      this.unavailable(
        'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
        provider === 'binance'
          ? 'The Binance live-trade stream is not connected.'
          : 'The KIS live-trade stream is not connected.',
      );
    }
  }

  private fail(
    readiness: Extract<AssetTradeReadiness, { ready: false }>,
  ): never {
    this.unavailable(readiness.code, readiness.reason);
  }

  private unavailable(code: string, message: string): never {
    throw new HttpException(
      {
        success: false,
        error: {
          code,
          message,
        },
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
