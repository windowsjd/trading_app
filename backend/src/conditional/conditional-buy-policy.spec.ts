jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<typeof import('@prisma/client/runtime/client')>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
}));
import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  conditionalBuyHash,
  isConditionalBuyMet,
  isRetryableConditionalBuyFailure,
  parseConditionalBuyBody,
  type ConditionalBuyBody,
} from './conditional-buy-policy';

const d = (value: string) => new Prisma.Decimal(value);
const base: ConditionalBuyBody = {
  assetId: 'asset-1',
  triggerCondition: 'at_or_above',
  triggerPrice: '100.5',
  executionType: 'market',
  quantity: '3',
  idempotencyKey: 'conditional-key-1',
};

function code(body: ConditionalBuyBody): string | null {
  try {
    parseConditionalBuyBody(body);
    return null;
  } catch (error) {
    if (!(error instanceof HttpException)) return 'NOT_HTTP';
    return (
      (error.getResponse() as { error?: { code?: string } }).error?.code ??
      'NO_CODE'
    );
  }
}

describe('conditional BUY request parsing', () => {
  it('keeps the watch price and the execution limit price separate', () => {
    const parsed = parseConditionalBuyBody({
      ...base,
      executionType: 'limit',
      triggerPrice: '100',
      limitPrice: '101.25',
    });
    expect(parsed.triggerPrice.toFixed(2)).toBe('100.00');
    expect(parsed.limitPrice?.toFixed(2)).toBe('101.25');
    expect(parsed.quantity?.toFixed(0)).toBe('3');
    expect(parsed.amount === null).toBe(true);
  });

  it('accepts a crypto principal amount instead of quantity', () => {
    const parsed = parseConditionalBuyBody({
      ...base,
      quantity: undefined,
      amount: '250.12345678',
    });
    expect(parsed.amount?.toFixed(8)).toBe('250.12345678');
    expect(parsed.quantity === null).toBe(true);
  });

  it('rejects malformed shapes with fixed codes', () => {
    expect(code({ ...base, triggerCondition: 'cross' })).toBe(
      'INVALID_CONDITIONAL_BUY',
    );
    expect(code({ ...base, executionType: 'stop' })).toBe(
      'INVALID_CONDITIONAL_BUY',
    );
    expect(code({ ...base, limitPrice: '10' })).toBe('INVALID_CONDITIONAL_BUY');
    expect(code({ ...base, amount: '10' })).toBe('INVALID_CONDITIONAL_BUY');
    expect(code({ ...base, quantity: undefined })).toBe(
      'INVALID_CONDITIONAL_BUY',
    );
    expect(code({ ...base, executionType: 'limit' })).toBe(
      'INVALID_CONDITIONAL_BUY_PRICE',
    );
    expect(code({ ...base, triggerPrice: '0' })).toBe(
      'INVALID_CONDITIONAL_BUY_PRICE',
    );
    expect(code({ ...base, triggerPrice: '1.123456789' })).toBe(
      'INVALID_CONDITIONAL_BUY_PRICE',
    );
    expect(code({ ...base, quantity: '1.1234567' })).toBe(
      'INVALID_CONDITIONAL_BUY_PRICE',
    );
    expect(code({ ...base, idempotencyKey: 'short' })).toBe(
      'INVALID_IDEMPOTENCY_KEY',
    );
    expect(code({ ...base, currencyCode: 'EUR' })).toBe(
      'INVALID_CONDITIONAL_BUY',
    );
  });

  it('hashes the normalized intent, not the decimal spelling', () => {
    const a = parseConditionalBuyBody({ ...base, triggerPrice: '100.5' });
    const b = parseConditionalBuyBody({ ...base, triggerPrice: '100.50' });
    const c = parseConditionalBuyBody({ ...base, triggerPrice: '100.51' });
    expect(conditionalBuyHash(a) === conditionalBuyHash(b)).toBe(true);
    expect(conditionalBuyHash(a) === conditionalBuyHash(c)).toBe(false);
  });
});

describe('conditional BUY trigger rule', () => {
  it('at_or_above triggers on price ≥ trigger; at_or_below on price ≤ trigger', () => {
    expect(isConditionalBuyMet('at_or_above', d('100'), d('100'))).toBe(true);
    expect(isConditionalBuyMet('at_or_above', d('99.99'), d('100'))).toBe(
      false,
    );
    expect(isConditionalBuyMet('at_or_below', d('100'), d('100'))).toBe(true);
    expect(isConditionalBuyMet('at_or_below', d('100.01'), d('100'))).toBe(
      false,
    );
  });
});

describe('conditional BUY execution failure policy', () => {
  it('retries only transient evidence/quote races inside the window', () => {
    for (const retryable of [
      'ASSET_PRICE_UNAVAILABLE',
      'PRICE_STALE',
      'RATE_CHANGED_REQUOTE_REQUIRED',
      'FX_RATE_UNAVAILABLE',
      'ORDER_EXECUTION_CONFLICT',
    ])
      expect(isRetryableConditionalBuyFailure(retryable)).toBe(true);
    for (const terminal of [
      'INSUFFICIENT_BALANCE',
      'INSUFFICIENT_AVAILABLE_BALANCE',
      'MARKET_CLOSED',
      'SEASON_ENDED',
      'PARTICIPANT_EXCLUDED',
      'TRADING_ACCOUNT_NOT_ACTIVE',
      'BEGINNER_FEATURE_LOCKED',
      'PROTECTION_CHILD_PENDING',
      'LIMIT_ORDER_DISABLED',
      'CONDITIONAL_BUY_CHANGED',
    ])
      expect(isRetryableConditionalBuyFailure(terminal)).toBe(false);
  });
});
