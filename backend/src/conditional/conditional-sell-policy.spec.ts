jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    Prisma: { Decimal },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    OrderType: { market: 'market', limit: 'limit' },
  };
});
import { HttpException } from '@nestjs/common';
import { AssetType, OrderType, Prisma } from '../generated/prisma/client';
import {
  conditionalSellHash,
  isConditionalSellMet,
  isRetryableConditionalSellFailure,
  parseConditionalSellBody,
  resolveSellExecutionQuantity,
} from './conditional-sell-policy';

const d = (value: string) => new Prisma.Decimal(value);
const code = (work: () => unknown) => {
  try {
    work();
    return 'RESOLVED';
  } catch (error) {
    return error instanceof HttpException
      ? (error.getResponse() as { error: { code: string } }).error.code
      : String(error);
  }
};
const size = (
  target: string,
  holding: string,
  reserved: string,
  assetType: AssetType = AssetType.crypto,
  orderType: OrderType = OrderType.market,
) => {
  const result = resolveSellExecutionQuantity({
    target: d(target),
    holding: d(holding),
    reserved: d(reserved),
    assetType,
    orderType,
  });
  return {
    quantity: result.quantity?.toFixed(6) ?? null,
    available: result.available.toFixed(6),
  };
};

describe('resolveSellExecutionQuantity', () => {
  it('sells min(target, holding − reservations), never more', () => {
    expect(size('10', '10', '0')).toEqual({
      quantity: '10.000000',
      available: '10.000000',
    });
    expect(size('8', '2', '0')).toEqual({
      quantity: '2.000000',
      available: '2.000000',
    });
    expect(size('10', '10', '6')).toEqual({
      quantity: '4.000000',
      available: '4.000000',
    });
    expect(size('3', '10', '6')).toEqual({
      quantity: '3.000000',
      available: '4.000000',
    });
  });

  it('returns nothing to sell when everything is reserved or the holding is gone', () => {
    expect(size('5', '10', '10').quantity).toBeNull();
    expect(size('5', '0', '0').quantity).toBeNull();
    // A broken reservation above the holding never becomes negative.
    expect(size('5', '3', '4')).toEqual({
      quantity: null,
      available: '0.000000',
    });
    expect(
      resolveSellExecutionQuantity({
        target: d('5'),
        holding: null,
        reserved: undefined,
        assetType: AssetType.crypto,
        orderType: OrderType.market,
      }).quantity,
    ).toBeNull();
  });

  it('cuts down to the order unit: whole shares for stock limit orders', () => {
    expect(
      size('10', '4.7', '0', AssetType.domestic_stock, OrderType.limit)
        .quantity,
    ).toBe('4.000000');
    expect(
      size('10', '0.7', '0', AssetType.domestic_stock, OrderType.limit)
        .quantity,
    ).toBeNull();
    expect(
      size('10', '4.7', '0', AssetType.domestic_stock, OrderType.market)
        .quantity,
    ).toBe('4.700000');
    // Crypto keeps 6 decimals, rounding down (never up past the holding).
    expect(size('1', '0.12345678', '0').quantity).toBe('0.123456');
  });
});

