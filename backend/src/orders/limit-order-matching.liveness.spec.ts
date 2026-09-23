jest.mock('../ranking/ranking-refresh.service', () => ({
  RankingRefreshService: class RankingRefreshService {},
}));
jest.mock('./limit-order-execution.service', () => ({
  LimitOrderExecutionService: class LimitOrderExecutionService {},
}));

jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
    AssetType: {
      crypto: 'crypto',
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
    },
    CurrencyCode: { USD: 'USD', KRW: 'KRW' },
    OrderSide: { buy: 'buy', sell: 'sell' },
    OrderStatus: {
      submitted: 'submitted',
      executed: 'executed',
      canceled: 'canceled',
    },
    OrderType: { limit: 'limit' },
    ParticipantStatus: { active: 'active' },
    SeasonStatus: { active: 'active' },
    TradingAccountMode: { season: 'season', general: 'general' },
    TradingAccountStatus: { active: 'active' },
    AssetPriceSourceType: { provider_api: 'provider_api' },
  };
});

import {
  AssetType,
  CurrencyCode,
  OrderSide,
  OrderStatus,
  OrderType,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LimitOrderCandidateRepository } from './limit-order-candidate.repository';
import { LimitOrderCandleEvidenceService } from './limit-order-candle-evidence.service';
import type {
  LimitOrderExecutionService,
  LimitFillPlan,
} from './limit-order-execution.service';
import { LimitOrderMatchingService } from './limit-order-matching.service';

