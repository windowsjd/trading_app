import { createHash } from 'node:crypto';
import { AssetType, CurrencyCode, Prisma } from '../../generated/prisma/client';
import type { NormalizedProviderTradeTick } from '../../providers/normalized-provider-trade-event-bus.service';

export const LIMIT_ORDER_PRICE_EVENT_SCHEMA_VERSION = 1 as const;

export type LimitOrderPriceEvent = {
  schemaVersion: 1;
  eventId: string;
  eventType: 'trade';
  provider: 'kis' | 'binance';
  assetId: string;
  symbol: string;
  market: string;
  assetType: AssetType;
  currencyCode: CurrencyCode;
  price: string;
  providerEventAt: string;
  receivedAt: string;
  publishedAt: string;
  providerConnectionId: string | null;
  providerSequence: string | null;
  sourceName: string;
  marketSessionCode: string | null;
};

export function buildLimitOrderPriceEvent(input: {
  tick: NormalizedProviderTradeTick;
  asset: {
    id: string;
    symbol: string;
    market: string;
    assetType: AssetType;
    settlementCurrency: CurrencyCode;
  };
  publishedAt?: Date;
}): LimitOrderPriceEvent {
  if (input.tick.assetId !== input.asset.id) {
    throw new Error('Normalized trade asset does not match resolved asset.');
  }
  if (input.tick.currencyCode !== input.asset.settlementCurrency) {
    throw new Error(
      'Normalized trade currency does not match asset settlement currency.',
    );
  }
  const price = new Prisma.Decimal(input.tick.price);
  if (!price.isFinite() || price.lte(0)) {
    throw new Error('Normalized trade price must be positive.');
  }
  const providerEventAt = requireIso(
    input.tick.providerEventAt,
    'providerEventAt',
  );
  const receivedAt = requireIso(input.tick.receivedAt, 'receivedAt');
  const publishedAt = (input.publishedAt ?? new Date()).toISOString();
  const normalizedPrice = price.toFixed(8);
  const eventId = input.tick.providerEventId
    ? `${input.tick.provider}:${input.asset.id}:${input.tick.providerEventId}`
    : `${input.tick.provider}:${input.asset.id}:${createHash('sha256')
        .update(
          JSON.stringify([
            LIMIT_ORDER_PRICE_EVENT_SCHEMA_VERSION,
            input.tick.provider,
            input.asset.id,
            providerEventAt,
            normalizedPrice,
            input.tick.providerSequence,
            input.tick.providerConnectionId,
          ]),
        )
        .digest('hex')}`;

  return {
    schemaVersion: LIMIT_ORDER_PRICE_EVENT_SCHEMA_VERSION,
    eventId,
    eventType: 'trade',
    provider: input.tick.provider,
    assetId: input.asset.id,
    symbol: input.asset.symbol,
    market: input.asset.market,
    assetType: input.asset.assetType,
    currencyCode: input.asset.settlementCurrency,
    price: normalizedPrice,
    providerEventAt,
    receivedAt,
    publishedAt,
    providerConnectionId: input.tick.providerConnectionId,
    providerSequence: input.tick.providerSequence,
    sourceName: input.tick.sourceName,
    marketSessionCode: input.tick.marketSessionCode,
  };
}

function requireIso(value: string, name: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error(`${name} must be an ISO-8601 timestamp.`);
  }
  return date.toISOString();
}
