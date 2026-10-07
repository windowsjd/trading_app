jest.mock('../generated/prisma/client', () => ({
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  assertFuturesLeverage,
  futuresCommandHash,
  parseFuturesCommand,
} from './futures-input';
import {
  futuresDecimal,
  futuresPnl,
  planFuturesExecution,
} from './futures-math';
import { isFuturesTradingEnabled } from './futures.config';
import { validateEnv } from '../common/env-validation';

const d = (s: string) => new Prisma.Decimal(s);
const body = {
  instrumentId: 'i',
  operation: 'open',
  direction: 'long',
  quantity: '1',
  leverage: 37,
  idempotencyKey: 'k',
};
const command = parseFuturesCommand(body);
function errorCode(work: () => unknown, code: string) {
  try {
    work();
    throw new Error('Expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getResponse()).toMatchObject({
      error: { code },
    });
  }
}
function basis(leverage = 37) {
  const plan = planFuturesExecution(
    { ...command, leverage },
    null,
    d('100'),
    d('0.001'),
  );
  return {
    ...plan,
    id: 'p',
    direction: 'long' as const,
    leverage,
    realizedPnl: plan.cumulativeRealizedPnl,
  };
}

describe('Futures input and flag policies', () => {
  it.each([1, 2, 7, 37, 50, 68, 99, 100])(
    'accepts natural-number leverage %s',
    (leverage) => {
      expect(parseFuturesCommand({ ...body, leverage }).leverage).toBe(
        leverage,
      );
    },
  );
  it.each([
    0,
    -1,
    101,
    1.5,
    99.9,
    NaN,
    Infinity,
    '37',
    'NaN',
    null,
    true,
    {},
    [],
  ])('rejects invalid leverage %s', (value) => {
    errorCode(() => assertFuturesLeverage(value), 'INVALID_FUTURES_LEVERAGE');
  });
  it.each([
    { quantity: 1 },
    { quantity: '0' },
    { quantity: '1e3' },
    { quantity: '0.000000001' },
    { operation: ['open'] },
    { direction: ['long'] },
    { operation: 'limit' },
    { marginMode: 'portfolio' },
    { price: '100' },
    { positionId: 'p' },
    { operation: 'reduce' },
  ])('rejects unsupported command intent %j', (patch) => {
    errorCode(
      () => parseFuturesCommand({ ...body, ...patch }),
      'INVALID_FUTURES_COMMAND',
    );
  });
  it('canonicalizes decimals without conflating account/operation intent', () => {
    expect(
      futuresCommandHash(
        'a',
        parseFuturesCommand({ ...body, quantity: '1.00000000' }),
      ),
    ).toBe(futuresCommandHash('a', command));
    expect(futuresCommandHash('b', command)).not.toBe(
      futuresCommandHash('a', command),
    );
    expect(
      futuresCommandHash('a', { ...command, direction: 'short' }),
    ).not.toBe(futuresCommandHash('a', command));
  });
  it('defaults OFF; parses strictly and validates at startup', () => {
    expect(isFuturesTradingEnabled({})).toBe(false);
    expect(isFuturesTradingEnabled({ FUTURES_TRADING_ENABLED: 'true' })).toBe(
      true,
    );
    expect(isFuturesTradingEnabled({ FUTURES_TRADING_ENABLED: '0' })).toBe(
      false,
    );
    expect(() => validateEnv({ FUTURES_TRADING_ENABLED: 'yes' })).toThrow(
      'FUTURES_TRADING_ENABLED',
    );
  });
});

describe('Futures Decimal arithmetic', () => {
  it.each([
    [1, '100.00000000'],
    [7, '14.28571429'],
    [37, '2.70270271'],
    [50, '2.00000000'],
    [100, '1.00000000'],
  ])(
    'calculates margin at %sx and notional fee independently',
    (leverage, expected) => {
      const plan = planFuturesExecution(
        { ...command, leverage: leverage as number },
        null,
        d('100'),
        d('0.001'),
      );
      expect(plan.isolatedMargin.toFixed(8)).toBe(expected);
      expect(plan.feeAmount.toFixed(8)).toBe('0.10000000');
    },
  );
  it('weights average entry and fixes leverage until close', () => {
    const current = basis();
    const plan = planFuturesExecution(
      { ...command, operation: 'increase', positionId: 'p' },
      current,
      d('120'),
      d('0.001'),
    );
    expect(plan.quantity.toFixed(8)).toBe('2.00000000');
    expect(plan.averageEntryPrice.toFixed(8)).toBe('110.00000000');
    expect(plan.isolatedMargin.toFixed(8)).toBe('5.94594595');
    errorCode(
      () =>
        planFuturesExecution(
          { ...command, operation: 'increase', positionId: 'p', leverage: 50 },
          current,
          d('120'),
          d('0.001'),
        ),
      'FUTURES_LEVERAGE_MISMATCH',
    );
  });
  it.each([
    ['long', '110', '10.00000000'],
    ['long', '90', '-10.00000000'],
    ['short', '90', '10.00000000'],
    ['short', '110', '-10.00000000'],
  ] as const)('settles %s entry 100 exit %s', (direction, price, expected) => {
    expect(futuresPnl(direction, d('100'), d(price), d('1')).toFixed(8)).toBe(
      expected,
    );
  });
  it('retains average, rounds partial margin conservatively and releases full margin', () => {
    const current = basis(7);
    const partial = planFuturesExecution(
      {
        ...command,
        operation: 'reduce',
        positionId: 'p',
        leverage: 7,
        quantity: '0.33333333',
      },
      current,
      d('110'),
      d('0.001'),
    );
    expect(partial.quantity.toFixed(8)).toBe('0.66666667');
    expect(partial.averageEntryPrice.toFixed(8)).toBe('100.00000000');
    expect(partial.isolatedMargin.toFixed(8)).toBe('9.52380958');
    expect(partial.cumulativeRealizedPnl.toFixed(8)).toBe('3.33333330');
    const closed = planFuturesExecution(
      {
        ...command,
        operation: 'close',
        positionId: 'p',
        leverage: 7,
        quantity: '0.66666667',
      },
      { ...current, ...partial, realizedPnl: partial.cumulativeRealizedPnl },
      d('90'),
      d('0.001'),
    );
    expect(closed.status).toBe('closed');
    expect(closed.isolatedMargin.toFixed(8)).toBe('0.00000000');
    expect(closed.cumulativeRealizedPnl.toFixed(8)).toBe('-3.33333340');
  });
  it('does not allocate below a cash quantum at 100x or release margin on increase', () => {
    const opened = planFuturesExecution(
      { ...command, quantity: '0.00000001', leverage: 100 },
      null,
      d('1'),
      d('0.001'),
    );
    expect(opened.isolatedMargin.toFixed(8)).toBe('0.00000001');
    const increased = planFuturesExecution(
      {
        ...command,
        operation: 'increase',
        positionId: 'p',
        quantity: '0.00000001',
        leverage: 100,
      },
      {
        ...opened,
        id: 'p',
        direction: 'long',
        leverage: 100,
        realizedPnl: d('0'),
      },
      d('1'),
      d('0.001'),
    );
    expect(increased.isolatedMargin.gte(opened.isolatedMargin)).toBe(true);
    expect(increased.isolatedMargin.gte(increased.entryNotional.div(100))).toBe(
      true,
    );
  });
  it('preserves low digits beyond Decimal default 20-digit precision', () => {
    expect(
      futuresDecimal('9999999999999999.99999999').sub('0.00000001').toFixed(8),
    ).toBe('9999999999999999.99999998');
    const plan = planFuturesExecution(
      { ...command, quantity: '1', leverage: 100 },
      null,
      d('9999999999999999.99999999'),
      d('0'),
    );
    expect(plan.notional.toFixed(8)).toBe('9999999999999999.99999999');
    expect(plan.isolatedMargin.toFixed(8)).toBe('100000000000000.00000000');
  });
  it('rejects overflow, rounded-zero notional, wrong direction, extra close quantity and duplicate open', () => {
    errorCode(
      () =>
        planFuturesExecution(
          { ...command, quantity: '9999999999999999' },
          null,
          d('100'),
          d('0'),
        ),
      'FUTURES_VALUE_OUT_OF_RANGE',
    );
    errorCode(
      () =>
        planFuturesExecution(
          { ...command, quantity: '0.00000001' },
          null,
          d('0.00000001'),
          d('0'),
        ),
      'FUTURES_VALUE_TOO_SMALL',
    );
    errorCode(
      () => planFuturesExecution(command, basis(), d('100'), d('0')),
      'FUTURES_POSITION_ALREADY_OPEN',
    );
    errorCode(
      () =>
        planFuturesExecution(
          {
            ...command,
            operation: 'reduce',
            positionId: 'p',
            direction: 'short',
          },
          basis(),
          d('100'),
          d('0'),
        ),
      'FUTURES_ONE_WAY_VIOLATION',
    );
    errorCode(
      () =>
        planFuturesExecution(
          { ...command, operation: 'reduce', positionId: 'p', quantity: '2' },
          basis(),
          d('100'),
          d('0'),
        ),
      'INVALID_FUTURES_REDUCE_QUANTITY',
    );
  });
});
