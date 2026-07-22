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
   * Synchronous local-only check, kept for callers already inside a
   * non-awaitable path. Prefer `assertAvailableAsync`, which also consults the
   * shared cross-instance view.
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
   * Full check including the shared cross-instance readiness view.
   *
   * When shared readiness is enabled and this instance is NOT the owner, the
   * shared view is authoritative and its verdict is final — falling back to
   * the legacy streaming status afterwards would re-introduce exactly the
   * inconsistency the shared view exists to remove.
   */
  async assertAvailableAsync(
    request: LimitOrderProviderAssetRequest,
  ): Promise<void> {
    if (!this.config.enabled) return;
    this.assertPublisherActive();

    const provider = tradeRouteProviderForAssetType(request.assetType);
    const owner = this.routes.getOwner(provider);

    // The canonical connection registry is authoritative when THIS process has
    // claimed the provider. It is the only place that knows WHICH assets are
    // subscribed on the live connection generation.
    if (owner) {
      const readiness = this.localReadiness(request.assetId, provider);
      if (!readiness.ready) this.fail(readiness);
      return;
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
      return;
    }

    this.assertLegacyStreamingConnected(provider);
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
