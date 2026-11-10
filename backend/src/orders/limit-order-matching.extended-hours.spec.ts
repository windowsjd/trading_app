jest.mock('../generated/prisma/client', () => ({
  ...jest.requireActual('../generated/prisma/enums'),
  PrismaClient: class PrismaClient {},
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
jest.mock('../ranking/ranking-refresh.service', () => ({
  RankingRefreshService: class RankingRefreshService {},
}));
jest.mock('./orders.service', () => ({
  OrdersService: class OrdersService {},
}));
jest.mock('../portfolio/general-account-performance.service', () => ({
  GeneralAccountPerformanceService: class GeneralAccountPerformanceService {},
}));

import {
  AssetType,
  AssetPriceSourceType,
  CurrencyCode,
  OrderSide,
  Prisma,
} from '../generated/prisma/client';
import { PROVIDER_SOURCE_NAMES } from '../providers/source-eligibility.policy';
import type { LimitFillPlan } from './limit-order-execution.service';
import type { LimitMatchCandidate } from './limit-order-candidate.repository';
import { LimitOrderCandleEvidenceService } from './limit-order-candle-evidence.service';
import {
  LIMIT_MATCHING_FX_RETRY_MS,
  LimitOrderMatchingService,
} from './limit-order-matching.service';

const EXTENDED = PROVIDER_SOURCE_NAMES.usStockTiingoExtended;
const REGULAR = PROVIDER_SOURCE_NAMES.usStockTiingo;
// 2026-11-10 (EST): pre-market 09:00Z–14:30Z, after-hours 21:00Z–01:00Z.
const PRE = new Date('2026-11-10T11:00:00.000Z');
const AFTER = new Date('2026-11-10T22:00:00.000Z');
const REGULAR_NOW = new Date('2026-11-10T16:00:00.000Z');
const d = (n: number) => new Prisma.Decimal(n);

function order(
  overrides: Partial<LimitMatchCandidate> = {},
  asset: Partial<LimitMatchCandidate['asset']> = {},
): LimitMatchCandidate {
  return {
    id: 'order-1',
    side: OrderSide.buy,
    tradingAccountId: 'account-1',
    assetId: 'asset-us',
    quantity: d(2),
    limitPrice: d(100),
    currencyCode: CurrencyCode.USD,
    reservedAmount: d(200.2),
    reservationFeeRate: d(0.001),
    submittedAt: new Date('2026-11-10T08:00:00.000Z'),
    seasonId: null,
    seasonEndAt: null,
    ...overrides,
    asset: {
      id: 'asset-us',
      assetType: AssetType.us_stock,
      market: 'NAS',
      symbol: 'AAPL',
      currencyCode: CurrencyCode.USD,
      priceCurrency: CurrencyCode.USD,
      settlementCurrency: CurrencyCode.USD,
      isActive: true,
      ...asset,
    },
  };
}
function snapshot(
  price: number,
  effectiveAt: Date,
  options: { sourceName?: string; capturedAt?: Date; id?: string } = {},
) {
  return {
    id: options.id ?? `snap-${price}`,
    price: d(price),
    sourceType: AssetPriceSourceType.provider_api,
    sourceName: options.sourceName ?? EXTENDED,
    effectiveAt,
    capturedAt: options.capturedAt ?? new Date(effectiveAt.getTime() + 200),
  };
}

function fixture(input: {
  orders: LimitMatchCandidate[];
  extended?: ReturnType<typeof snapshot>[];
  regular?: ReturnType<typeof snapshot>[];
  prepare?: jest.Mock;
}) {
  const findMany = jest.fn((args: { where: { sourceName?: string } }) =>
    Promise.resolve(
      args.where.sourceName === EXTENDED
        ? (input.extended ?? [])
        : (input.regular ?? []),
    ),
  );
  const prisma = {
    assetPriceSnapshot: { findMany },
    marketCandle: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const repository = {
    findFillableLimitOrdersAfter: jest.fn(async (_now, take, after) =>
      input.orders
        .filter((o) => !after || o.id > after.id)
        .slice(0, take)
        .map((o) => ({
          cursor: { submittedAt: o.submittedAt, id: o.id },
          assetId: o.assetId,
          candidate: o,
        })),
    ),
  };
  const execution = {
    fillLimitOrder: jest.fn(
      async (fill: { orderId: string; plan: LimitFillPlan }) => ({
        state: 'filled',
        orderId: fill.orderId,
        path: fill.plan.path,
        seasonId: null,
        seasonParticipantId: null,
      }),
    ),
  };
  const prepare =
    input.prepare ??
    jest.fn().mockResolvedValue({
      attempted: false,
      result: 'already_fresh',
      source: 'korea_exim_exchange_rate',
    });
  const matcher = new LimitOrderMatchingService(
    prisma as never,
    repository as never,
    new LimitOrderCandleEvidenceService(prisma as never),
    execution as never,
    undefined,
    { prepare } as never,
  );
  return {
    findMany,
    execution,
    prepare,
    run: (now: Date) => matcher.matchDueLimitOrders({ now, batchSize: 200 }),
  };
}
const plans = (f: ReturnType<typeof fixture>) =>
  f.execution.fillLimitOrder.mock.calls.map(
    ([fill]) => fill as { orderId: string; plan: LimitFillPlan },
  );

describe('limit matcher in US extended hours (2026-11-10)', () => {
  const previous = { ...process.env };
  beforeEach(() => {
    process.env.US_STOCK_PRICE_PROVIDER = 'tiingo';
    process.env.US_STOCK_EXTENDED_HOURS_PRICE_ENABLED = 'true';
    process.env.US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED = 'true';
  });
  afterEach(() => {
    process.env = { ...previous };
    jest.restoreAllMocks();
  });

  it('fills a pre-market BUY at a fresh extended price at or below the limit', async () => {
    const f = fixture({
      orders: [order()],
      extended: [
        snapshot(99.5, new Date(PRE.getTime() - 2_000), { id: 'pre-tick' }),
      ],
    });
    const summary = await f.run(PRE);
    expect(summary.filledPathA).toBe(1);
    expect(plans(f)[0].plan).toMatchObject({
      path: 'snapshot',
      assetPriceSnapshotId: 'pre-tick',
    });
    expect(
      (plans(f)[0].plan as { executedPrice: Prisma.Decimal }).executedPrice.eq(
        99.5,
      ),
    ).toBe(true);
    // One bounded read of THIS window's extended rows.
    const [[args]] = f.findMany.mock.calls as Array<
      [{ where: Record<string, unknown>; take: number }]
    >;
    expect(args.where).toMatchObject({
      assetId: 'asset-us',
      sourceName: EXTENDED,
      effectiveAt: { gte: new Date('2026-11-10T09:00:00.000Z'), lte: PRE },
    });
    expect(args.take).toBe(10);
  });

  it('fills an after-hours SELL at a fresh extended price at or above the limit', async () => {
    const f = fixture({
      orders: [
        order({
          side: OrderSide.sell,
          reservedAmount: null,
          reservedQuantity: d(2),
          submittedAt: new Date('2026-11-10T15:00:00.000Z'),
        }),
      ],
      extended: [snapshot(100.25, new Date(AFTER.getTime() - 3_000))],
    });
    expect((await f.run(AFTER)).filledPathA).toBe(1);
  });

  it('never fills on an uncrossed limit, pre-submission, stale or regular evidence', async () => {
    const cases: Array<{
      label: string;
      order: LimitMatchCandidate;
      extended: ReturnType<typeof snapshot>[];
      pathA: string;
    }> = [
      {
        label: 'limit not reached',
        order: order(),
        extended: [snapshot(100.01, new Date(PRE.getTime() - 1_000))],
        pathA: 'limit_not_crossed',
      },
      {
        label: 'tick before the latest 설정 변경',
        order: order({ revisedAt: new Date(PRE.getTime() - 500) }),
        extended: [snapshot(99, new Date(PRE.getTime() - 1_000))],
        pathA: 'before_submission',
      },
      {
        label: 'older than the 10 s execute freshness',
        order: order(),
        extended: [
          snapshot(99, new Date(PRE.getTime() - 12_000), {
            capturedAt: new Date(PRE.getTime() - 11_000),
          }),
        ],
        pathA: 'snapshot_selection_failed',
      },
      {
        label: 'a regular-source row in the window',
        order: order(),
        extended: [
          snapshot(99, new Date(PRE.getTime() - 1_000), {
            sourceName: REGULAR,
          }),
        ],
        pathA: 'snapshot_selection_failed',
      },
    ];
    for (const item of cases) {
      const f = fixture({ orders: [item.order], extended: item.extended });
      const summary = await f.run(PRE);
      expect({ label: item.label, filled: summary.filledPathA }).toEqual({
        label: item.label,
        filled: 0,
      });
      expect(
        summary.diagnostics.planning.pathA[item.pathA as 'trigger_found'],
      ).toBe(1);
      expect(f.execution.fillLimitOrder).not.toHaveBeenCalled();
    }
  });

  it('keeps the regular-session policy with the limit switch off', async () => {
    delete process.env.US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED;
    const f = fixture({
      orders: [order()],
      extended: [snapshot(99, new Date(PRE.getTime() - 1_000))],
      regular: [snapshot(99, new Date(PRE.getTime() - 1_000))],
    });
    const summary = await f.run(PRE);
    expect(summary.filledPathA).toBe(0);
    expect(summary.diagnostics.planning.snapshotSelections).toEqual({
      market_closed: 1,
    });
    // No extended read at all.
    expect(
      f.findMany.mock.calls.some(
        ([args]) =>
          (args as { where: { sourceName?: string } }).where.sourceName ===
          EXTENDED,
      ),
    ).toBe(false);
  });

  it('uses the regular path during the regular session', async () => {
    const f = fixture({
      orders: [order()],
      regular: [
        snapshot(99, new Date(REGULAR_NOW.getTime() - 1_000), {
          sourceName: REGULAR,
          id: 'regular-tick',
        }),
      ],
    });
    expect((await f.run(REGULAR_NOW)).filledPathA).toBe(1);
    expect(plans(f)[0].plan).toMatchObject({
      assetPriceSnapshotId: 'regular-tick',
    });
  });

  describe('USD/KRW preparation', () => {
    it('prepares once per cycle, before the first US stock fill only', async () => {
      const f = fixture({
        orders: [order({ id: 'a' }), order({ id: 'b' }), order({ id: 'c' })],
        extended: [snapshot(99, new Date(PRE.getTime() - 1_000))],
      });
      const summary = await f.run(PRE);
      expect(summary.filledPathA).toBe(3);
      expect(f.prepare).toHaveBeenCalledTimes(1);
      expect(f.prepare).toHaveBeenCalledWith('orders_execute');
      expect(summary.diagnostics.execution.fxPreparation).toEqual({
        already_fresh: 1,
      });
    });

    it('keeps the old behavior with the limit switch off: no preparation, even for a regular-session fill', async () => {
      delete process.env.US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED;
      const f = fixture({
        orders: [order()],
        regular: [
          snapshot(99, new Date(REGULAR_NOW.getTime() - 1_000), {
            sourceName: REGULAR,
          }),
        ],
      });
      expect((await f.run(REGULAR_NOW)).filledPathA).toBe(1);
      expect(f.prepare).not.toHaveBeenCalled();
    });

    it('prepares before a regular-session US fill too once the switch is on', async () => {
      const f = fixture({
        orders: [order()],
        regular: [
          snapshot(99, new Date(REGULAR_NOW.getTime() - 1_000), {
            sourceName: REGULAR,
          }),
        ],
      });
      expect((await f.run(REGULAR_NOW)).filledPathA).toBe(1);
      expect(f.prepare).toHaveBeenCalledTimes(1);
    });

    it('never prepares without a US stock fill (no plan, or crypto)', async () => {
      const noPlan = fixture({
        orders: [order()],
        extended: [snapshot(101, new Date(PRE.getTime() - 1_000))],
      });
      await noPlan.run(PRE);
      expect(noPlan.prepare).not.toHaveBeenCalled();
      const crypto = fixture({
        orders: [
          order(
            { assetId: 'asset-btc' },
            {
              id: 'asset-btc',
              assetType: AssetType.crypto,
              market: 'BINANCE',
              symbol: 'BTCUSDT',
            },
          ),
        ],
        regular: [
          snapshot(99, new Date(PRE.getTime() - 1_000), {
            sourceName: 'binance_spot_ws_ticker',
          }),
        ],
      });
      expect((await crypto.run(PRE)).filledPathA).toBe(1);
      expect(crypto.prepare).not.toHaveBeenCalled();
    });

    it('waits a minute after a failed preparation; the fill still runs and re-selects FX itself', async () => {
      let nowMs = PRE.getTime();
      jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
      const prepare = jest
        .fn()
        .mockResolvedValueOnce({
          attempted: true,
          result: 'unavailable',
          source: null,
        })
        .mockRejectedValueOnce(new Error('provider down'))
        .mockResolvedValue({
          attempted: true,
          result: 'refreshed',
          source: 'x',
        });
      const f = fixture({
        orders: [order()],
        extended: [snapshot(99, new Date(PRE.getTime() - 1_000))],
        prepare,
      });
      const first = await f.run(PRE);
      expect(first.diagnostics.execution.fxPreparation).toEqual({
        unavailable: 1,
      });
      // The fill is attempted anyway: its transaction decides (skip without FX).
      expect(f.execution.fillLimitOrder).toHaveBeenCalledTimes(1);
      nowMs += LIMIT_MATCHING_FX_RETRY_MS - 1;
      const cooling = await f.run(PRE);
      expect(cooling.diagnostics.execution.fxPreparation).toEqual({
        cooling_down: 1,
      });
      expect(prepare).toHaveBeenCalledTimes(1);
      nowMs += 1;
      const failed = await f.run(PRE);
      expect(failed.diagnostics.execution.fxPreparation).toEqual({ failed: 1 });
      nowMs += LIMIT_MATCHING_FX_RETRY_MS;
      const refreshed = await f.run(PRE);
      expect(refreshed.diagnostics.execution.fxPreparation).toEqual({
        refreshed: 1,
      });
      expect(prepare).toHaveBeenCalledTimes(3);
    });
  });
});