const NOW = new Date('2026-09-22T12:12:00.000Z');
function order(
  id: string,
  position: number,
  side: OrderSide,
  mode: 'general' | 'season' = 'general',
  assetId = 'A',
  price?: number,
  submittedAt = new Date(NOW.getTime() - 600_000 + position * 1000),
) {
  return {
    id,
    side,
    status: OrderStatus.submitted,
    orderType: OrderType.limit,
    tradingAccountId: 'account-' + id,
    assetId,
    quantity: new Prisma.Decimal(1),
    limitPrice: new Prisma.Decimal(
      price ?? (side === OrderSide.buy ? 50 : 150),
    ),
    currencyCode: CurrencyCode.USD,
    reservedAmount: side === OrderSide.buy ? new Prisma.Decimal(100) : null,
    reservedQuantity: side === OrderSide.sell ? new Prisma.Decimal(1) : null,
    reservationFeeRate: new Prisma.Decimal(0),
    submittedAt,
    tradingAccount: {
      seasonParticipant:
        mode === 'season'
          ? {
              season: {
                id: 'season',
                endAt: new Date(NOW.getTime() + 3600_000),
              },
            }
          : null,
    },
    asset: {
      id: assetId,
      assetType: AssetType.crypto,
      market: 'BINANCE',
      symbol: assetId,
      currencyCode: CurrencyCode.USD,
      priceCurrency: CurrencyCode.USD,
      settlementCurrency: CurrencyCode.USD,
      isActive: true,
    },
  };
}
type Row = ReturnType<typeof order>;
function afterFrom(where: any): { submittedAt: Date; id: string } | null {
  if (!where) return null;
  if (
    Array.isArray(where.OR) &&
    where.OR[0]?.submittedAt?.gt instanceof Date &&
    where.OR[1]?.id?.gt
  )
    return { submittedAt: where.OR[0].submittedAt.gt, id: where.OR[1].id.gt };
  for (const part of Array.isArray(where.AND)
    ? where.AND
    : where.AND
      ? [where.AND]
      : []) {
    const found = afterFrom(part);
    if (found) return found;
  }
  return null;
}
function fixture(initial: Row[]) {
  const rows = [...initial];
  const queries: Array<{ ids: string[]; take: number; after: string | null }> =
    [];
  const fills: Array<{ id: string; plan: LimitFillPlan }> = [];
  const failing = new Set<string>(),
    skipping = new Set<string>();
  const prisma = {
    order: {
      findMany: jest.fn(async (query: any) => {
        const live = rows
          .filter((row) => row.status === OrderStatus.submitted)
          .sort(
            (a, b) =>
              a.submittedAt.getTime() - b.submittedAt.getTime() ||
              a.id.localeCompare(b.id),
          );
        if (query.distinct)
          return [...new Set(live.map((row) => row.assetId))]
            .sort()
            .slice(0, query.take)
            .map((assetId) => ({ assetId }));
        const after = afterFrom(query.where);
        const selected = live
          .filter(
            (row) =>
              (!query.where.assetId || row.assetId === query.where.assetId) &&
              (!after ||
                row.submittedAt > after.submittedAt ||
                (row.submittedAt.getTime() === after.submittedAt.getTime() &&
                  row.id > after.id)),
          )
          .slice(0, query.take);
        queries.push({
          ids: selected.map((row) => row.id),
          take: query.take,
          after: after?.id ?? null,
        });
        return selected;
      }),
    },
    marketCandle: {
      findMany: jest.fn(async (query: any) => {
        if (query.where.assetId !== 'A') return [];
        const openTime = new Date(NOW.getTime() - 300_000);
        if (
          openTime < query.where.openTime.gte ||
          openTime > query.where.openTime.lte
        )
          return [];
        return [
          {
            id: 'candle',
            openTime,
            closeTime: NOW,
            low: new Prisma.Decimal(90),
            high: new Prisma.Decimal(110),
            sourceProvider: 'binance',
            sourceUpdatedAt: NOW,
            updatedAt: NOW,
          },
        ];
      }),
    },
  } as unknown as PrismaService;
  const execution = {
    fillLimitOrder: jest.fn(
      async ({ orderId, plan }: { orderId: string; plan: LimitFillPlan }) => {
        fills.push({ id: orderId, plan });
        if (failing.has(orderId))
          throw new Error('synthetic per-order execution error');
        if (skipping.has(orderId)) {
          rows.find((row) => row.id === orderId)!.status = OrderStatus.canceled;
          return { state: 'skipped', orderId, reason: 'not_submitted_limit' };
        }
        rows.find((row) => row.id === orderId)!.status = OrderStatus.executed;
        return {
          state: 'filled',
          orderId,
          path: plan.path,
          seasonId: null,
          seasonParticipantId: null,
        };
      },
    ),
  } as unknown as LimitOrderExecutionService;
  const matcher = new LimitOrderMatchingService(
    prisma,
    new LimitOrderCandidateRepository(prisma),
    new LimitOrderCandleEvidenceService(prisma),
    execution,
  );
  const price = jest.fn(async () => ({
    id: 'snapshot',
    price: new Prisma.Decimal(100),
  }));
  (
    matcher as unknown as { resolvePathASnapshot: typeof price }
  ).resolvePathASnapshot = price;
  return { rows, queries, fills, failing, skipping, matcher, price };
}