describe('parseConditionalSellBody', () => {
  const base = { assetId: 'asset-1', idempotencyKey: 'sell-key-0001' };
  it('parses one condition', () => {
    const input = parseConditionalSellBody({
      ...base,
      kind: 'condition',
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      executionType: 'limit',
      limitPrice: '107.5',
      quantity: '4',
    });
    expect(input.intents).toHaveLength(1);
    expect(input.intents[0]).toMatchObject({
      kind: 'condition',
      triggerCondition: 'at_or_above',
      executionType: 'limit',
    });
    expect(input.intents[0].limitPrice?.toFixed(2)).toBe('107.50');
  });

  it('parses stop-loss and/or take-profit with fixed directions and own quantities', () => {
    const both = parseConditionalSellBody({
      ...base,
      kind: 'protection',
      stopLoss: { triggerPrice: '90', executionType: 'market', quantity: '10' },
      takeProfit: {
        triggerPrice: '120',
        executionType: 'market',
        quantity: '6',
      },
    });
    expect(
      both.intents.map((row) => [
        row.kind,
        row.triggerCondition,
        row.quantity.toFixed(0),
      ]),
    ).toEqual([
      ['stop_loss', 'at_or_below', '10'],
      ['take_profit', 'at_or_above', '6'],
    ]);
    const only = parseConditionalSellBody({
      ...base,
      kind: 'protection',
      takeProfit: {
        triggerPrice: '120',
        executionType: 'market',
        quantity: '1',
      },
    });
    expect(only.intents.map((row) => row.kind)).toEqual(['take_profit']);
  });

  it.each([
    [{ kind: 'protection' }],
    [{ kind: 'unknown' }],
    [
      {
        kind: 'condition',
        triggerCondition: 'at_or_below',
        triggerPrice: '90',
        executionType: 'market',
        limitPrice: '89',
        quantity: '1',
      },
    ],
    [
      {
        kind: 'condition',
        triggerCondition: 'sideways',
        triggerPrice: '90',
        executionType: 'market',
        quantity: '1',
      },
    ],
    [
      {
        kind: 'protection',
        triggerPrice: '90',
        stopLoss: {
          triggerPrice: '90',
          executionType: 'market',
          quantity: '1',
        },
      },
    ],
  ])('rejects an invalid shape %#', (body) => {
    expect(code(() => parseConditionalSellBody({ ...base, ...body }))).toBe(
      'INVALID_CONDITIONAL_SELL',
    );
  });

  it.each(['0', '-1', '1.1234567', 'abc', 1])(
    'rejects quantity %p',
    (quantity) => {
      expect(
        code(() =>
          parseConditionalSellBody({
            ...base,
            kind: 'condition',
            triggerCondition: 'at_or_below',
            triggerPrice: '90',
            executionType: 'market',
            quantity,
          }),
        ),
      ).toBe('INVALID_CONDITIONAL_SELL_PRICE');
    },
  );

  it('hashes the normalized request (same intent → same hash)', () => {
    const a = parseConditionalSellBody({
      ...base,
      kind: 'condition',
      triggerCondition: 'at_or_below',
      triggerPrice: '90.0',
      executionType: 'market',
      quantity: '1.50',
    });
    const b = parseConditionalSellBody({
      ...base,
      kind: 'condition',
      triggerCondition: 'at_or_below',
      triggerPrice: '90',
      executionType: 'market',
      quantity: '1.5',
    });
    expect(conditionalSellHash(a)).toBe(conditionalSellHash(b));
    const c = parseConditionalSellBody({
      ...base,
      kind: 'condition',
      triggerCondition: 'at_or_below',
      triggerPrice: '90',
      executionType: 'market',
      quantity: '1.6',
    });
    expect(conditionalSellHash(a)).not.toBe(conditionalSellHash(c));
  });
});

describe('trigger and retry policy', () => {
  it('meets at equality on both sides', () => {
    expect(isConditionalSellMet('at_or_above', d('100'), d('100'))).toBe(true);
    expect(isConditionalSellMet('at_or_below', d('100'), d('100'))).toBe(true);
    expect(isConditionalSellMet('at_or_above', d('99.9'), d('100'))).toBe(
      false,
    );
    expect(isConditionalSellMet('at_or_below', d('100.1'), d('100'))).toBe(
      false,
    );
  });

  it('retries a lost quantity race but never "nothing left" or a closed market', () => {
    expect(isRetryableConditionalSellFailure('INSUFFICIENT_QUANTITY')).toBe(
      true,
    );
    expect(
      isRetryableConditionalSellFailure(
        'CONDITIONAL_SELL_QUANTITY_UNAVAILABLE',
      ),
    ).toBe(false);
    expect(isRetryableConditionalSellFailure('MARKET_CLOSED')).toBe(false);
    expect(isRetryableConditionalSellFailure('PROTECTION_CONFLICT')).toBe(
      false,
    );
  });
});
