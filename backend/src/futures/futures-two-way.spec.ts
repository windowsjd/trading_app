jest.mock('../generated/prisma/client', () => ({
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { futuresCommandHash, parseFuturesCommand } from './futures-input';
import {
  futuresDecimal as d,
  planFuturesExecution,
  planFuturesLeverageChange,
} from './futures-math';
import {
  futuresEntryLeverageApproval,
  resolveFuturesEntryFill,
} from './futures-position-policy';
import {
  assessFuturesExposure,
  futuresLeverageChangeHash,
  parseFuturesLeverageChange,
} from './futures-leverage-policy';
import { positionRisk } from './futures-risk';

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

const open = parseFuturesCommand({
  instrumentId: 'i',
  operation: 'open',
  direction: 'long',
  quantity: '1',
  leverage: 10,
  idempotencyKey: 'k',
});

/** An open lifetime of 1 contract at 100 (entry basis 100). */
function lifetime(
  leverage: number,
  marginMode: 'isolated' | 'cross' = 'isolated',
  direction: 'long' | 'short' = 'long',
) {
  const plan = planFuturesExecution(
    { ...open, direction, leverage, marginMode },
    null,
    new Prisma.Decimal('100'),
    d('0.001'),
  );
  return {
    ...plan,
    id: 'p',
    direction,
    leverage,
    marginMode,
    realizedPnl: plan.cumulativeRealizedPnl,
  };
}

describe('Two-way Futures positions (2026-11-06)', () => {
  it('parses fromLeverage only as an increase changing the leverage', () => {
    const increase = {
      instrumentId: 'i',
      positionId: 'p',
      operation: 'increase',
      direction: 'long',
      quantity: '1',
      leverage: 20,
      idempotencyKey: 'k',
    };
    expect(
      parseFuturesCommand({ ...increase, fromLeverage: 10 }).fromLeverage,
    ).toBe(10);
    expect(parseFuturesCommand(increase).fromLeverage).toBeUndefined();
    for (const bad of [
      { ...increase, fromLeverage: 20 },
      { ...increase, fromLeverage: 0 },
      { ...increase, fromLeverage: 10.5 },
      { ...increase, fromLeverage: '10' },
      { ...increase, operation: 'reduce', fromLeverage: 10 },
      { ...open, fromLeverage: 5 },
    ])
      expect(() => parseFuturesCommand(bad)).toThrow(HttpException);
  });

  it('keeps every earlier command hash and binds an approval to its own', () => {
    const plain = parseFuturesCommand({
      instrumentId: 'i',
      positionId: 'p',
      operation: 'increase',
      direction: 'long',
      quantity: '1',
      leverage: 20,
      idempotencyKey: 'k',
    });
    expect(futuresCommandHash('a', plain)).toBe(
      futuresCommandHash('a', { ...plain, fromLeverage: undefined }),
    );
    expect(futuresCommandHash('a', { ...plain, fromLeverage: 10 })).not.toBe(
      futuresCommandHash('a', plain),
    );
  });

  it('opens a direction only while it has no open lifetime', () => {
    errorCode(
      () => planFuturesExecution(open, lifetime(10), d('100'), d('0.001')),
      'FUTURES_POSITION_ALREADY_OPEN',
    );
    // The service passes only the SAME direction's lifetime: none → a new one.
    expect(
      planFuturesExecution(
        { ...open, direction: 'short' },
        null,
        d('100'),
        d('0.001'),
      ).status,
    ).toBe('open');
  });

  it.each([
    // [current leverage, new leverage, expected isolated margin after adding 1 @ 120]
    [10, 10, '22.00000000'],
    [10, 20, '11.00000000'],
    [10, 5, '44.00000000'],
  ])(
    'adds at %ix → %ix re-deriving the whole allocation',
    (from, to, margin) => {
      const plan = planFuturesExecution(
        {
          ...open,
          operation: 'increase',
          positionId: 'p',
          leverage: to,
          ...(from === to ? {} : { fromLeverage: from }),
        },
        lifetime(from),
        d('120'),
        d('0.001'),
      );
      expect(plan.quantity.toFixed(8)).toBe('2.00000000');
      expect(plan.averageEntryPrice.toFixed(8)).toBe('110.00000000');
      expect(plan.entryNotional.toFixed(8)).toBe('220.00000000');
      expect(plan.isolatedMargin.toFixed(8)).toBe(margin);
      expect(plan.realizedPnl.toFixed(8)).toBe('0.00000000');
    },
  );

  it('never changes leverage without the approval of the current value', () => {
    const add = { ...open, operation: 'increase' as const, positionId: 'p' };
    errorCode(
      () =>
        planFuturesExecution(
          { ...add, leverage: 20 },
          lifetime(10),
          d('100'),
          d('0.001'),
        ),
      'FUTURES_LEVERAGE_MISMATCH',
    );
    errorCode(
      () =>
        planFuturesExecution(
          { ...add, leverage: 20, fromLeverage: 15 },
          lifetime(10),
          d('100'),
          d('0.001'),
        ),
      'FUTURES_POSITION_CHANGED',
    );
    // Reduce and close keep naming the lifetime's own leverage.
    errorCode(
      () =>
        planFuturesExecution(
          { ...add, operation: 'reduce', leverage: 20, quantity: '0.5' },
          lifetime(10),
          d('100'),
          d('0.001'),
        ),
      'FUTURES_LEVERAGE_MISMATCH',
    );
  });

  it('changes leverage alone without moving quantity, entry or cash', () => {
    const current = lifetime(10);
    const up = planFuturesLeverageChange(current, 20);
    expect(up.isolatedMarginBefore.toFixed(8)).toBe('10.00000000');
    expect(up.isolatedMargin.toFixed(8)).toBe('5.00000000');
    expect(
      planFuturesLeverageChange(current, 3).isolatedMargin.toFixed(8),
    ).toBe('33.33333334');
    // Cross never allocates; its requirement follows Mark and leverage.
    expect(
      planFuturesLeverageChange(
        lifetime(10, 'cross'),
        20,
      ).isolatedMargin.toFixed(8),
    ).toBe('0.00000000');
    expect(Object.keys(up).sort()).toEqual([
      'isolatedMargin',
      'isolatedMarginBefore',
      'leverage',
    ]);
  });

  it('resolves every pending entry fill with one rule', () => {
    const entry = {
      direction: 'long' as const,
      marginMode: 'isolated' as const,
      leverage: 20,
      leverageChangePositionId: null,
      leverageChangeFrom: null,
    };
    const at = (leverage: number, marginMode = 'isolated' as const) => ({
      id: 'p',
      direction: 'long' as const,
      marginMode,
      leverage,
    });
    expect(resolveFuturesEntryFill(entry, null)).toEqual({ kind: 'open' });
    expect(resolveFuturesEntryFill(entry, at(20))).toEqual({
      kind: 'increase',
      positionId: 'p',
    });
    expect(resolveFuturesEntryFill(entry, at(10))).toEqual({
      kind: 'refused',
      code: 'FUTURES_LEVERAGE_MISMATCH',
    });
    const approved = {
      ...entry,
      leverageChangePositionId: 'p',
      leverageChangeFrom: 10,
    };
    expect(resolveFuturesEntryFill(approved, at(10))).toEqual({
      kind: 'increase',
      positionId: 'p',
      fromLeverage: 10,
    });
    // Outside the approval: another leverage, another lifetime, another mode.
    expect(resolveFuturesEntryFill(approved, at(15)).kind).toBe('refused');
    expect(
      resolveFuturesEntryFill(approved, { ...at(10), id: 'other' }).kind,
    ).toBe('refused');
    expect(
      resolveFuturesEntryFill(entry, { ...at(20), marginMode: 'cross' }),
    ).toEqual({ kind: 'refused', code: 'FUTURES_MARGIN_MODE_MISMATCH' });
    // Already at the target leverage: a plain add, inside the approval.
    expect(resolveFuturesEntryFill(approved, at(20))).toEqual({
      kind: 'increase',
      positionId: 'p',
    });
  });

  it('stores an approval only for a confirmed change of the current lifetime', () => {
    const position = {
      id: 'p',
      direction: 'long' as const,
      marginMode: 'isolated' as const,
      leverage: 10,
    };
    const none = { leverageChangePositionId: null, leverageChangeFrom: null };
    expect(
      futuresEntryLeverageApproval(
        { marginMode: 'isolated', leverage: 20 },
        null,
      ),
    ).toEqual(none);
    expect(
      futuresEntryLeverageApproval(
        { marginMode: 'isolated', leverage: 10 },
        position,
      ),
    ).toEqual(none);
    expect(
      futuresEntryLeverageApproval(
        { marginMode: 'isolated', leverage: 20, fromLeverage: 10 },
        position,
      ),
    ).toEqual({ leverageChangePositionId: 'p', leverageChangeFrom: 10 });
    errorCode(
      () =>
        futuresEntryLeverageApproval(
          { marginMode: 'isolated', leverage: 20 },
          position,
        ),
      'FUTURES_LEVERAGE_MISMATCH',
    );
    errorCode(
      () =>
        futuresEntryLeverageApproval(
          { marginMode: 'isolated', leverage: 20, fromLeverage: 5 },
          position,
        ),
      'FUTURES_POSITION_CHANGED',
    );
    errorCode(
      () =>
        futuresEntryLeverageApproval(
          { marginMode: 'isolated', leverage: 20, fromLeverage: 10 },
          null,
        ),
      'FUTURES_POSITION_CHANGED',
    );
    errorCode(
      () =>
        futuresEntryLeverageApproval(
          { marginMode: 'cross', leverage: 10 },
          position,
        ),
      'FUTURES_MARGIN_MODE_MISMATCH',
    );
  });

  it('parses and hashes a leverage-only change', () => {
    const input = parseFuturesLeverageChange({
      leverage: 20,
      fromLeverage: 10,
      idempotencyKey: ' key ',
    });
    expect(input).toEqual({
      leverage: 20,
      fromLeverage: 10,
      idempotencyKey: 'key',
    });
    for (const bad of [
      { leverage: 10, fromLeverage: 10, idempotencyKey: 'k' },
      { leverage: 101, fromLeverage: 10, idempotencyKey: 'k' },
      { leverage: 20, idempotencyKey: 'k' },
      { leverage: 20, fromLeverage: 10, idempotencyKey: ' ' },
      { leverage: 20, fromLeverage: 10, idempotencyKey: 'k', quantity: '1' },
    ])
      expect(() => parseFuturesLeverageChange(bad)).toThrow(HttpException);
    expect(futuresLeverageChangeHash('a', 'p', input)).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(futuresLeverageChangeHash('a', 'p', input)).not.toBe(
      futuresLeverageChangeHash('a', 'q', input),
    );
  });

  it('assesses a change with the execution core order of checks', () => {
    const wallet = { balanceAmount: d('100'), reservedAmount: d('0') };
    const fee = d('0.001');
    const mark = d('100');
    const isolated = lifetime(10);
    // 10x → 20x releases half the allocation and stays above maintenance.
    const up = planFuturesLeverageChange(isolated, 20);
    expect(
      assessFuturesExposure({
        wallet,
        balanceAfter: d('100'),
        usedAfter: up.isolatedMargin,
        marginMode: 'isolated',
        nextRisk: positionRisk(
          { ...isolated, leverage: 20, isolatedMargin: up.isolatedMargin },
          mark,
          fee,
        ),
        otherCrossRisks: [],
      }).refusal,
    ).toBeNull();
    // Under a loss the same change would leave no maintenance buffer.
    expect(
      assessFuturesExposure({
        wallet,
        balanceAfter: d('100'),
        usedAfter: up.isolatedMargin,
        marginMode: 'isolated',
        nextRisk: positionRisk(
          { ...isolated, leverage: 20, isolatedMargin: up.isolatedMargin },
          d('95'),
          fee,
        ),
        otherCrossRisks: [],
      }).refusal,
    ).toBe('FUTURES_MAINTENANCE_UNSAFE');
    // 10x → 1x needs 100 of margin: more than the unallocated cash.
    const down = planFuturesLeverageChange(isolated, 1);
    expect(
      assessFuturesExposure({
        wallet: { ...wallet, balanceAmount: d('50') },
        balanceAfter: d('50'),
        usedAfter: down.isolatedMargin,
        marginMode: 'isolated',
        nextRisk: positionRisk(
          { ...isolated, leverage: 1, isolatedMargin: down.isolatedMargin },
          mark,
          fee,
        ),
        otherCrossRisks: [],
      }).refusal,
    ).toBe('INSUFFICIENT_FUTURES_FREE_COLLATERAL');
    // Cross long + Cross short: both requirements are summed, never netted.
    const long = lifetime(10, 'cross', 'long');
    const short = lifetime(10, 'cross', 'short');
    const assessed = assessFuturesExposure({
      wallet: { ...wallet, balanceAmount: d('19') },
      balanceAfter: d('19'),
      usedAfter: d('0'),
      marginMode: 'cross',
      nextRisk: positionRisk(long, mark, fee),
      otherCrossRisks: [positionRisk(short, mark, fee)],
    });
    expect(assessed.after.crossInitialMarginRequirement.toFixed(8)).toBe(
      '20.00000000',
    );
    expect(assessed.after.crossUnrealizedPnl.toFixed(8)).toBe('0.00000000');
    expect(assessed.refusal).toBe('INSUFFICIENT_FUTURES_FREE_COLLATERAL');
  });
});
