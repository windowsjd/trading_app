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

import { HttpException, Logger } from '@nestjs/common';
import {
  AssetType,
  AssetPriceSourceType,
  CurrencyCode,
  OrderSide,
  OpsJobRunStatus,
  Prisma,
} from '../generated/prisma/client';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { LimitOrderMatchingService } from './limit-order-matching.service';
import { LimitOrderExecutionService } from './limit-order-execution.service';
import type { LimitFillPlan } from './limit-order-execution.service';
import type { LimitMatchCandidate } from './limit-order-candidate.repository';
import { LimitOrderCandleEvidenceService } from './limit-order-candle-evidence.service';
import {
  classifyLimitExecutionError,
  EXECUTION_SKIP_REASONS,
  MAX_LIMIT_MATCHING_SAMPLES,
} from './limit-order-matching-diagnostics';

const NOW = new Date('2026-09-22T01:15:00.000Z'); // KRX regular session
const d = (n: number) => new Prisma.Decimal(n);
function candidate(id = 'order-1'): LimitMatchCandidate {
  return {
    id,
    side: OrderSide.buy,
    tradingAccountId: 'account-1',
    assetId: 'asset-1',
    quantity: d(123456),
    limitPrice: d(100),
    currencyCode: CurrencyCode.USD,
    reservedAmount: d(987654),
    reservationFeeRate: d(0),
    submittedAt: new Date('2026-09-22T01:00:00.000Z'),
    seasonId: null,
    seasonEndAt: null,
    asset: {
      id: 'asset-1',
      assetType: AssetType.crypto,
      market: 'BINANCE',
      symbol: 'BTCUSDT',
      currencyCode: CurrencyCode.USD,
      priceCurrency: CurrencyCode.USD,
      settlementCurrency: CurrencyCode.USD,
      isActive: true,
    },
  };
}
function snapshot(price = 90) {
  return {
    id: 'snapshot-1',
    price: d(price),
    sourceType: AssetPriceSourceType.provider_api,
    sourceName: 'binance_public_rest_24hr_ticker',
    effectiveAt: NOW,
    capturedAt: NOW,
  };
}
function candle(open = '2026-09-22T01:05:00.000Z', low = 80, high = 120) {
  const openTime = new Date(open);
  return {
    id: open,
    openTime,
    closeTime: new Date(openTime.getTime() + 300_000),
    low: d(low),
    high: d(high),
    sourceProvider: 'binance',
    sourceUpdatedAt: NOW,
    updatedAt: NOW,
  };
}
function fixture(orders = [candidate()]) {
  const prisma = {
    assetPriceSnapshot: { findMany: jest.fn().mockResolvedValue([snapshot()]) },
    marketCandle: { findMany: jest.fn().mockResolvedValue([]) },
    opsJobRun: {
      update: jest.fn(async (input) => ({ id: 'run-1', ...input.data })),
    },
  };
  const repository = {
    findFillableLimitOrdersAfter: jest.fn(async (_now, take, after) =>
      orders
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
      async (input: { orderId: string; plan: LimitFillPlan }) => ({
        state: 'filled',
        orderId: input.orderId,
        path: input.plan.path,
        seasonId: null,
        seasonParticipantId: null,
      }),
    ),
  };
  const matcher = new LimitOrderMatchingService(
    prisma as never,
    repository as never,
    new LimitOrderCandleEvidenceService(prisma as never),
    execution as never,
  );
  const run = (now = NOW, batchSize = 200) =>
    matcher.matchDueLimitOrders({ now, batchSize });
  return { prisma, repository, execution, matcher, run };
}

