jest.mock('../generated/prisma/client', () => {
  const { Decimal, sqltag } = jest.requireActual(
    '@prisma/client/runtime/client',
  );

  return {
    AssetPriceSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    OrderSide: {
      buy: 'buy',
      sell: 'sell',
    },
    OrderStatus: {
      submitted: 'submitted',
      executed: 'executed',
      canceled: 'canceled',
      rejected: 'rejected',
    },
    OrderType: {
      market: 'market',
      limit: 'limit',
    },
    QuoteStatus: {
      active: 'active',
      consumed: 'consumed',
      expired: 'expired',
      canceled: 'canceled',
    },
    QuoteType: {
      fx: 'fx',
      order: 'order',
    },
    SeasonRankingType: {
      daily: 'daily',
      final: 'final',
    },
    SnapshotReason: {
      season_join: 'season_join',
      exchange_executed: 'exchange_executed',
      order_executed: 'order_executed',
      scheduled: 'scheduled',
      settlement: 'settlement',
    },
    ParticipantStatus: {
      registered: 'registered',
      active: 'active',
      finished: 'finished',
      rewarded: 'rewarded',
      excluded: 'excluded',
    },
    Prisma: {
      Decimal,
      sql: sqltag,
    },
    PrismaClient: class PrismaClient {},
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
    TradingAccountMode: {
      general: 'general',
      season: 'season',
    },
    TradingAccountStatus: {
      active: 'active',
      suspended: 'suspended',
      closed: 'closed',
    },
    WalletTransactionDirection: {
      credit: 'credit',
      debit: 'debit',
    },
    WalletTransactionReferenceType: {
      season_join: 'season_join',
      exchange_transaction: 'exchange_transaction',
      order: 'order',
      manual_adjustment: 'manual_adjustment',
      settlement: 'settlement',
    },
    WalletTransactionType: {
      initial_grant: 'initial_grant',
      exchange_source: 'exchange_source',
      exchange_target: 'exchange_target',
      order_buy: 'order_buy',
      order_sell: 'order_sell',
      fee: 'fee',
      adjustment: 'adjustment',
      settlement: 'settlement',
    },
  };
});

import { HttpException } from '@nestjs/common';
import {
  AssetType,
  OrderSide,
  OrderType,
  Prisma,
} from '../generated/prisma/client';
import {
  assertOrderInputPolicy,
  quantityFromBuyAmount,
} from './order-input-policy';
import { computeOrderQuoteRequestHash } from '../providers/durable-quote.policy';
import { assertOrderSessionAllowed } from './market-hours.policy';
import {
  markMarketSessionOverrideStoreRequired,
  resetMarketSessionOverrideStoreForTest,
} from './market-calendar/market-session-override.store';

const d = (v: string) => new Prisma.Decimal(v);
const code = (run: () => void) => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof HttpException
      ? (error.getResponse() as { error: { code: string } }).error.code
      : (error as { code: string }).code;
  }
};
afterEach(resetMarketSessionOverrideStoreForTest);
for (const assetType of [AssetType.domestic_stock, AssetType.us_stock]) {
  for (const side of [OrderSide.buy, OrderSide.sell]) {
    for (const orderType of [OrderType.market, OrderType.limit]) {
      it.each(['1', '1.000000', '0.5'])(
        `${assetType} ${side} ${orderType} quantity %s`,
        (quantity) => {
          expect(
            code(() =>
              assertOrderInputPolicy({
                assetType,
                side,
                orderType,
                quantity: d(quantity),
                amount: null,
              }),
            ),
          ).toBe(
            orderType === 'limit' && quantity === '0.5'
              ? 'FRACTIONAL_LIMIT_ORDER_NOT_SUPPORTED'
              : null,
          );
        },
      );
    }
  }
  const asset = {
    assetType,
    market: assetType === 'us_stock' ? 'NASDAQ' : 'KRX',
  };
  const open = new Date(
    assetType === 'us_stock' ? '2026-06-18T14:00:00Z' : '2026-06-18T01:00:00Z',
  );
  for (const type of [OrderType.market, OrderType.limit]) {
    it(`${assetType} ${type} open/closed/calendar unavailable`, () => {
      expect(
        code(() => assertOrderSessionAllowed(asset, open, type)),
      ).toBeNull();
      for (const closed of [
        '2026-06-18T23:00:00Z',
        '2026-06-20T12:00:00Z',
        '2026-01-01T12:00:00Z',
      ]) {
        expect(
          code(() => assertOrderSessionAllowed(asset, new Date(closed), type)),
        ).toBe(type === 'limit' ? null : 'MARKET_CLOSED');
      }
      markMarketSessionOverrideStoreRequired();
      expect(code(() => assertOrderSessionAllowed(asset, open, type))).toBe(
        'MARKET_CALENDAR_UNAVAILABLE',
      );
    });
  }
}
it.each([OrderType.market, OrderType.limit])(
  'crypto %s accepts fractional sells and amount buys only',
  (orderType) => {
    expect(
      code(() =>
        assertOrderInputPolicy({
          assetType: AssetType.crypto,
          side: OrderSide.sell,
          orderType,
          quantity: d('0.125'),
          amount: null,
        }),
      ),
    ).toBeNull();
    expect(
      code(() =>
        assertOrderInputPolicy({
          assetType: AssetType.crypto,
          side: OrderSide.buy,
          orderType,
          quantity: null,
          amount: d('100'),
        }),
      ),
    ).toBeNull();
    expect(
      code(() =>
        assertOrderInputPolicy({
          assetType: AssetType.crypto,
          side: OrderSide.buy,
          orderType,
          quantity: d('1'),
          amount: null,
        }),
      ),
    ).toBe('INVALID_ORDER_INPUT');
  },
);
it.each([
  ['100', '700', '0.142857'],
  ['100', '100.2', '0.998003'],
  ['40', '763.79', '0.052370'],
  ['1', '3', '0.333333'],
])('amount %s / price %s floors to %s', (amount, price, expected) => {
  const quantity = quantityFromBuyAmount(d(amount), d(price));
  expect(quantity.toFixed(6)).toBe(expected);
  expect(quantity.mul(price).lte(amount)).toBe(true);
  expect(d(amount).sub(quantity.mul(price)).lt(d(price).mul('0.000001'))).toBe(
    true,
  );
});
it('rejects zero-sized and overflow quantities', () => {
  for (const [amount, price] of [
    ['0.00000001', '100'],
    ['9999999999999999', '0.00000001'],
  ]) {
    expect(code(() => quantityFromBuyAmount(d(amount), d(price)))).toBe(
      'INVALID_AMOUNT',
    );
  }
});
it('binds normalized amount intent to the durable hash independently of price-derived quantity', () => {
  const base = {
    userId: 'u',
    seasonParticipantId: null,
    tradingAccountId: 'a',
    assetId: 'b',
    side: 'buy',
    orderType: 'market',
    quantity: null,
    limitPrice: null,
    currencyCode: 'USD',
  };
  const a = computeOrderQuoteRequestHash({ ...base, amount: '100' });
  expect(a).toBe(
    computeOrderQuoteRequestHash({
      ...base,
      amount: '100.00000000',
      quantity: '0.9',
    }),
  );
  expect(a).not.toBe(computeOrderQuoteRequestHash({ ...base, amount: '101' }));
  expect(a).not.toBe(
    computeOrderQuoteRequestHash({ ...base, quantity: '100' }),
  );
});
