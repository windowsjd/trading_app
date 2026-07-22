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
 */
@Injectable()
export class LimitOrderProviderHealthService {
  private readonly config = readLimitOrderMatchingConfig();

  constructor(
    private readonly routes: ProviderTradeRouteRegistry,
    @Optional()
    private readonly publisher?: LimitOrderPriceEventPublisher,
    @Optional()
    private readonly kisStreaming?: KisWebSocketStreamingService,
    @Optional()
    private readonly binanceStreaming?: BinanceWebSocketStreamingService,
  ) {}

  assertAvailable(request: LimitOrderProviderAssetRequest): void {
    if (!this.config.enabled) return;
    if (!this.publisher?.isActive()) {
      this.unavailable(
        'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
        'The normalized trade publisher is not active.',
      );
    }

    const provider = tradeRouteProviderForAssetType(request.assetType);
    const owner = this.routes.getOwner(provider);

    // The canonical connection registry is authoritative when a source has
    // claimed the provider. It is the only place that knows WHICH assets are
    // subscribed on the live connection generation.
    if (owner) {
      const readiness = this.routes.checkAssetReadiness({
        assetId: request.assetId,
        provider,
        livenessMaxAgeMs: this.config.providerLivenessMaxAgeMs,
      });
      if (!readiness.ready) this.fail(readiness);
      return;
    }

    // No claimed route: fall back to the legacy streaming status so a
    // deployment that runs neither supervisor nor registry-aware streaming
    // still fails closed instead of silently accepting orders.
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