describe('bounded matcher Ops diagnostics', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([OrderSide.buy, OrderSide.sell])(
    'keeps %s Path A priority and snapshot price',
    async (side) => {
      const order = candidate();
      order.side = side;
      const f = fixture([order]);
      f.prisma.assetPriceSnapshot.findMany.mockResolvedValue([
        snapshot(side === OrderSide.buy ? 90 : 110),
      ]);
      f.prisma.marketCandle.findMany.mockResolvedValue([candle()]);
      const result = await f.run();
      expect(result).toMatchObject({
        filledPathA: 1,
        filledPathB: 0,
        ordersConsidered: 1,
      });
      expect(result.diagnostics.planning).toMatchObject({
        noPlan: 0,
        pathA: { trigger_found: 1 },
        pathB: { not_evaluated_path_a_selected: 1 },
        snapshotSelections: { selected: 1 },
        candleOrderExclusions: {},
      });
      expect(f.execution.fillLimitOrder.mock.calls[0][0].plan).toMatchObject({
        path: 'snapshot',
        executedPrice: d(side === OrderSide.buy ? 90 : 110),
      });
    },
  );

  it.each([OrderSide.buy, OrderSide.sell])(
    'falls back to earliest %s candle at order limit',
    async (side) => {
      const order = candidate();
      order.side = side;
      const f = fixture([order]);
      f.prisma.assetPriceSnapshot.findMany.mockResolvedValue([
        snapshot(side === OrderSide.buy ? 110 : 90),
      ]);
      f.prisma.marketCandle.findMany.mockResolvedValue([
        candle(
          '2026-09-22T01:00:00.000Z',
          side === OrderSide.buy ? 110 : 80,
          side === OrderSide.buy ? 120 : 90,
        ),
        candle(),
        candle('2026-09-22T01:10:00.000Z'),
      ]);
      const result = await f.run();
      expect(result).toMatchObject({
        filledPathB: 1,
        diagnostics: {
          planning: {
            pathA: { limit_not_crossed: 1 },
            pathB: { trigger_found: 1 },
          },
        },
      });
      expect(f.execution.fillLimitOrder.mock.calls[0][0].plan).toMatchObject({
        path: 'candle',
        executedPrice: d(100),
        candle: { marketCandleId: '2026-09-22T01:05:00.000Z' },
      });
    },
  );

  it('distinguishes before-submission snapshot and partial/season candle exclusions', async () => {
    const order = candidate();
    order.submittedAt = new Date('2026-09-22T01:00:00.500Z');
    order.seasonEndAt = new Date('2026-09-22T01:09:59.999Z');
    const f = fixture([order]);
    f.prisma.assetPriceSnapshot.findMany.mockResolvedValue([
      {
        ...snapshot(),
        effectiveAt: new Date('2026-09-22T01:00:00.000Z'),
      },
    ]);
    f.prisma.marketCandle.findMany.mockResolvedValue([
      candle('2026-09-22T01:00:00.000Z'),
      candle(),
    ]);
    const result = await f.run();
    expect(result.diagnostics.planning).toMatchObject({
      noPlan: 1,
      pathA: { before_submission: 1 },
      pathB: { no_order_eligible_candle: 1 },
      candleOrderExclusions: { before_first_boundary: 1, after_season_end: 1 },
    });
    expect(f.execution.fillLimitOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['provider_missing', []],
    ['source_name_mismatch', [{ ...snapshot(), sourceName: 'unapproved' }]],
    [
      'captured_at_stale',
      [{ ...snapshot(), capturedAt: new Date(NOW.getTime() - 11_000) }],
    ],
    [
      'captured_at_in_future',
      [{ ...snapshot(), capturedAt: new Date(NOW.getTime() + 1) }],
    ],
    [
      'effective_at_in_future',
      [{ ...snapshot(), effectiveAt: new Date(NOW.getTime() + 1) }],
    ],
    ['non_positive_value', [snapshot(0)]],
  ])(
    'preserves selector %s and continues to Path B',
    async (reason, snapshots) => {
      const f = fixture();
      f.prisma.assetPriceSnapshot.findMany.mockResolvedValue(snapshots);
      f.prisma.marketCandle.findMany.mockResolvedValue([candle()]);
      const result = await f.run();
      expect(result).toMatchObject({
        filledPathB: 1,
        diagnostics: {
          planning: {
            snapshotSelections: { [reason as string]: 1 },
            pathA: { snapshot_selection_failed: 1 },
          },
        },
      });
      expect(f.prisma.assetPriceSnapshot.findMany).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['market_closed', new Date('2026-09-22T12:15:00.000Z'), NOW],
    [
      'effective_at_outside_current_session',
      NOW,
      new Date('2026-09-21T01:15:00.000Z'),
    ],
    ['captured_at_stale', NOW, NOW],
  ])(
    'keeps stock session/freshness policy: %s',
    async (reason, now, effectiveAt) => {
      const order = candidate();
      Object.assign(order.asset, {
        assetType: AssetType.domestic_stock,
        market: 'KRX',
        currencyCode: CurrencyCode.KRW,
        priceCurrency: CurrencyCode.KRW,
      });
      const f = fixture([order]);
      f.prisma.assetPriceSnapshot.findMany.mockResolvedValue([
        {
          ...snapshot(),
          sourceName: 'kis_krx_realtime_trade',
          effectiveAt,
          capturedAt: new Date(
            now.getTime() - (reason === 'captured_at_stale' ? 11_000 : 0),
          ),
        },
      ]);
      expect(
        (await f.run(now)).diagnostics.planning.snapshotSelections,
      ).toEqual({ [reason]: 1 });
    },
  );

  it('reports ineligible asset without querying snapshots', async () => {
    const order = candidate();
    order.asset.market = 'UNSUPPORTED';
    const f = fixture([order]);
    expect((await f.run()).diagnostics.planning.snapshotSelections).toEqual({
      asset_ineligible: 1,
    });
    expect(f.prisma.assetPriceSnapshot.findMany).not.toHaveBeenCalled();
  });

  it('separates calendar-unavailable from an observed empty candle read', async () => {
    const order = candidate();
    Object.assign(order.asset, {
      assetType: AssetType.domestic_stock,
      market: 'KRX',
      currencyCode: CurrencyCode.KRW,
      priceCurrency: CurrencyCode.KRW,
    });
    const f = fixture([order]);
    const result = await f.run(new Date('2040-09-22T01:15:00.000Z'));
    expect(result.diagnostics.planning).toMatchObject({
      noPlan: 1,
      snapshotSelections: { market_calendar_unavailable: 1 },
      pathB: { calendar_unavailable: 1 },
      candleEvidence: {
        calendarUnavailableAssets: 1,
        rowsRead: 0,
        eligible: 0,
      },
    });
    expect(f.prisma.marketCandle.findMany).not.toHaveBeenCalled();
  });

  it('bounds sample identifiers and ignores untrusted HttpException codes/bodies', async () => {
    const order = candidate('x'.repeat(20_000));
    const f = fixture([order]);
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    f.execution.fillLimitOrder.mockRejectedValueOnce(
      new HttpException(
        {
          error: {
            code: 'RAW_POISON_' + 'x'.repeat(20_000),
            message: 'RAW_POISON',
          },
          rawPayload: { wallet: '987654' },
        },
        500,
      ),
    );
    const result = await f.run();
    expect(result.diagnostics.samples[0].orderId).toHaveLength(128);
    expect(result.diagnostics.execution.errorReasons).toEqual({
      unexpected_error: 1,
    });
    expect(JSON.stringify([result, log.mock.calls])).not.toMatch(
      /RAW_POISON|987654/,
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16 * 1024);
    expect(JSON.parse(log.mock.calls[0][0] as string).orderId).toHaveLength(
      128,
    );
  });

  it.each([
    ['no_closed_candle_rows', []],
    [
      'all_candle_rows_excluded',
      [{ ...candle(), closeTime: new Date(NOW.getTime() + 1) }],
    ],
    ['no_limit_touch', [candle('2026-09-22T01:05:00.000Z', 101, 102)]],
  ])(
    'reports Path B %s separately from snapshot failure',
    async (reason, candles) => {
      const f = fixture();
      f.prisma.assetPriceSnapshot.findMany.mockResolvedValue([]);
      f.prisma.marketCandle.findMany.mockResolvedValue(candles);
      expect((await f.run()).diagnostics.planning).toMatchObject({
        noPlan: 1,
        pathB: { [reason as string]: 1 },
      });
      expect(f.execution.fillLimitOrder).not.toHaveBeenCalled();
    },
  );

  it.each(EXECUTION_SKIP_REASONS)(
    'preserves execution skip %s with progress',
    async (reason) => {
      const f = fixture([candidate('1'), candidate('2')]);
      f.execution.fillLimitOrder.mockResolvedValueOnce({
        state: 'skipped',
        reason,
      } as never);
      const result = await f.run();
      expect(result).toMatchObject({
        skipped: 1,
        filledPathA: 1,
        ordersConsidered: 2,
        diagnostics: {
          execution: {
            skipReasons: { [reason]: 1 },
            attempts: { snapshot: 2, candle: 0 },
          },
        },
      });
      // Per-asset caching still performs exactly one of each existing read.
      expect(f.prisma.assetPriceSnapshot.findMany).toHaveBeenCalledTimes(1);
      expect(f.prisma.marketCandle.findMany).toHaveBeenCalledTimes(1);
      expect(f.repository.findFillableLimitOrdersAfter).toHaveBeenCalledTimes(
        1,
      );
    },
  );

  it.each([
    ['ORDER_RESERVATION_INCONSISTENT', 'reservation_inconsistent'],
    ['ORDER_RESERVATION_CONFLICT', 'reservation_conflict'],
    ['TRADING_ACCOUNT_SCOPE_MISMATCH', 'scope_integrity'],
    ['LIMIT_ORDER_EXECUTION_CONFLICT', 'execution_conflict'],
    ['P2034', 'db_transaction_conflict'],
    ['23505', 'db_unique_constraint'],
    ['UNTRUSTED_RAW_CODE', 'unexpected_error'],
  ])(
    'isolates %s errors and logs only safe classification',
    async (code, category) => {
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const f = fixture([candidate('1'), candidate('2')]);
      const error =
        code.startsWith('ORDER_') ||
        code.startsWith('TRADING_') ||
        code.startsWith('LIMIT_')
          ? new HttpException(
              {
                success: false,
                error: {
                  code,
                  message: 'RAW_POISON wallet=987654 price=123456',
                },
              },
              500,
            )
          : Object.assign(
              new Error(
                'RAW_POISON postgres://fake:fake@host/db SELECT secret',
              ),
              { code },
            );
      f.execution.fillLimitOrder.mockRejectedValueOnce(error);
      const result = await f.run();
      expect(result).toMatchObject({
        errors: 1,
        filledPathA: 1,
        diagnostics: {
          execution: {
            errorReasons: {
              [category.startsWith('db_') || category === 'unexpected_error'
                ? category
                : code]: 1,
            },
            errorsByPath: { snapshot: 1, candle: 0 },
          },
        },
      });
      expect(result.diagnostics.samples[0]).toMatchObject({
        phase: 'execution_error',
        path: 'snapshot',
        category,
        stage: 'not_observed',
      });
      expect(JSON.stringify([result, log.mock.calls])).not.toMatch(
        /RAW_POISON|987654|123456|SELECT secret|UNTRUSTED_RAW_CODE/,
      );
    },
  );

  it('uses fixed vocabularies for unknown skip values', async () => {
    const f = fixture();
    f.execution.fillLimitOrder.mockResolvedValueOnce({
      state: 'skipped',
      reason: '__proto__ RAW_POISON',
    } as never);
    const result = await f.run();
    expect(result.diagnostics.execution.skipReasons).toEqual({
      not_observed: 1,
    });
    expect(JSON.stringify(result)).not.toContain('RAW_POISON');
  });

  it('bounds 1000 no-plan samples, keeps counts and persists through Ops sanitizer', async () => {
    const orders = Array.from({ length: 1000 }, (_, i) =>
      candidate(String(i).padStart(4, '0')),
    );
    orders.forEach((order) => {
      order.limitPrice = d(1);
    });
    const f = fixture(orders);
    f.prisma.assetPriceSnapshot.findMany.mockResolvedValue([snapshot(99999)]);
    f.prisma.marketCandle.findMany.mockResolvedValue([
      candle(undefined, 88888, 99999),
    ]);
    const result = await f.run(NOW, 1000);
    expect(result).toMatchObject({
      candidatesScanned: 1000,
      ordersConsidered: 0,
      scanExhausted: true,
      batchExhausted: false,
      diagnostics: {
        planning: {
          noPlan: 1000,
          pathA: { limit_not_crossed: 1000 },
          pathB: { no_limit_touch: 1000 },
        },
        samplesTruncated: true,
      },
    });
    expect(result.diagnostics.samples).toHaveLength(MAX_LIMIT_MATCHING_SAMPLES);
    expect(f.repository.findFillableLimitOrdersAfter).toHaveBeenCalledTimes(5);
    expect(f.prisma.assetPriceSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(f.prisma.marketCandle.findMany).toHaveBeenCalledTimes(1);
    const ops = new OpsJobRunService(f.prisma as never);
    await ops.recordSucceeded(
      { id: 'run-1', startedAt: NOW },
      {
        resultJson: result,
      },
    );
    const saved = f.prisma.opsJobRun.update.mock.calls[0][0].data;
    expect(saved.status).toBe(OpsJobRunStatus.succeeded);
    expect(saved.resultJson).toEqual(result);
    const json = JSON.stringify(saved.resultJson);
    expect(Buffer.byteLength(json)).toBeLessThan(16 * 1024);
    expect(json).not.toMatch(
      /99999|88888|123456|987654|limitPrice|executedPrice|reservedAmount|quantity|sourceProvider/,
    );
    await ops.recordSucceeded(
      { id: 'run-1', startedAt: NOW },
      {
        resultJson: {
          ...result,
          rawPayload: 'RAW_POISON',
          apiKey: 'RAW_POISON',
        },
      },
    );
    expect(
      f.prisma.opsJobRun.update.mock.calls[1][0].data.resultJson,
    ).toMatchObject({ rawPayload: '[REDACTED]', apiKey: '[REDACTED]' });
  });

  it('counts defensive narrowing failures and advances to the next order', async () => {
    const f = fixture([candidate('1'), candidate('2')]);
    const lookup = f.repository.findFillableLimitOrdersAfter;
    const rows = await lookup(NOW, 200, null);
    rows[0].candidate = null as never;
    lookup.mockResolvedValueOnce(rows);
    const result = await f.run();
    expect(result).toMatchObject({
      candidatesScanned: 2,
      filledPathA: 1,
      diagnostics: { candidateRejections: { candidate_shape_invalid: 1 } },
    });
    expect(f.execution.fillLimitOrder.mock.calls[0][0].orderId).toBe('2');
  });
});

describe('actual execution stage without request ALS', () => {
  it('updates the stage per attempt even when the same exception object is reused', async () => {
    const error = new Error('RAW_POISON');
    const tx = {
      order: {
        findUnique: jest
          .fn()
          .mockRejectedValueOnce(error)
          .mockResolvedValue(null),
      },
      $queryRaw: jest.fn().mockRejectedValue(error),
    };
    const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };
    const service = new LimitOrderExecutionService(
      prisma as never,
      null as never,
      null as never,
    );
    const input = {
      orderId: '1',
      plan: {
        path: 'snapshot' as const,
        executedPrice: d(90),
        assetPriceSnapshotId: 'snapshot',
      },
    };
    await expect(service.fillLimitOrder(input)).rejects.toBe(error);
    expect(classifyLimitExecutionError(error).stage).toBe('authorization_lock');
    await expect(service.fillLimitOrder(input)).rejects.toBe(error);
    expect(classifyLimitExecutionError(error).stage).toBe('order_lock');
    prisma.$transaction.mockRejectedValueOnce(error);
    await expect(service.fillLimitOrder(input)).rejects.toBe(error);
    expect(classifyLimitExecutionError(error).stage).toBe('transaction');
  });

  it.each([
    'prelock',
    'order_lock',
    'order_validation',
    'transaction',
  ] as const)(
    'preserves %s failure identity and safe stage',
    async (failure) => {
      const original = Object.assign(new Error('RAW_POISON'), {
        code: 'P2034',
      });
      const tx = {
        order: { findUnique: jest.fn().mockResolvedValue(null) },
        $queryRaw: jest.fn().mockResolvedValue([{ id: '1' }]),
      };
      if (failure === 'prelock')
        tx.order.findUnique.mockRejectedValueOnce(original);
      if (failure === 'order_lock')
        tx.$queryRaw.mockRejectedValueOnce(original);
      if (failure === 'order_validation')
        tx.order.findUnique
          .mockResolvedValueOnce(null)
          .mockRejectedValueOnce(original);
      const prisma = {
        $transaction: jest.fn(async (callback) => {
          const result = await callback(tx);
          if (failure === 'transaction') throw original;
          return result;
        }),
      };
      const service = new LimitOrderExecutionService(
        prisma as never,
        null as never,
        null as never,
      );
      const error = await service
        .fillLimitOrder({
          orderId: '1',
          plan: {
            path: 'snapshot',
            executedPrice: d(90),
            assetPriceSnapshotId: 'snapshot',
          },
        })
        .catch((e: unknown) => e);
      expect(error).toBe(original);
      expect(classifyLimitExecutionError(error)).toMatchObject({
        reason: 'db_transaction_conflict',
        stage: failure === 'prelock' ? 'authorization_lock' : failure,
      });
    },
  );
});
