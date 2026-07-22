jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    Prisma: { Decimal },
  };
});

import { AssetType, CurrencyCode, Prisma } from '../../generated/prisma/client';
import type { NormalizedProviderTradeTick } from '../../providers/normalized-provider-trade-event-bus.service';
import { compareRedisStreamIds } from './limit-order-event-stream.service';
import { parseLimitOrderPriceEvent } from './limit-order-event-validator';
import { calculateLimitOrderExecutionAmounts } from './limit-order-execution.policy';
import { readLimitOrderMatchingConfig } from './limit-order-matching.config';
import { buildLimitOrderPriceEvent } from './limit-order-price-event.types';

const tick: NormalizedProviderTradeTick = {
  provider: 'kis',
  providerEventId: 'trade-42',
  providerSequence: '42',
  providerConnectionId: null,
  assetId: 'asset-1',
  symbol: '005930',
  providerSymbol: '005930',
  price: '90',
  currencyCode: CurrencyCode.KRW,
  providerEventAt: '2026-07-22T01:00:00.000Z',
  receivedAt: '2026-07-22T01:00:00.010Z',
  sourceName: 'kis_krx_realtime_trade',
  marketSessionCode: 'regular',
  eventType: 'trade',
};
const asset = {
  id: 'asset-1',
  symbol: '005930',
  market: 'KRX',
  assetType: AssetType.domestic_stock,
  settlementCurrency: CurrencyCode.KRW,
};

describe('limit order live-trade matching policies', () => {
  it('builds a stable, secret-free event id from the provider trade id', () => {
    const first = buildLimitOrderPriceEvent({ tick, asset });
    const second = buildLimitOrderPriceEvent({
      tick,
      asset,
      publishedAt: new Date('2026-07-22T01:00:10.000Z'),
    });
    expect(first.eventId).toBe('kis:asset-1:trade-42');
    expect(second.eventId).toBe(first.eventId);
    expect(JSON.stringify(first)).not.toContain('rawPayload');
    expect(JSON.stringify(first)).not.toContain('authorization');
  });

  it('uses a deterministic hash when the provider has no trade id', () => {
    const withoutProviderId = {
      ...tick,
      providerEventId: null,
      providerSequence: 'absolute-volume-7',
      providerConnectionId: 'generation-3',
    };
    const first = buildLimitOrderPriceEvent({
      tick: withoutProviderId,
      asset,
      publishedAt: new Date('2026-07-22T01:00:01.000Z'),
    });
    const duplicate = buildLimitOrderPriceEvent({
      tick: withoutProviderId,
      asset,
      publishedAt: new Date('2026-07-22T01:01:00.000Z'),
    });
    const nextGeneration = buildLimitOrderPriceEvent({
      tick: {
        ...withoutProviderId,
        providerConnectionId: 'generation-4',
      },
      asset,
    });

    expect(first.eventId).toBe(duplicate.eventId);
    expect(first.eventId).toMatch(/^kis:asset-1:[a-f0-9]{64}$/u);
    expect(nextGeneration.eventId).not.toBe(first.eventId);
  });

  it('validates trade schema and rejects zero, negative, malformed, or non-trade prices', () => {
    const event = buildLimitOrderPriceEvent({ tick, asset });
    expect(parseLimitOrderPriceEvent(JSON.stringify(event))).toEqual(event);
    for (const invalid of [
      { ...event, price: '0' },
      { ...event, price: '-1' },
      { ...event, price: 'not-decimal' },
      { ...event, price: '90' },
      { ...event, eventType: 'candle' },
      { ...event, assetId: '' },
      { ...event, eventId: 'binance:asset-1:trade-42' },
      { ...event, receivedAt: '2026-07-22 01:00:00Z' },
    ]) {
      expect(() => parseLimitOrderPriceEvent(JSON.stringify(invalid))).toThrow(
        'Invalid',
      );
    }
  });

  it('uses event price and the pinned reservation fee rate with price improvement', () => {
    const amounts = calculateLimitOrderExecutionAmounts({
      eventPrice: new Prisma.Decimal('90'),
      quantity: new Prisma.Decimal('2'),
      reservationFeeRate: new Prisma.Decimal('0.001'),
      reservedAmount: new Prisma.Decimal('200.2'),
    });
    expect(amounts.grossAmount.toFixed(8)).toBe('180.00000000');
    expect(amounts.feeAmount.toFixed(8)).toBe('0.18000000');
    expect(amounts.actualDebit.toFixed(8)).toBe('180.18000000');
    expect(amounts.reservationRelease.toFixed(8)).toBe('200.20000000');
    expect(amounts.priceImprovementAmount.toFixed(8)).toBe('20.02000000');
  });

  it('allows exact reservation and rejects an actual debit above it', () => {
    expect(
      calculateLimitOrderExecutionAmounts({
        eventPrice: new Prisma.Decimal('100'),
        quantity: new Prisma.Decimal('1'),
        reservationFeeRate: new Prisma.Decimal('0'),
        reservedAmount: new Prisma.Decimal('100'),
      }).actualDebit.toFixed(8),
    ).toBe('100.00000000');
    expect(() =>
      calculateLimitOrderExecutionAmounts({
        eventPrice: new Prisma.Decimal('101'),
        quantity: new Prisma.Decimal('1'),
        reservationFeeRate: new Prisma.Decimal('0'),
        reservedAmount: new Prisma.Decimal('100'),
      }),
    ).toThrow('LIMIT_ORDER_EXECUTION_RESERVATION_INSUFFICIENT');
  });

  it('orders Redis stream ids without JavaScript number precision loss', () => {
    expect(compareRedisStreamIds('9999999999999-1', '9999999999999-2')).toBe(
      -1,
    );
    expect(compareRedisStreamIds('10000000000000-0', '9999999999999-999')).toBe(
      1,
    );
    expect(compareRedisStreamIds('1-1', '1-1')).toBe(0);
  });

  it('strictly validates every matcher environment value', () => {
    expect(readLimitOrderMatchingConfig({} as NodeJS.ProcessEnv).enabled).toBe(
      false,
    );
    expect(
      readLimitOrderMatchingConfig({
        LIMIT_ORDER_AUTO_EXECUTION_ENABLED: ' TRUE ',
      } as NodeJS.ProcessEnv).enabled,
    ).toBe(true);
    for (const env of [
      { LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'yes' },
      { LIMIT_ORDER_EVENT_BLOCK_MS: '0' },
      { LIMIT_ORDER_EVENT_READ_BATCH_SIZE: '-1' },
      { LIMIT_ORDER_EVENT_MAXLEN: '999999999999' },
      {
        LIMIT_ORDER_MATCHER_HEARTBEAT_INTERVAL_MS: '5000',
        LIMIT_ORDER_MATCHER_HEALTH_MAX_AGE_MS: '5000',
      },
    ]) {
      expect(() =>
        readLimitOrderMatchingConfig(env as NodeJS.ProcessEnv),
      ).toThrow();
    }
  });
});
