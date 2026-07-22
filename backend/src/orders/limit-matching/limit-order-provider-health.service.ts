import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import { AssetType } from '../../generated/prisma/client';
import { BinanceWebSocketStreamingService } from '../../providers/binance/binance-websocket-streaming.service';
import { KisWebSocketStreamingService } from '../../providers/kis/kis-websocket-streaming.service';
import { readLimitOrderMatchingConfig } from './limit-order-matching.config';
import { LimitOrderPriceEventPublisher } from './limit-order-price-event.publisher';

@Injectable()
export class LimitOrderProviderHealthService {
  private readonly config = readLimitOrderMatchingConfig();

  constructor(
    @Optional()
    private readonly publisher?: LimitOrderPriceEventPublisher,
    @Optional()
    private readonly kisStreaming?: KisWebSocketStreamingService,
    @Optional()
    private readonly binanceStreaming?: BinanceWebSocketStreamingService,
  ) {}

  assertAvailable(assetType: AssetType): void {
    if (!this.config.enabled) return;
    if (!this.publisher?.isActive()) {
      this.unavailable('The normalized trade publisher is not active.');
    }

    const status =
      assetType === AssetType.crypto
        ? this.binanceStreaming?.getStatus()
        : this.kisStreaming?.getStatus();
    if (!status?.enabled || !status.running || !status.connected) {
      this.unavailable(
        assetType === AssetType.crypto
          ? 'The Binance live-trade stream is not connected.'
          : 'The KIS live-trade stream is not connected.',
      );
    }
  }

  private unavailable(message: string): never {
    throw new HttpException(
      {
        success: false,
        error: {
          code: 'LIMIT_ORDER_MATCHER_UNAVAILABLE',
          message,
        },
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
