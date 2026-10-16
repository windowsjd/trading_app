jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return { Prisma: { Decimal } };
});
import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  futuresTpSlCondition,
  futuresTpSlEnabled,
  futuresTpSlHash,
  futuresTpSlWindowExpired,
  isFuturesTpSlMet,
  isRetryableFuturesTpSlFailure,
  parseFuturesTpSlBody,
  resolveFuturesTpSlExecution,
} from './futures-tp-sl-policy';

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

describe('Futures stop-loss / take-profit sides', () => {
  it.each([
    ['long', 'take_profit', 'at_or_above'],
    ['long', 'stop_loss', 'at_or_below'],
    ['short', 'take_profit', 'at_or_below'],
    ['short', 'stop_loss', 'at_or_above'],
  ] as const)('%s %s fires %s, equality included', (direction, kind, side) => {
    expect(futuresTpSlCondition(direction, kind)).toBe(side);
    const up = side === 'at_or_above';
    expect(isFuturesTpSlMet(direction, kind, d('100'), d('100'))).toBe(true);
    expect(isFuturesTpSlMet(direction, kind, d('101'), d('100'))).toBe(up);
    expect(isFuturesTpSlMet(direction, kind, d('99'), d('100'))).toBe(!up);
  });
});

describe('execution sizing', () => {
  it('reduces min(target, position), closing exactly the whole remainder', () => {
    expect(
      resolveFuturesTpSlExecution({
        target: d('0.3'),
        positionQuantity: d('1'),
      }),
    ).toEqual({ quantity: d('0.3'), operation: 'reduce' });
    const shrunk = resolveFuturesTpSlExecution({
      target: d('1'),
      positionQuantity: d('0.5'),
    });
    expect(shrunk?.operation).toBe('close');
    expect(shrunk?.quantity.toFixed(8)).toBe('0.50000000');
    expect(
      resolveFuturesTpSlExecution({
        target: d('0.7'),
        positionQuantity: d('0.7'),
      })?.operation,
    ).toBe('close');
    expect(
      resolveFuturesTpSlExecution({ target: d('1'), positionQuantity: d('0') }),
    ).toBeNull();
  });
});

describe('parseFuturesTpSlBody', () => {
  const body = {
    positionId: 'position-1',
    idempotencyKey: 'futures-tp-sl-key',
    stopLoss: { triggerPrice: '90', quantity: '1' },
    takeProfit: { triggerPrice: '110', quantity: '0.3' },
  };
  it('orders a pair stop-loss first and hashes normalized decimals', () => {
    const parsed = parseFuturesTpSlBody(body);
    expect(parsed.intents.map((i) => i.kind)).toEqual([
      'stop_loss',
      'take_profit',
    ]);
    expect(futuresTpSlHash('a', parsed)).toBe(
      futuresTpSlHash(
        'a',
        parseFuturesTpSlBody({
          ...body,
          takeProfit: { triggerPrice: '110.0', quantity: '0.30' },
        }),
      ),
    );
    expect(futuresTpSlHash('a', parsed)).not.toBe(futuresTpSlHash('b', parsed));
  });
  it.each([
    [{ ...body, stopLoss: undefined, takeProfit: undefined }],
    [{ ...body, extra: true }],
    [
      {
        ...body,
        stopLoss: { triggerPrice: '90', quantity: '1', limitPrice: '1' },
      },
    ],
    [{ ...body, stopLoss: { triggerPrice: '0', quantity: '1' } }],
    [{ ...body, stopLoss: { triggerPrice: '90', quantity: '0.000000001' } }],
    [{ ...body, positionId: '' }],
  ])('refuses malformed input %#', (value) => {
    expect(code(() => parseFuturesTpSlBody(value))).toBe(
      'INVALID_FUTURES_TP_SL',
    );
  });
  it('requires a valid idempotency key', () => {
    expect(
      code(() => parseFuturesTpSlBody({ ...body, idempotencyKey: 'x' })),
    ).toBe('INVALID_IDEMPOTENCY_KEY');
  });
});

describe('retry and window policy', () => {
  it('retries only price races and a changed position', () => {
    expect(isRetryableFuturesTpSlFailure('FUTURES_PRICE_STALE')).toBe(true);
    expect(
      isRetryableFuturesTpSlFailure('INVALID_FUTURES_REDUCE_QUANTITY'),
    ).toBe(true);
    expect(isRetryableFuturesTpSlFailure('FUTURES_LIQUIDATION_REQUIRED')).toBe(
      false,
    );
    expect(isRetryableFuturesTpSlFailure('FUTURES_TP_SL_CHANGED')).toBe(false);
  });
  it('closes the window at 30 s inclusive', () => {
    const at = new Date('2026-10-16T00:00:00Z');
    expect(futuresTpSlWindowExpired(at, new Date(at.getTime() + 29_999))).toBe(
      false,
    );
    expect(futuresTpSlWindowExpired(at, new Date(at.getTime() + 30_000))).toBe(
      true,
    );
  });
});

describe('FUTURES_TP_SL_ORDERS_ENABLED', () => {
  it('is strict and defaults off', () => {
    expect(futuresTpSlEnabled({})).toBe(false);
    expect(futuresTpSlEnabled({ FUTURES_TP_SL_ORDERS_ENABLED: 'true' })).toBe(
      true,
    );
    expect(() =>
      futuresTpSlEnabled({ FUTURES_TP_SL_ORDERS_ENABLED: 'yes' }),
    ).toThrow('FUTURES_TP_SL_ORDERS_ENABLED must be true or false');
  });
});
