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
  it('rejects timestamps that are obviously broken without a skew tolerance', () => {
    const now = new Date('2026-07-22T01:00:00.000Z');
    const event = buildLimitOrderPriceEvent({
      tick,
      asset,
      publishedAt: new Date('2026-07-22T01:00:00.020Z'),
    });
    // A sane event is accepted even though receivedAt is 10ms in the future
    // relative to `now`: the bound is an absolute sanity limit, not an
    // eligibility rule.
    expect(parseLimitOrderPriceEvent(JSON.stringify(event), now)).toEqual(
      event,
    );
    for (const invalid of [
      { ...event, providerEventAt: '2026-07-22T02:00:00.000Z' },
      { ...event, receivedAt: '2026-07-22T02:00:00.000Z' },
      { ...event, publishedAt: '2026-07-22T02:00:00.000Z' },
      // publishedAt is stamped after receivedAt on ONE process clock, so an
      // inversion is a corrupted payload.
      {
        ...event,
        receivedAt: '2026-07-22T01:00:00.500Z',
        publishedAt: '2026-07-22T01:00:00.100Z',
      },
    ]) {
      expect(() =>
        parseLimitOrderPriceEvent(JSON.stringify(invalid), now),
      ).toThrow('Invalid');
    }
  });

  it('decides activation from stream ids alone, never from timestamps', () => {
    // The order activated at stream id 100-0. An event at 100-1 is after it
    // regardless of what the two hosts' clocks say.
    const activation = '100-0';
    expect(compareRedisStreamIds(activation, '100-1') < 0).toBe(true);
    expect(compareRedisStreamIds(activation, '100-0') < 0).toBe(false);
    expect(compareRedisStreamIds(activation, '99-9999') < 0).toBe(false);
  });

  it.each([
    // DB clock ahead of the app clock: submittedAt > receivedAt, yet the
    // event is after activation and MUST still be eligible.
    ['db_clock_ahead', '2026-07-22T01:00:05.000Z', '2026-07-22T01:00:00.000Z'],
    // App clock ahead of the DB clock: the reverse skew.
    ['app_clock_ahead', '2026-07-22T01:00:00.000Z', '2026-07-22T01:00:05.000Z'],
  ])(
    'stream-id ordering survives %s clock skew',
    (_case, submittedAt, receivedAt) => {
      const order = {
        submittedAt: new Date(submittedAt),
        matchingActivationStreamId: '100-0',
      };
      const event = { receivedAt: new Date(receivedAt), streamId: '100-1' };
      // The removed rule would have dropped the db_clock_ahead case.
      const legacyTimestampRule = order.submittedAt <= event.receivedAt;
      const streamIdRule =
        compareRedisStreamIds(
          order.matchingActivationStreamId,
          event.streamId,
        ) < 0;
      expect(streamIdRule).toBe(true);
      if (_case === 'db_clock_ahead') expect(legacyTimestampRule).toBe(false);
    },
  );

  it('never activates an order from a stream id at or before its cursor', () => {
    for (const streamId of ['100-0', '99-1', '1-0']) {
      expect(compareRedisStreamIds('100-0', streamId) < 0).toBe(false);
    }
  });

  it('validates the added health-gate environment values', () => {
    const config = readLimitOrderMatchingConfig({
      LIMIT_ORDER_MATCHER_MAX_LAG: '250',
      LIMIT_ORDER_MATCHER_MAX_PENDING: '25',
      LIMIT_ORDER_MATCHER_MAX_ACK_AGE_MS: '45000',
      LIMIT_ORDER_MATCHER_MAX_OLDEST_PENDING_AGE_MS: '45000',
      LIMIT_ORDER_EVENT_RETENTION_HEADROOM_RATIO: '0.35',
      LIMIT_ORDER_PROVIDER_LIVENESS_MAX_AGE_MS: '90000',
    } as NodeJS.ProcessEnv);
    expect(config.maxConsumerLag).toBe(250);
    expect(config.maxPendingCount).toBe(25);
    expect(config.maxAckAgeMs).toBe(45_000);
    expect(config.maxOldestPendingAgeMs).toBe(45_000);
    expect(config.eventRetentionHeadroomRatio).toBeCloseTo(0.35);
    expect(config.providerLivenessMaxAgeMs).toBe(90_000);

    for (const env of [
      { LIMIT_ORDER_EVENT_RETENTION_HEADROOM_RATIO: '1' },
      { LIMIT_ORDER_EVENT_RETENTION_HEADROOM_RATIO: '-0.1' },
      { LIMIT_ORDER_EVENT_RETENTION_HEADROOM_RATIO: 'high' },
      { LIMIT_ORDER_MATCHER_MAX_ACK_AGE_MS: '1000' },
    ]) {
      expect(() =>
        readLimitOrderMatchingConfig(env as NodeJS.ProcessEnv),
      ).toThrow();
    }
  });
});
