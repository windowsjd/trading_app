jest.mock('../generated/prisma/client', () => ({
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  assertFuturesConditionalEntryEnabled,
  FUTURES_CONDITIONAL_ENTRY_EXECUTION_FAILED,
  futuresConditionalEntryCommandKey,
  futuresConditionalEntryHash,
  futuresConditionalEntryWindowExpired,
  isFuturesConditionalEntryMet,
  isRetryableFuturesConditionalEntryFailure,
  parseFuturesConditionalEntryBody,
} from './futures-conditional-entry-policy';
import {
  futuresConditionalEntryEnabled,
  validateFuturesConfig,
} from './futures.config';

const body = (patch: Record<string, unknown> = {}) => ({
  instrumentId: 'instrument-1',
  direction: 'long',
  marginMode: 'cross',
  leverage: 10,
  quantity: '0.5',
  triggerCondition: 'at_or_above',
  triggerPrice: '110',
  executionType: 'market',
  idempotencyKey: 'entry-key-0001',
  ...patch,
});

function code(work: () => unknown) {
  try {
    work();
  } catch (error) {
    if (error instanceof HttpException)
      return (error.getResponse() as { error: { code: string } }).error.code;
    return 'NOT_HTTP';
  }
  return 'NO_ERROR';
}

describe('Futures conditional entry input', () => {
  it('normalizes a market entry with the Futures command rules', () => {
    const input = parseFuturesConditionalEntryBody(body());
    expect(input.quantity).toBe('0.50000000');
    expect(input.marginMode).toBe('cross');
    expect(input.leverage).toBe(10);
    expect(input.triggerPrice.toFixed(8)).toBe('110.00000000');
    expect(input.limitPrice === null).toBe(true);
    expect(input.idempotencyKey).toBe('entry-key-0001');
  });

  it('keeps the limit price separate from the trigger and defaults isolated', () => {
    const input = parseFuturesConditionalEntryBody(
      body({
        executionType: 'limit',
        limitPrice: '109.5',
        marginMode: undefined,
      }),
    );
    expect(input.marginMode).toBe('isolated');
    expect(input.limitPrice?.toFixed(8)).toBe('109.50000000');
    expect(input.triggerPrice.toFixed(8)).toBe('110.00000000');
  });

  it.each([
    [
      'unknown field',
      body({ positionId: 'p' }),
      'INVALID_FUTURES_CONDITIONAL_ENTRY',
    ],
    ['array body', [], 'INVALID_FUTURES_CONDITIONAL_ENTRY'],
    [
      'market with a limit price',
      body({ limitPrice: '100' }),
      'INVALID_FUTURES_CONDITIONAL_ENTRY',
    ],
    [
      'bad trigger condition',
      body({ triggerCondition: 'gte' }),
      'INVALID_FUTURES_CONDITIONAL_ENTRY',
    ],
    [
      'bad execution type',
      body({ executionType: 'stop' }),
      'INVALID_FUTURES_CONDITIONAL_ENTRY',
    ],
    [
      'limit without a limit price',
      body({ executionType: 'limit' }),
      'INVALID_FUTURES_CONDITIONAL_ENTRY_PRICE',
    ],
    [
      'zero trigger',
      body({ triggerPrice: '0' }),
      'INVALID_FUTURES_CONDITIONAL_ENTRY_PRICE',
    ],
    [
      'nine decimals',
      body({ triggerPrice: '1.000000001' }),
      'INVALID_FUTURES_CONDITIONAL_ENTRY_PRICE',
    ],
    [
      'numeric trigger',
      body({ triggerPrice: 110 }),
      'INVALID_FUTURES_CONDITIONAL_ENTRY_PRICE',
    ],
    ['leverage 101', body({ leverage: 101 }), 'INVALID_FUTURES_LEVERAGE'],
    ['string leverage', body({ leverage: '10' }), 'INVALID_FUTURES_LEVERAGE'],
    ['zero quantity', body({ quantity: '0' }), 'INVALID_FUTURES_COMMAND'],
    ['bad direction', body({ direction: 'buy' }), 'INVALID_FUTURES_COMMAND'],
    [
      'short idempotency key',
      body({ idempotencyKey: 'short' }),
      'INVALID_IDEMPOTENCY_KEY',
    ],
  ])('rejects %s', (_label, input, expected) => {
    expect(code(() => parseFuturesConditionalEntryBody(input))).toBe(expected);
  });

  it('hashes the normalized intent per account', () => {
    const hash = (patch: Record<string, unknown>, account = 'A') =>
      futuresConditionalEntryHash(
        account,
        parseFuturesConditionalEntryBody(body(patch)),
      );
    expect(hash({ triggerPrice: '110.0', quantity: '0.50' })).toBe(hash({}));
    expect(hash({ idempotencyKey: 'other-key-0002' })).toBe(hash({}));
    expect(hash({ triggerPrice: '111' })).not.toBe(hash({}));
    expect(hash({ direction: 'short' })).not.toBe(hash({}));
    expect(hash({ triggerCondition: 'at_or_below' })).not.toBe(hash({}));
    expect(hash({}, 'B')).not.toBe(hash({}));
  });
});

describe('Futures conditional entry trigger and execution rules', () => {
  const d = (value: string) => new Prisma.Decimal(value);

  it('treats equality as met in both directions', () => {
    expect(
      isFuturesConditionalEntryMet('at_or_above', d('110'), d('110')),
    ).toBe(true);
    expect(
      isFuturesConditionalEntryMet('at_or_above', d('109.99999999'), d('110')),
    ).toBe(false);
    expect(isFuturesConditionalEntryMet('at_or_below', d('90'), d('90'))).toBe(
      true,
    );
    expect(
      isFuturesConditionalEntryMet('at_or_below', d('90.00000001'), d('90')),
    ).toBe(false);
  });

  it('closes the execution window at exactly 30 s', () => {
    const at = new Date('2026-10-14T00:00:00.000Z');
    expect(
      futuresConditionalEntryWindowExpired(at, new Date(+at + 29_999)),
    ).toBe(false);
    expect(
      futuresConditionalEntryWindowExpired(at, new Date(+at + 30_000)),
    ).toBe(true);
  });

  it('retries only evidence races and unknown failures', () => {
    for (const retryable of [
      'FUTURES_PRICE_UNAVAILABLE',
      'FUTURES_PRICE_STALE',
      'FUTURES_MARK_UNAVAILABLE',
      'FUTURES_MARK_STALE',
      FUTURES_CONDITIONAL_ENTRY_EXECUTION_FAILED,
    ])
      expect(isRetryableFuturesConditionalEntryFailure(retryable)).toBe(true);
    for (const terminal of [
      'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
      'FUTURES_MAINTENANCE_UNSAFE',
      'FUTURES_POSITION_ALREADY_OPEN',
      'FUTURES_ENTRY_PENDING',
      'FUTURES_REDUCE_ONLY',
      'FUTURES_TRADING_DISABLED',
      'SEASON_ENDED',
      'FUTURES_INSTRUMENT_UNVERIFIED',
      'FUTURES_CONDITIONAL_ENTRY_CHANGED',
      'FUTURES_CONDITIONAL_ENTRY_EXECUTION_WINDOW_EXPIRED',
    ])
      expect(isRetryableFuturesConditionalEntryFailure(terminal)).toBe(false);
  });

  it('derives one deterministic command key per entry', () => {
    expect(futuresConditionalEntryCommandKey('e1')).toBe(
      'futures-conditional:e1',
    );
  });
});

describe('FUTURES_CONDITIONAL_ENTRY_ENABLED', () => {
  const original = process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED;
  afterEach(() => {
    if (original === undefined)
      delete process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED;
    else process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = original;
  });

  it('defaults off and accepts only true/false', () => {
    expect(futuresConditionalEntryEnabled({})).toBe(false);
    expect(
      futuresConditionalEntryEnabled({
        FUTURES_CONDITIONAL_ENTRY_ENABLED: 'true',
      }),
    ).toBe(true);
    expect(
      futuresConditionalEntryEnabled({
        FUTURES_CONDITIONAL_ENTRY_ENABLED: 'false',
      }),
    ).toBe(false);
    for (const value of ['TRUE', '1', 'yes', ''])
      expect(() =>
        futuresConditionalEntryEnabled({
          FUTURES_CONDITIONAL_ENTRY_ENABLED: value,
        }),
      ).toThrow('FUTURES_CONDITIONAL_ENTRY_ENABLED must be true or false');
  });

  it('is validated with the Futures startup configuration', () => {
    expect(() =>
      validateFuturesConfig({ FUTURES_CONDITIONAL_ENTRY_ENABLED: 'on' }),
    ).toThrow('FUTURES_CONDITIONAL_ENTRY_ENABLED must be true or false');
  });

  it('refuses new entries while off', () => {
    delete process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED;
    expect(code(() => assertFuturesConditionalEntryEnabled())).toBe(
      'FUTURES_CONDITIONAL_ENTRY_DISABLED',
    );
    process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'true';
    expect(code(() => assertFuturesConditionalEntryEnabled())).toBe('NO_ERROR');
  });
});
