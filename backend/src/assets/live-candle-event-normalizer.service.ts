import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AssetType, Prisma } from '../generated/prisma/client';
import type { BinanceFiveMinuteKline } from '../providers/binance/binance-kline.parser';
import type { KisWebSocketTradeTick } from '../providers/kis/kis-websocket.types';
import { resolveRegularSessionForEvent } from '../orders/market-calendar.policy';
import {
  LIVE_CANDLE_CONFIG,
  type LiveCandleConfig,
} from './live-candle.config';
import type { NormalizedLiveCandleEvent } from './live-candle.types';

export type LiveCandleAsset = {
  id: string;
  symbol: string;
  assetType: AssetType;
  market: string;
  isActive: boolean;
};

export class LiveCandleEventValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LiveCandleEventValidationError';
  }
}

@Injectable()
export class LiveCandleEventNormalizerService {
  constructor(
    @Inject(LIVE_CANDLE_CONFIG) private readonly config: LiveCandleConfig,
  ) {}

  normalizeBinance(
    kline: BinanceFiveMinuteKline,
    asset: LiveCandleAsset,
    receivedAt = new Date(),
  ): NormalizedLiveCandleEvent {
    this.assertAsset(asset, AssetType.crypto);
    if (asset.market.trim().toUpperCase() !== 'BINANCE') {
      throw new LiveCandleEventValidationError(
        'INVALID_ASSET_MAPPING',
        'Binance kline mapped to a non-Binance asset.',
      );
    }
    this.assertTimestamps(kline.eventTime, receivedAt);
    return {
      provider: 'binance',
      source: 'binance_spot_ws_5m_kline',
      assetId: asset.id,
      assetType: asset.assetType,
      market: asset.market,
      symbol: asset.symbol,
      eventTime: kline.eventTime,
      receivedAt,
      price: this.positive(kline.close, 'price'),
      tradeQuantity: null,
      amount: null,
      eventId: kline.eventId,
      sequence: kline.sequence,
      marketSession: 'continuous',
      delayed: false,
      openTime: kline.openTime,
      closeTime: kline.closeTime,
      mode: 'absolute',
      absolute: {
        open: this.positive(kline.open, 'open'),
        high: this.positive(kline.high, 'high'),
        low: this.positive(kline.low, 'low'),
        close: this.positive(kline.close, 'close'),
        volume: this.nonNegative(kline.volume, 'volume'),
        amount: this.nonNegative(kline.quoteVolume, 'quoteVolume'),
        providerFinal: kline.final,
      },
    };
  }

  normalizeKis(
    trade: KisWebSocketTradeTick,
    asset: LiveCandleAsset,
  ): NormalizedLiveCandleEvent {
    const expectedType =
      trade.kind === 'domestic_krx_realtime_trade'
        ? AssetType.domestic_stock
        : AssetType.us_stock;
    this.assertAsset(asset, expectedType);
    const eventTime = trade.exchangeTimestamp ?? trade.sourceTimestamp;
    if (!eventTime) {
      throw new LiveCandleEventValidationError(
        'INVALID_EVENT_TIME',
        'KIS trade has no valid provider event timestamp.',
      );
    }
    this.assertTimestamps(eventTime, trade.receivedAt);
    const session = resolveRegularSessionForEvent(asset, eventTime);
    if (!session) {
      throw new LiveCandleEventValidationError(
        'OUTSIDE_REGULAR_SESSION',
        'KIS trade is outside the configured regular session.',
      );
    }
    const bucketOffset = eventTime.getTime() - session.openTime.getTime();
    const openTime = new Date(
      session.openTime.getTime() + Math.floor(bucketOffset / 300_000) * 300_000,
    );
    const closeTime = new Date(
      Math.min(openTime.getTime() + 300_000, session.closeTime.getTime()),
    );
    const price = this.positive(trade.price, 'price');
    const quantity = this.optionalNonNegative(
      trade.tradeQuantity,
      'tradeQuantity',
    );
    const identity =
      trade.eventId ??
      [
        trade.trId,
        trade.providerSymbol,
        eventTime.toISOString(),
        price,
        quantity ?? '',
      ].join(':');
    return {
      provider: 'kis',
      source:
        trade.kind === 'domestic_krx_realtime_trade'
          ? 'kis_krx_realtime_trade'
          : 'kis_us_delayed_trade',
      assetId: asset.id,
      assetType: asset.assetType,
      market: asset.market,
      symbol: asset.symbol,
      eventTime,
      receivedAt: trade.receivedAt,
      price,
      tradeQuantity: quantity,
      // ACML_TR_PBMN/TAMT are session cumulative fields, not a bucket delta.
      // They are intentionally not converted into candle amount here.
      amount: null,
      eventId: `kis:${hash(identity)}`,
      sequence: trade.sequence,
      marketSession: 'regular',
      delayed: trade.kind === 'us_delayed_trade',
      openTime,
      closeTime,
      mode: 'delta',
      absolute: null,
    };
  }

  private assertAsset(asset: LiveCandleAsset, expected: AssetType): void {
    if (!asset.isActive || asset.assetType !== expected || !asset.id.trim()) {
      throw new LiveCandleEventValidationError(
        'INVALID_ASSET_MAPPING',
        'Provider event does not map to an active compatible asset.',
      );
    }
  }

  private assertTimestamps(eventTime: Date, receivedAt: Date): void {
    if (
      Number.isNaN(eventTime.getTime()) ||
      Number.isNaN(receivedAt.getTime())
    ) {
      throw new LiveCandleEventValidationError(
        'INVALID_EVENT_TIME',
        'Provider event timestamp is invalid.',
      );
    }
    if (
      eventTime.getTime() >
      receivedAt.getTime() + this.config.maxFutureEventSkewMs
    ) {
      throw new LiveCandleEventValidationError(
        'FUTURE_EVENT',
        'Provider event timestamp is too far in the future.',
      );
    }
  }

  private positive(value: string, field: string): string {
    const decimal = this.decimal(value, field);
    if (decimal.lte(0)) {
      throw new LiveCandleEventValidationError(
        'INVALID_DECIMAL',
        `${field} must be positive.`,
      );
    }
    return decimal.toFixed(8);
  }

  private nonNegative(value: string, field: string): string {
    const decimal = this.decimal(value, field);
    if (decimal.lt(0)) {
      throw new LiveCandleEventValidationError(
        'INVALID_DECIMAL',
        `${field} must be non-negative.`,
      );
    }
    return decimal.toFixed(8);
  }

  private optionalNonNegative(
    value: string | null,
    field: string,
  ): string | null {
    return value === null ? null : this.nonNegative(value, field);
  }

  private decimal(value: string, field: string): Prisma.Decimal {
    try {
      const decimal = new Prisma.Decimal(value);
      if (!decimal.isFinite()) throw new Error();
      return decimal;
    } catch {
      throw new LiveCandleEventValidationError(
        'INVALID_DECIMAL',
        `${field} must be a decimal.`,
      );
    }
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