describe('limit matcher candidate progress', () => {
  it.each(['general', 'season'] as const)(
    '%s BUY reaches N+1',
    async (mode) => {
      const h = fixture([
        order('1', 0, OrderSide.buy, mode),
        order('2', 1, OrderSide.buy, mode),
        order('3', 2, OrderSide.buy, mode, 'A', 100),
      ]);
      const first = await h.matcher.matchDueLimitOrders({
        now: NOW,
        batchSize: 2,
      });
      expect(first).toMatchObject({
        candidatesScanned: 3,
        ordersConsidered: 1,
        filledPathA: 1,
      });
      expect(h.queries).toHaveLength(1);
      for (let i = 0; i < 2; i++)
        await h.matcher.matchDueLimitOrders({ now: NOW, batchSize: 2 });
      expect(h.fills.map((fill) => fill.id)).toContain('3');
    },
  );
  it.each(['general', 'season'] as const)(
    '%s SELL reaches N+1',
    async (mode) => {
      const h = fixture([
        order('1', 0, OrderSide.sell, mode),
        order('2', 1, OrderSide.sell, mode),
        order('3', 2, OrderSide.sell, mode, 'A', 100),
      ]);
      const first = await h.matcher.matchDueLimitOrders({
        now: NOW,
        batchSize: 2,
      });
      expect(first).toMatchObject({
        candidatesScanned: 3,
        ordersConsidered: 1,
        filledPathA: 1,
      });
      expect(h.queries).toHaveLength(1);
      for (let i = 0; i < 2; i++)
        await h.matcher.matchDueLimitOrders({ now: NOW, batchSize: 2 });
      expect(h.fills.map((fill) => fill.id)).toContain('3');
    },
  );
  it('advances across asset A attempts to B/C and repeated execution errors', async () => {
    const h = fixture([
      order('A1', 0, OrderSide.buy, 'general', 'A', 100),
      order('A2', 1, OrderSide.buy, 'general', 'A', 100),
      order('A3', 2, OrderSide.buy, 'general', 'A', 100),
      order('B1', 3, OrderSide.buy, 'general', 'B', 100),
      order('C1', 4, OrderSide.buy, 'general', 'C', 100),
    ]);
    h.failing.add('A1');
    h.failing.add('A2');
    for (let i = 0; i < 4; i++)
      await h.matcher.matchDueLimitOrders({ now: NOW, batchSize: 2 });
    expect(h.fills.map((fill) => fill.id)).toEqual(
      expect.arrayContaining(['B1', 'C1']),
    );
  });
  it('advances after execution-time cancellation skip', async () => {
    const h = fixture([
      order('1', 0, OrderSide.buy, 'general', 'A', 100),
      order('2', 1, OrderSide.buy, 'general', 'A', 100),
      order('3', 2, OrderSide.buy, 'general', 'A', 100),
    ]);
    h.skipping.add('1');
    for (let i = 0; i < 3; i++)
      await h.matcher.matchDueLimitOrders({ now: NOW, batchSize: 1 });
    expect(h.fills.map((fill) => fill.id)).toEqual(
      expect.arrayContaining(['1', '2', '3']),
    );
  });
  it('handles equal timestamps, removed cursor order and new insertion', async () => {
    const same = new Date(NOW.getTime() - 600_000);
    const h = fixture([
      order('a', 0, OrderSide.buy, 'general', 'A', 100, same),
      order('b', 1, OrderSide.buy, 'general', 'A', 100, same),
      order('c', 2, OrderSide.buy, 'general', 'A', 100, same),
    ]);
    await h.matcher.matchDueLimitOrders({ now: NOW, batchSize: 1 });
    h.rows.splice(
      h.rows.findIndex((row) => row.id === 'a'),
      1,
    );
    h.rows.push(order('d', 3, OrderSide.buy, 'general', 'A', 100, same));
    for (let i = 0; i < 4; i++)
      await h.matcher.matchDueLimitOrders({ now: NOW, batchSize: 1 });
    expect(h.fills.map((fill) => fill.id)).toEqual(
      expect.arrayContaining(['a', 'b', 'c', 'd']),
    );
  });
  it('starts again from FIFO head after matcher restart', async () => {
    const base = Array.from({ length: 6 }, (_, i) =>
      order(String(i + 1), i, OrderSide.buy),
    );
    base.push(order('7', 6, OrderSide.buy, 'general', 'A', 100));
    const h = fixture(base);
    await h.matcher.matchDueLimitOrders({ now: NOW, batchSize: 1 });
    const fresh = fixture(h.rows);
    for (let i = 0; i < 4; i++)
      await fresh.matcher.matchDueLimitOrders({ now: NOW, batchSize: 1 });
    expect(fresh.queries[0].after).toBeNull();
    expect(fresh.fills.map((fill) => fill.id)).toContain('7');
  });
  it('bounds candidate pages and advances a 1,001-row backlog in two cycles', async () => {
    const base = Array.from({ length: 1000 }, (_, i) =>
      order(String(i).padStart(4, '0'), i, OrderSide.buy),
    );
    base.push(order('1000', 1000, OrderSide.buy, 'general', 'A', 100));
    const h = fixture(base);
    const first = await h.matcher.matchDueLimitOrders({
      now: NOW,
      batchSize: 200,
    });
    expect(first).toMatchObject({
      candidatesScanned: 800,
      ordersConsidered: 0,
      assetsScanned: 1,
      scanExhausted: true,
      batchExhausted: false,
    });
    expect(h.queries).toHaveLength(4);
    expect(Math.max(...h.queries.map((query) => query.take))).toBe(200);
    const second = await h.matcher.matchDueLimitOrders({
      now: NOW,
      batchSize: 200,
    });
    expect(second).toMatchObject({
      candidatesScanned: 201,
      ordersConsidered: 1,
      filledPathA: 1,
    });
    expect(h.queries).toHaveLength(6);
    expect(h.fills.map((fill) => fill.id)).toEqual(['1000']);
  });
  it('visits a new earlier order after wrapping at the end of the FIFO', async () => {
    const h = fixture(
      Array.from({ length: 6 }, (_, i) =>
        order(String(i + 1), i, OrderSide.buy),
      ),
    );
    const first = await h.matcher.matchDueLimitOrders({
      now: NOW,
      batchSize: 1,
    });
    expect(first.candidatesScanned).toBe(4);
    h.rows.push(order('new', -1, OrderSide.buy, 'general', 'A', 100));
    await h.matcher.matchDueLimitOrders({ now: NOW, batchSize: 1 });
    await h.matcher.matchDueLimitOrders({ now: NOW, batchSize: 1 });
    expect(h.fills.map((fill) => fill.id)).toContain('new');
  });
  it('keeps normal first-candidate Path A and B plans and no-evidence skips', async () => {
    const a = fixture([order('buy', 0, OrderSide.buy, 'general', 'A', 100)]);
    expect(
      await a.matcher.matchDueLimitOrders({ now: NOW, batchSize: 2 }),
    ).toMatchObject({ filledPathA: 1, ordersConsidered: 1 });
    expect(a.fills[0].plan).toMatchObject({
      path: 'snapshot',
      executedPrice: new Prisma.Decimal(100),
    });
    const b = fixture([order('buy', 0, OrderSide.buy, 'season', 'A', 95)]);
    b.price.mockResolvedValue({
      id: 'snapshot',
      price: new Prisma.Decimal(120),
    });
    expect(
      await b.matcher.matchDueLimitOrders({ now: NOW, batchSize: 2 }),
    ).toMatchObject({ filledPathB: 1, ordersConsidered: 1 });
    expect(b.fills[0].plan).toMatchObject({
      path: 'candle',
      executedPrice: new Prisma.Decimal(95),
    });
    const none = fixture([order('buy', 0, OrderSide.buy, 'season', 'A', 50)]);
    expect(
      await none.matcher.matchDueLimitOrders({ now: NOW, batchSize: 2 }),
    ).toMatchObject({
      candidatesScanned: 1,
      ordersConsidered: 0,
      filledPathA: 0,
      filledPathB: 0,
    });
  });
  it('finds later Path B touch inside lookback', async () => {
    const h = fixture([
      order('1', 0, OrderSide.buy, 'season'),
      order('2', 1, OrderSide.buy, 'season'),
      order('3', 2, OrderSide.buy, 'season', 'A', 95),
    ]);
    h.price.mockResolvedValue({
      id: 'snapshot',
      price: new Prisma.Decimal(120),
    });
    for (let i = 0; i < 3; i++)
      await h.matcher.matchDueLimitOrders({
        now: new Date(NOW.getTime() + i * 5000),
        batchSize: 2,
        candleLookbackMs: 900_000,
      });
    expect(h.fills.find((fill) => fill.id === '3')?.plan).toMatchObject({
      path: 'candle',
      executedPrice: new Prisma.Decimal(95),
    });
  });
});
