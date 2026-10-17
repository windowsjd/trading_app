jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { HttpException } from '@nestjs/common';
import { OrderFailuresService } from './order-failures.service';

const at = new Date('2026-10-17T06:30:00.000Z');
const created = new Date('2026-10-17T06:00:00.000Z');

/* eslint-disable @typescript-eslint/require-await -- the fake mirrors Prisma's async client methods */
function createService(rows: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[]> = {};
  const model = (name: string) => ({
    findFirst: jest.fn(async (args: unknown) => {
      (calls[name] ??= []).push(args);
      return rows[name] ?? null;
    }),
  });
  const prisma = {
    limitOnCloseOrder: model('limitOnCloseOrder'),
    conditionalBuyOrder: model('conditionalBuyOrder'),
    conditionalSellOrder: model('conditionalSellOrder'),
    futuresConditionalEntry: model('futuresConditionalEntry'),
    futuresTpSlSetting: model('futuresTpSlSetting'),
    entryTpSlPlan: model('entryTpSlPlan'),
  };
  return { service: new OrderFailuresService(prisma as never), calls };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const response = error.getResponse() as { error: { code: string } };
    return { status: error.getStatus(), code: response.error.code };
  }
  throw new Error('expected a rejection');
}

const owned = {
  tradingAccountId: 'acct-a',
  tradingAccount: { userId: 'user-a' },
};

describe('OrderFailuresService', () => {
  it('reads the named row only inside the caller’s own account', async () => {
    const { service, calls } = createService({
      limitOnCloseOrder: {
        tradingAccountId: 'acct-a',
        status: 'expired',
        decisionReason: 'loc_close_evidence_unavailable',
        decidedAt: at,
        createdAt: created,
        asset: { name: '삼성전자', symbol: '005930' },
        order: { side: 'buy' },
      },
    });
    const result = await service.get('user-a', 'acct-a', 'loc', 'order-1');
    expect((calls.limitOnCloseOrder[0] as { where: unknown }).where).toEqual({
      orderId: 'order-1',
      ...owned,
    });
    expect(result.data.failure).toEqual({
      kind: 'loc',
      id: 'order-1',
      tradingAccountId: 'acct-a',
      market: 'spot',
      status: 'expired',
      final: true,
      instrument: { name: '삼성전자', symbol: '005930' },
      side: 'buy',
      direction: null,
      protection: null,
      reasonCode: 'loc_close_evidence_unavailable',
      failureCode: null,
      endedAt: at.toISOString(),
      createdAt: created.toISOString(),
    });
  });

  it('answers the same 404 for a missing, foreign or malformed target', async () => {
    const { service, calls } = createService();
    for (const [kind, id, account] of [
      ['conditional_buy', 'cb-1', 'acct-a'],
      ['refund', 'cb-1', 'acct-a'],
      ['conditional_buy', '../cb', 'acct-a'],
      ['conditional_buy', 'cb-1', 'acct a'],
    ]) {
      expect(await rejection(service.get('user-a', account, kind, id))).toEqual(
        {
          status: 404,
          code: 'ORDER_FAILURE_NOT_FOUND',
        },
      );
    }
    // Only the well-formed request reached the database.
    expect(calls.conditionalBuyOrder).toHaveLength(1);
    expect(
      await rejection(service.get(undefined, 'acct-a', 'loc', 'x')),
    ).toEqual({ status: 401, code: 'UNAUTHORIZED' });
  });

  it.each([
    ['conditional_buy', 'conditionalBuyOrder', 'failed', true],
    ['conditional_buy', 'conditionalBuyOrder', 'triggered', false],
    ['conditional_buy', 'conditionalBuyOrder', 'watching', false],
    ['conditional_sell', 'conditionalSellOrder', 'failed', true],
    ['futures_conditional_entry', 'futuresConditionalEntry', 'failed', true],
    ['futures_conditional_entry', 'futuresConditionalEntry', 'ordered', false],
    ['futures_tp_sl', 'futuresTpSlSetting', 'failed', true],
    ['futures_tp_sl', 'futuresTpSlSetting', 'triggered', false],
    ['entry_tp_sl_plan', 'entryTpSlPlan', 'failed', true],
    ['entry_tp_sl_plan', 'entryTpSlPlan', 'pending', false],
  ])('%s %s stored as %s is final=%s', async (kind, name, status, final) => {
    const futures = kind.startsWith('futures');
    const { service, calls } = createService({
      [name]: {
        tradingAccountId: 'acct-a',
        status,
        failureCode: 'FUTURES_PRICE_STALE',
        terminalReason: 'execution_failed',
        endedAt: final ? at : null,
        createdAt: created,
        ...(futures
          ? {
              direction: 'long',
              instrument: { underlyingAsset: { symbol: 'BTCUSDT' } },
            }
          : { asset: { name: 'Apple', symbol: 'AAPL' } }),
        ...(kind === 'conditional_sell' ? { kind: 'stop_loss' } : {}),
        ...(kind === 'futures_tp_sl' ? { kind: 'take_profit' } : {}),
        ...(kind === 'entry_tp_sl_plan'
          ? { domain: 'futures', kind: 'stop_loss' }
          : {}),
      },
    });
    const { failure } = (await service.get('user-a', 'acct-a', kind, 'row-1'))
      .data;
    expect((calls[name][0] as { where: unknown }).where).toEqual({
      id: 'row-1',
      ...owned,
    });
    expect(failure.final).toBe(final);
    expect(failure.status).toBe(status);
    expect(failure.failureCode).toBe('FUTURES_PRICE_STALE');
    expect(failure.reasonCode).toBe('execution_failed');
    if (kind === 'entry_tp_sl_plan') {
      expect(failure.market).toBe('futures');
      expect(failure.instrument).toEqual({ name: null, symbol: 'AAPL' });
      expect(failure.protection).toBe('stop_loss');
    } else if (futures) {
      expect(failure.market).toBe('futures');
      expect(failure.instrument).toEqual({ name: null, symbol: 'BTCUSDT' });
      expect(failure.direction).toBe('long');
    } else {
      expect(failure.market).toBe('spot');
      expect(failure.side).toBe(kind === 'conditional_buy' ? 'buy' : 'sell');
    }
    if (kind === 'conditional_buy' || kind === 'futures_conditional_entry')
      expect(failure.protection).toBeNull();
  });

  it('a LOC still pending or filled is not a failure', async () => {
    for (const status of ['pending', 'filled', 'canceled']) {
      const { service } = createService({
        limitOnCloseOrder: {
          tradingAccountId: 'acct-a',
          status,
          decisionReason: null,
          decidedAt: null,
          createdAt: created,
          asset: { name: '삼성전자', symbol: '005930' },
          order: { side: 'sell' },
        },
      });
      const { failure } = (await service.get('user-a', 'acct-a', 'loc', 'o-1'))
        .data;
      expect(failure.final).toBe(false);
    }
  });
});
