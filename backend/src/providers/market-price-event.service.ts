import { Injectable } from '@nestjs/common';
import { BinanceRealtimePriceEventBus } from './binance/binance-realtime-price-event-bus.service';
import { KisRealtimePriceEventBus } from './kis/kis-realtime-price-event-bus.service';

/** App-facing realtime price. Provider symbols, stream IDs and raw fields stop here. */
export type MarketPriceEvent = {
  type: 'market_price';
  assetId: string;
  price: {
    price: string;
    currencyCode: 'KRW' | 'USD';
    sourceName: string;
    effectiveAt: string;
    capturedAt: string;
  };
  delayed: boolean;
  snapshotState: string | null;
  snapshotReason?: string;
  /** Presence means the feed supplied a top of book; absence means unknown. */
  topOfBook?: { bidPrice: string; askPrice: string };
};

type ProviderPriceMessage = {
  type: 'kis_realtime_price' | 'binance_realtime_price';
  assetId: string | null;
  price: {
    price: string;
    currencyCode: 'KRW' | 'USD';
    sourceName: string;
    effectiveAt: string;
    capturedAt: string;
    kind?: string;
    bidPrice?: string | null;
    askPrice?: string | null;
  };
  snapshotState: string | null;
  snapshotReason?: string;
};

/** Used at the provider bus and Redis receive boundary, including old wire messages. */
export function normalizeMarketPriceEvent(
  value: unknown,
): MarketPriceEvent | null {
  if (!isRecord(value)) return null;
  if (value.type === 'market_price') return parseCanonicalEvent(value);
  if (
    value.type !== 'kis_realtime_price' &&
    value.type !== 'binance_realtime_price'
  )
    return null;
  if (!isRecord(value.price)) return null;
  const price = value.price;
  if (
    typeof value.assetId !== 'string' ||
    !value.assetId ||
    !isPositiveDecimal(price.price) ||
    (price.currencyCode !== 'KRW' && price.currencyCode !== 'USD') ||
    typeof price.sourceName !== 'string' ||
    !price.sourceName ||
    !isTime(price.effectiveAt) ||
    !isTime(price.capturedAt) ||
    (value.snapshotState !== null && typeof value.snapshotState !== 'string') ||
    (value.snapshotReason !== undefined &&
      typeof value.snapshotReason !== 'string')
  )
    return null;
  const message = value as unknown as ProviderPriceMessage;
  const bid = price.bidPrice;
  const ask = price.askPrice;
  return {
    type: 'market_price',
    assetId: message.assetId as string,
    price: {
      price: message.price.price,
      currencyCode: message.price.currencyCode,
      sourceName: message.price.sourceName,
      effectiveAt: message.price.effectiveAt,
      capturedAt: message.price.capturedAt,
    },
    delayed:
      message.type === 'kis_realtime_price' &&
      (message.price.kind === 'us_delayed_trade' ||
        message.price.sourceName === 'kis_us_delayed_trade'),
    snapshotState: message.snapshotState,
    ...(message.snapshotReason
      ? { snapshotReason: message.snapshotReason }
      : {}),
    ...(isPositiveDecimal(bid) && isPositiveDecimal(ask)
      ? { topOfBook: { bidPrice: bid, askPrice: ask } }
      : {}),
  };
}

function parseCanonicalEvent(
  value: Record<string, unknown>,
): MarketPriceEvent | null {
  if (!isRecord(value.price)) return null;
  const price = value.price;
  if (
    typeof value.assetId !== 'string' ||
    !value.assetId ||
    !isPositiveDecimal(price.price) ||
    (price.currencyCode !== 'KRW' && price.currencyCode !== 'USD') ||
    typeof price.sourceName !== 'string' ||
    !price.sourceName ||
    !isTime(price.effectiveAt) ||
    !isTime(price.capturedAt) ||
    typeof value.delayed !== 'boolean' ||
    (value.snapshotState !== null && typeof value.snapshotState !== 'string') ||
    (value.snapshotReason !== undefined &&
      typeof value.snapshotReason !== 'string')
  )
    return null;
  const top = value.topOfBook;
  if (
    top !== undefined &&
    (!isRecord(top) ||
      !isPositiveDecimal(top.bidPrice) ||
      !isPositiveDecimal(top.askPrice))
  )
    return null;
  return {
    type: 'market_price',
    assetId: value.assetId,
    price: {
      price: price.price,
      currencyCode: price.currencyCode,
      sourceName: price.sourceName,
      effectiveAt: price.effectiveAt,
      capturedAt: price.capturedAt,
    },
    delayed: value.delayed,
    snapshotState: value.snapshotState,
    ...(value.snapshotReason ? { snapshotReason: value.snapshotReason } : {}),
    ...(top
      ? { topOfBook: { bidPrice: top.bidPrice, askPrice: top.askPrice } }
      : {}),
  } as MarketPriceEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveDecimal(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) &&
    /[1-9]/u.test(value)
  );
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Provider-specific bus wiring lives in ProvidersModule, never in the gateway. */
@Injectable()
export class MarketPriceEventService {
  constructor(
    private readonly kis: KisRealtimePriceEventBus,
    private readonly binance: BinanceRealtimePriceEventBus,
  ) {}

  subscribe(
    listener: (event: MarketPriceEvent) => void | Promise<void>,
  ): () => void {
    const forward = (raw: unknown) => {
      const event = normalizeMarketPriceEvent(raw);
      if (event) return listener(event);
    };
    const unsubscribeKis = this.kis.subscribe(forward);
    const unsubscribeBinance = this.binance.subscribe(forward);
    return () => {
      unsubscribeKis();
      unsubscribeBinance();
    };
  }
}
