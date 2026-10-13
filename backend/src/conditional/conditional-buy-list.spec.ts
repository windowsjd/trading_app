jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return { Prisma: { Decimal }, PrismaClient: class PrismaClient {} };
});
// The list never touches the order core; keep its module graph out.
jest.mock('../orders/orders.service', () => ({
  OrdersService: class OrdersService {},
}));
import { HttpException } from '@nestjs/common';
import { ConditionalBuyService } from './conditional-buy.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';
import type { OrdersService } from '../orders/orders.service';

/**
 * Read-only list filters. `state=open` must reach an old live watch or an old
 * linked pending limit order however many ended rows are newer; `state=ended`
 * is exactly its complement. Real PostgreSQL coverage lives in
 * scripts/conditional-buy-orders-integration.ts (`listStates`).
 */
function harness() {
  const calls: { where: unknown; skip: unknown; take: unknown }[] = [];
  const counts: unknown[] = [];
  const owned: unknown[] = [];
  const prisma = {
    conditionalBuyOrder: {
      findMany: jest.fn((args: { where: unknown; skip: unknown; take: unknown }) => {
        calls.push(args);
        return Promise.resolve([]);
      }),
      count: jest.fn((args: { where: unknown }) => {
        counts.push(args.where);
        return Promise.resolve(0);
      }),
    },
    $queryRaw: jest.fn(() => Promise.resolve([{ now: new Date('2026-10-13T01:00:00Z') }])),
  };
  const access = {
    getOwnedAccountOrThrow: jest.fn((userId: string, accountId: string) => {
      owned.push([userId, accountId]);
      return Promise.resolve({ id: accountId, status: 'active', mode: 'general' });
    }),
  };
  const service = new ConditionalBuyService(
    prisma as unknown as PrismaService,
    access as unknown as TradingAccountAccessService,
    {} as OrdersService,
  );
  return { service, calls, counts, owned };
}

function errorCode(error: unknown) {
  if (!(error instanceof HttpException)) return 'NOT_HTTP';
  return (error.getResponse() as { error?: { code?: string } }).error?.code ?? 'NO_CODE';
}

const open = {
  OR: [
    { status: { in: ['watching', 'triggered'] } },
    { status: 'ordered', order: { is: { status: 'submitted' } } },
  ],
};

describe('conditional BUY list state filter', () => {
  it('state=open selects live watches and linked submitted orders, newest first, owner-checked', async () => {
    const h = harness();
    await h.service.list('user-1', 'acct-1', { state: 'open', limit: '100', offset: '0' });
    expect(h.owned).toEqual([['user-1', 'acct-1']]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      where: { tradingAccountId: 'acct-1', ...open },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 100,
    });
    expect(h.counts[0]).toEqual(h.calls[0].where);
  });

  it('state=ended is the complement of open', async () => {
    const h = harness();
    await h.service.list('user-1', 'acct-1', { state: 'ended', limit: '30', offset: '30' });
    expect(h.calls[0]).toMatchObject({
      where: { tradingAccountId: 'acct-1', NOT: open },
      skip: 30,
      take: 30,
    });
  });

  it('keeps the existing default (live only) and history=true (all rows) contracts', async () => {
    const h = harness();
    await h.service.list('user-1', 'acct-1', {});
    await h.service.list('user-1', 'acct-1', { history: 'true' });
    expect(h.calls[0].where).toEqual({
      tradingAccountId: 'acct-1',
      status: { in: ['watching', 'triggered'] },
    });
    expect(h.calls[1].where).toEqual({ tradingAccountId: 'acct-1' });
  });

  it('rejects an unknown state or state combined with history before reading rows', async () => {
    for (const query of [
      { state: 'watching' },
      { state: 'OPEN' },
      { state: 'open', history: 'true' },
      { state: 'ended', history: 'false' },
    ]) {
      const h = harness();
      let observed = 'RESOLVED';
      try {
        await h.service.list('user-1', 'acct-1', query);
      } catch (error) {
        observed = errorCode(error);
      }
      expect(observed).toBe('INVALID_PAGINATION');
      expect(h.calls).toHaveLength(0);
    }
  });
});
