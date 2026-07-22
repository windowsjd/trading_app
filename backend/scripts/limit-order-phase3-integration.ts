/**
 * Phase-3 PostgreSQL + Redis integration runner.
 *
 * Covers, against a REAL database and a REAL Redis instance:
 *   - the event-boundary advisory mutex in both interleavings
 *     (create-first and poller-first) plus dedicated-session crash release,
 *   - path B (confirmed 5m candle safety net) end to end,
 *   - the first-eligible-candle boundary (partial candle excluded),
 *   - path A vs path B, cancel, exclusion and season-end races,
 *   - processed-candle idempotence and crash re-run,
 *   - the strengthened matcher health gate,
 *   - a synthetic throughput sweep that proves there is no per-event asset
 *     database lookup.
 *
 * No external provider is contacted; every trade is a normalized fixture tick.
 * Nothing here sleeps to "win" a race — every ordering is enforced with
 * explicit transaction orchestration, advisory-lock inspection and barriers.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
  UserRole,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { NormalizedProviderTradeEventBus } from '../src/providers/normalized-provider-trade-event-bus.service';
import { ProviderTradeRouteRegistry } from '../src/providers/provider-trade-route.registry';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { LimitOrderCandidateRepository } from '../src/orders/limit-matching/limit-order-candidate.repository';
import { LimitOrderCandleReconciliationService } from '../src/orders/limit-matching/limit-order-candle-reconciliation.service';
import { calculateCandleMatchingEligibleFrom } from '../src/orders/limit-matching/limit-order-candle-eligibility';
import { LimitOrderEventPollerService } from '../src/orders/limit-matching/limit-order-event-poller.service';
import { LimitOrderEventStreamService } from '../src/orders/limit-matching/limit-order-event-stream.service';
import { LimitOrderExecutionService } from '../src/orders/limit-matching/limit-order-execution.service';
import {
  LIMIT_ORDER_MATCH_BOUNDARY_KEY,
  LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE,
  LimitOrderMatchBoundaryService,
} from '../src/orders/limit-matching/limit-order-match-boundary.service';
import { LimitOrderMatcherHealthService } from '../src/orders/limit-matching/limit-order-matcher-health.service';
import { readLimitOrderMatchingConfig } from '../src/orders/limit-matching/limit-order-matching.config';
import { LimitOrderPriceEventPublisher } from '../src/orders/limit-matching/limit-order-price-event.publisher';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { OperatorAuditService } from '../src/operator/operator-audit.service';
import { OperatorSeasonModerationService } from '../src/operator/operator-season-moderation.service';

const PREFIX = `limit-order-phase3-${process.pid}-${Date.now()}`;
const ZERO = '0.00000000';
const FIVE_MINUTES_MS = 5 * 60_000;

const prisma = new PrismaService();
const redis = new RedisService();
const tradeBus = new NormalizedProviderTradeEventBus();
const tradeRoutes = new ProviderTradeRouteRegistry();
const health = new LimitOrderMatcherHealthService(prisma);
const publisher = new LimitOrderPriceEventPublisher(
  prisma,
  redis,
  tradeBus,
  health,
  tradeRoutes,
);
const boundary = new LimitOrderMatchBoundaryService();
const rankingStub = {
  refreshCurrentRankingAfterParticipantChange: () =>
    Promise.resolve({ skipped: false }),
};

const createdUserIds: string[] = [];
const createdParticipantIds: string[] = [];
const createdCandleIds: string[] = [];
const eventIds: string[] = [];
let seasonId: string;
let assetId: string;
let fxRateSnapshotId: string;
let operator: { userId: string; role: UserRole };
let execution: LimitOrderExecutionService;
let candles: LimitOrderCandleReconciliationService;
let poller: LimitOrderEventPollerService | null = null;
let pollerStream: LimitOrderEventStreamService | null = null;

async function main(): Promise<void> {
  requireEnvironment();
  await prisma.$connect();
  await redis.connect();
  execution = new LimitOrderExecutionService(
    prisma,
    new PortfolioValuationService(prisma),
    rankingStub as never,
  );
  candles = new LimitOrderCandleReconciliationService(
    prisma,
    new LimitOrderCandidateRepository(prisma),
    execution,
    boundary,
  );
  try {
    await createSharedMarket();
    await run(
      'boundary blocks a create while the poller holds it',
      testPollerFirstBoundary,
    );
    await run(
      'boundary blocks the poller while a create holds it',
      testCreateFirstBoundary,
    );
    await run(
      'boundary is released when the worker session dies',
      testBoundaryCrashRelease,
    );
    await run(
      'path B fills a submitted order at the limit price',
      testCandleHappyPath,
    );
    await run(
      'path B excludes the partially elapsed first candle',
      testFirstEligibleCandle,
    );
    await run(
      'path B ignores orders with no eligibility boundary',
      testNullEligibility,
    );
    await run(
      'path B rejects open, incomplete and invalid candles',
      testInvalidCandles,
    );
    await run(
      'path B skips a candle whose close is after season end',
      testCandleAfterSeasonEnd,
    );
    await run(
      'path B is idempotent across repeated sweeps',
      testProcessedCandleIdempotence,
    );
    await run(
      'path B re-runs a crashed sweep without double filling',
      testCrashedSweepRerun,
    );
    await run(
      'path A wins the race and path B skips the order',
      testPathAWinsRace,
    );
    await run(
      'path B wins the race and path A skips the order',
      testPathBWinsRace,
    );
    await run(
      'cancel and path B each win exactly one ordering',
      testCancelVsCandle,
    );
    await run(
      'exclusion and path B each win exactly one ordering',
      testExclusionVsCandle,
    );
    await run(
      'season end and path B each win exactly one ordering',
      testSeasonEndVsCandle,
    );
    await run(
      'matcher health gate fails closed on backlog and retention',
      testHealthGate,
    );
    await run(
      'throughput sweep performs no per-event asset lookup',
      testThroughput,
    );
    console.log('limit order phase3 postgres redis integration ok');
  } finally {
    if (poller) await poller.onModuleDestroy().catch(() => undefined);
    if (pollerStream)
      await pollerStream.onModuleDestroy().catch(() => undefined);
    await boundary.onModuleDestroy().catch(() => undefined);
    await cleanupDatabase().catch(() => undefined);
    const config = readLimitOrderMatchingConfig();
    await redis.delete(config.streamKey).catch(() => undefined);
    await redis.delete(config.dlqStreamKey).catch(() => undefined);
    await redis.onModuleDestroy();
    await prisma.$disconnect();
  }
}

function requireEnvironment(): void {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  assert.ok(process.env.REDIS_URL, 'REDIS_URL is required');
  assert.equal(process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED, 'true');
  assert.equal(process.env.LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED, 'true');
}

async function run(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  console.log(`ok ${name}`);
}

// ---------------------------------------------------------------------------
// Event-boundary mutex
// ---------------------------------------------------------------------------

/**
 * Poller-first interleaving. While a worker session holds the boundary, a
 * create transaction that reaches its FIRST statement must block. The wait is
 * proven from pg_locks/pg_stat_activity, not from a sleep.
 */
async function testPollerFirstBoundary(): Promise<void> {
  const lease = await boundary.acquireSession();
  const waiter = new Client({ connectionString: process.env.DATABASE_URL });
  await waiter.connect();
  try {
    await waiter.query('BEGIN');
    const blocked = waiter.query('SELECT pg_advisory_xact_lock($1, $2)', [
      LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE,
      LIMIT_ORDER_MATCH_BOUNDARY_KEY,
    ]);
    let settled = false;
    void blocked.then(() => {
      settled = true;
    });
    await waitFor(
      () => advisoryWaiterCount(),
      'create transaction waits on the boundary lock',
    );
    assert.equal(settled, false, 'create must not proceed while blocked');

    await lease.release();
    await blocked;
    await waiter.query('COMMIT');
  } finally {
    await waiter.end().catch(() => undefined);
  }
}

/**
 * Create-first interleaving. While a create transaction holds the boundary, a
 * worker session must block until the create COMMITS — which is exactly the
 * window in which the order row becomes visible to the candidate query.
 */
async function testCreateFirstBoundary(): Promise<void> {
  const creator = new Client({ connectionString: process.env.DATABASE_URL });
  await creator.connect();
  let lease: { release: () => Promise<void> } | null = null;
  try {
    await creator.query('BEGIN');
    await creator.query('SELECT pg_advisory_xact_lock($1, $2)', [
      LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE,
      LIMIT_ORDER_MATCH_BOUNDARY_KEY,
    ]);

    let acquired = false;
    const pending = boundary.acquireSession().then((value) => {
      acquired = true;
      lease = value;
      return value;
    });
    await waitFor(
      () => advisoryWaiterCount(),
      'worker waits on the boundary lock held by the create',
    );
    assert.equal(acquired, false, 'worker must not proceed before commit');

    // The commit is what both releases the boundary AND makes the order row
    // visible; the worker can never observe one without the other.
    await creator.query('COMMIT');
    lease = await pending;
    assert.equal(acquired, true);
  } finally {
    if (lease) await (lease as { release: () => Promise<void> }).release();
    await creator.end().catch(() => undefined);
  }
}

/** A dead worker session releases the boundary server-side; no lease, no TTL. */
async function testBoundaryCrashRelease(): Promise<void> {
  const worker = new Client({ connectionString: process.env.DATABASE_URL });
  // pg_terminate_backend makes the client emit 'error'; without a listener
  // that would be an unhandled event and kill the runner.
  worker.on('error', () => undefined);
  await worker.connect();
  const pidRows = await worker.query<{ pid: number }>(
    'SELECT pg_backend_pid() AS pid',
  );
  const pid = pidRows.rows[0].pid;
  await worker.query('SELECT pg_advisory_lock($1, $2)', [
    LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE,
    LIMIT_ORDER_MATCH_BOUNDARY_KEY,
  ]);
  assert.equal(await advisoryHolderCount(), 1);

  const killer = new Client({ connectionString: process.env.DATABASE_URL });
  await killer.connect();
  try {
    await killer.query('SELECT pg_terminate_backend($1)', [pid]);
    await waitFor(
      async () => (await advisoryHolderCount()) === 0,
      'terminated worker session released the boundary lock',
    );
    // A standby can take over immediately.
    const lease = await boundary.acquireSession();
    await lease.release();
  } finally {
    await killer.end().catch(() => undefined);
    await worker.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Path B
// ---------------------------------------------------------------------------

async function testCandleHappyPath(): Promise<void> {
  const snapshotsBefore = await prisma.assetPriceSnapshot.count({
    where: { assetId },
  });
  const scenario = await createSubmittedOrder({ label: 'candle-happy' });
  const candle = await createClosedCandle({
    openTime: scenario.eligibleFrom,
    low: '90.00000000',
  });

  const summary = await candles.reconcile({
    now: afterCandle(candle),
    lookbackMs: 86_400_000,
  });
  assert.equal(summary.matchedOrders >= 1, true);

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: scenario.orderId },
    select: {
      status: true,
      executedPrice: true,
      grossAmount: true,
      feeAmount: true,
      netAmount: true,
      matchingSource: true,
      triggerEventId: true,
      assetPriceSnapshotId: true,
      limitOrderCandleEvidenceId: true,
      reservationReleasedAt: true,
      candleEvidence: {
        select: {
          marketCandleId: true,
          triggerLowPrice: true,
          executionPricePolicy: true,
          interval: true,
        },
      },
    },
  });
  assert.equal(order.status, OrderStatus.executed);
  // Executed AT THE LIMIT PRICE, never at the candle low.
  assert.equal(order.executedPrice?.toFixed(8), '100.00000000');
  assert.notEqual(order.executedPrice?.toFixed(8), '90.00000000');
  assert.equal(order.grossAmount?.toFixed(8), '100.00000000');
  assert.equal(order.feeAmount?.toFixed(8), '0.10000000');
  assert.equal(order.netAmount?.toFixed(8), '100.10000000');
  assert.equal(order.matchingSource, 'closed_5m_candle');
  assert.equal(order.triggerEventId, null);
  // Path B creates NO synthetic AssetPriceSnapshot.
  assert.equal(order.assetPriceSnapshotId, null);
  assert.ok(order.limitOrderCandleEvidenceId);
  assert.equal(order.candleEvidence?.marketCandleId, candle.id);
  assert.equal(order.candleEvidence?.triggerLowPrice.toFixed(8), '90.00000000');
  assert.equal(order.candleEvidence?.executionPricePolicy, 'limit_price');
  assert.equal(order.candleEvidence?.interval, '5m');
  assert.ok(order.reservationReleasedAt);

  const wallet = await prisma.cashWallet.findFirstOrThrow({
    where: {
      seasonParticipantId: scenario.participantId,
      currencyCode: CurrencyCode.USD,
    },
    select: { balanceAmount: true, reservedAmount: true },
  });
  assert.equal(wallet.balanceAmount.toFixed(8), '899.90000000');
  assert.equal(wallet.reservedAmount.toFixed(8), ZERO);

  const position = await prisma.position.findFirstOrThrow({
    where: { seasonParticipantId: scenario.participantId, assetId },
    select: { quantity: true },
  });
  assert.equal(position.quantity.toFixed(8), '1.00000000');
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: scenario.orderId },
    }),
    1,
  );
  assert.equal(
    await prisma.equitySnapshot.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    1,
  );
  assert.equal(
    await prisma.assetPriceSnapshot.count({ where: { assetId } }),
    snapshotsBefore,
    'path B must not create an AssetPriceSnapshot',
  );
}

/**
 * An order submitted at 10:02 must NOT be filled from the 10:00-10:05 window
 * (its low may predate the order) but MUST be filled from 10:05-10:10.
 */
async function testFirstEligibleCandle(): Promise<void> {
  const base = nextWindowBase();
  const submittedAt = new Date(base.getTime() + 2 * 60_000);
  const scenario = await createSubmittedOrder({
    label: 'first-eligible',
    submittedAt,
  });
  assert.equal(
    scenario.eligibleFrom.getTime(),
    base.getTime() + FIVE_MINUTES_MS,
  );

  const partial = await createClosedCandle({
    openTime: base,
    low: '90.00000000',
  });
  await candles.reconcile({
    now: afterCandle(partial),
    lookbackMs: 86_400_000,
  });
  assert.equal(await orderStatus(scenario.orderId), OrderStatus.submitted);

  const eligible = await createClosedCandle({
    openTime: scenario.eligibleFrom,
    low: '90.00000000',
  });
  await candles.reconcile({
    now: afterCandle(eligible),
    lookbackMs: 86_400_000,
  });
  assert.equal(await orderStatus(scenario.orderId), OrderStatus.executed);
}

/** Orders predating path B keep a NULL boundary and are never swept. */
async function testNullEligibility(): Promise<void> {
  const scenario = await createSubmittedOrder({
    label: 'null-eligibility',
    candleEligible: false,
  });
  const candle = await createClosedCandle({
    openTime: nextWindowBase(),
    low: '90.00000000',
  });
  await candles.reconcile({ now: afterCandle(candle), lookbackMs: 86_400_000 });
  assert.equal(await orderStatus(scenario.orderId), OrderStatus.submitted);
}

/**
 * Non-canonical rows never fill an order.
 *
 * Two of the structural rules are enforced by the database itself
 * (market_candles_interval_check, market_candles_ohlc_bounds_check), so a
 * broken OHLC row cannot even be stored — this asserts that guarantee rather
 * than pretending such a row could reach the sweep. The rules the DB does NOT
 * enforce (open candle, wrong interval for path B) are exercised through the
 * sweep, which must leave the order submitted and write no processed row.
 */
async function testInvalidCandles(): Promise<void> {
  const scenario = await createSubmittedOrder({ label: 'invalid-candles' });
  const open = await createClosedCandle({
    openTime: scenario.eligibleFrom,
    low: '90.00000000',
    isClosed: false,
  });
  // A daily candle at the same instant: path B is 5m-only.
  // (A 1m row cannot even exist — market_candles_interval_check rejects it.)
  const wrongInterval = await createClosedCandle({
    openTime: new Date(scenario.eligibleFrom.getTime() + FIVE_MINUTES_MS),
    low: '90.00000000',
    interval: '1d',
  });

  // Structurally impossible rows are refused by the storage layer, which is
  // why the sweep can treat a stored closed 5m row as canonical.
  await assert.rejects(
    createClosedCandle({
      openTime: new Date(scenario.eligibleFrom.getTime() + 2 * FIVE_MINUTES_MS),
      low: '150.00000000',
      open: '100.00000000',
      high: '160.00000000',
      close: '155.00000000',
    }),
    /ohlc_bounds_check/u,
  );
  await assert.rejects(
    createClosedCandle({
      openTime: new Date(scenario.eligibleFrom.getTime() + 3 * FIVE_MINUTES_MS),
      low: '90.00000000',
      interval: '1m',
    }),
    /interval_check/u,
  );

  await candles.reconcile({
    now: new Date(wrongInterval.closeTime.getTime() + 60_000),
    lookbackMs: 86_400_000,
  });
  assert.equal(await orderStatus(scenario.orderId), OrderStatus.submitted);
  assert.equal(await processedCandleCount(open.id), 0);
  assert.equal(await processedCandleCount(wrongInterval.id), 0);
}

async function testCandleAfterSeasonEnd(): Promise<void> {
  const scenario = await createSubmittedOrder({ label: 'after-season-end' });
  const season = await prisma.season.findUniqueOrThrow({
    where: { id: seasonId },
    select: { endAt: true },
  });
  const openTime = alignWindow(
    new Date(season.endAt.getTime() + FIVE_MINUTES_MS),
  );
  const candle = await createClosedCandle({ openTime, low: '90.00000000' });
  await candles.reconcile({
    now: afterCandle(candle),
    lookbackMs: 86_400_000,
  });
  assert.equal(await orderStatus(scenario.orderId), OrderStatus.submitted);
}

async function testProcessedCandleIdempotence(): Promise<void> {
  const scenario = await createSubmittedOrder({ label: 'idempotent-sweep' });
  const candle = await createClosedCandle({
    openTime: scenario.eligibleFrom,
    low: '90.00000000',
  });
  const now = afterCandle(candle);
  const options = { now, lookbackMs: 86_400_000 };
  await candles.reconcile(options);
  await candles.reconcile(options);
  await candles.reconcile(options);

  assert.equal(await orderStatus(scenario.orderId), OrderStatus.executed);
  assert.equal(await processedCandleCount(candle.id), 1);
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: scenario.orderId },
    }),
    1,
  );
  assert.equal(
    await prisma.limitOrderCandleEvidence.count({
      where: { marketCandleId: candle.id },
    }),
    1,
  );
}

/**
 * Crash after filling some orders but BEFORE the processed-candle row exists:
 * the re-run must skip the already-executed order, fill the remaining one, and
 * end with exactly one processed row.
 */
async function testCrashedSweepRerun(): Promise<void> {
  const first = await createSubmittedOrder({ label: 'crash-first' });
  const second = await createSubmittedOrder({
    label: 'crash-second',
    submittedAt: first.submittedAt,
  });
  const candle = await createClosedCandle({
    openTime: first.eligibleFrom,
    low: '90.00000000',
  });

  // Simulate the partial sweep: one order executed, no processed-candle row.
  const partial = await execution.execute({
    orderId: first.orderId,
    seasonParticipantId: first.participantId,
    trigger: candleTrigger(candle),
  });
  assert.equal(partial.state, 'executed');
  assert.equal(await processedCandleCount(candle.id), 0);

  await candles.reconcile({ now: afterCandle(candle), lookbackMs: 86_400_000 });

  assert.equal(await orderStatus(first.orderId), OrderStatus.executed);
  assert.equal(await orderStatus(second.orderId), OrderStatus.executed);
  assert.equal(await processedCandleCount(candle.id), 1);
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: first.orderId },
    }),
    1,
    'the re-run must not double debit the already executed order',
  );
  // One evidence row shared by both fills.
  assert.equal(
    await prisma.limitOrderCandleEvidence.count({
      where: { marketCandleId: candle.id },
    }),
    1,
  );
}

// ---------------------------------------------------------------------------
// Path A vs path B and lifecycle races
// ---------------------------------------------------------------------------

async function testPathAWinsRace(): Promise<void> {
  const scenario = await createSubmittedOrder({ label: 'race-a-first' });
  const candle = await createClosedCandle({
    openTime: scenario.eligibleFrom,
    low: '90.00000000',
  });

  const eventId = `binance:${assetId}:race-a-first`;
  eventIds.push(eventId);
  const streamId = await publisher.publish(
    fixtureTick('race-a-first', '95.00000000'),
  );
  const live = await execution.execute({
    orderId: scenario.orderId,
    seasonParticipantId: scenario.participantId,
    trigger: {
      source: 'live_trade_event',
      streamId,
      event: buildEvent(eventId, '95.00000000'),
    },
  });
  assert.equal(live.state, 'executed');

  const skipped = await execution.execute({
    orderId: scenario.orderId,
    seasonParticipantId: scenario.participantId,
    trigger: candleTrigger(candle),
  });
  assert.equal(skipped.state, 'skipped');

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: scenario.orderId },
    select: {
      executedPrice: true,
      matchingSource: true,
      limitOrderCandleEvidenceId: true,
      assetPriceSnapshotId: true,
    },
  });
  assert.equal(order.matchingSource, 'live_trade_event');
  assert.equal(order.executedPrice?.toFixed(8), '95.00000000');
  assert.equal(order.limitOrderCandleEvidenceId, null);
  assert.ok(order.assetPriceSnapshotId);
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: scenario.orderId },
    }),
    1,
  );
}

async function testPathBWinsRace(): Promise<void> {
  const scenario = await createSubmittedOrder({ label: 'race-b-first' });
  const candle = await createClosedCandle({
    openTime: scenario.eligibleFrom,
    low: '90.00000000',
  });
  const filled = await execution.execute({
    orderId: scenario.orderId,
    seasonParticipantId: scenario.participantId,
    trigger: candleTrigger(candle),
  });
  assert.equal(filled.state, 'executed');

  const eventId = `binance:${assetId}:race-b-first`;
  eventIds.push(eventId);
  const streamId = await publisher.publish(
    fixtureTick('race-b-first', '95.00000000'),
  );
  const skipped = await execution.execute({
    orderId: scenario.orderId,
    seasonParticipantId: scenario.participantId,
    trigger: {
      source: 'live_trade_event',
      streamId,
      event: buildEvent(eventId, '95.00000000'),
    },
  });
  assert.equal(skipped.state, 'skipped');

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: scenario.orderId },
    select: {
      executedPrice: true,
      matchingSource: true,
      limitOrderCandleEvidenceId: true,
      assetPriceSnapshotId: true,
      triggerEventId: true,
    },
  });
  assert.equal(order.matchingSource, 'closed_5m_candle');
  assert.equal(order.executedPrice?.toFixed(8), '100.00000000');
  assert.ok(order.limitOrderCandleEvidenceId);
  assert.equal(order.assetPriceSnapshotId, null);
  assert.equal(order.triggerEventId, null);
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: scenario.orderId },
    }),
    1,
  );
}

async function testCancelVsCandle(): Promise<void> {
  const cancelService = buildCancelService();

  // Cancel first: path B must skip and the reservation is released once.
  const cancelFirst = await createSubmittedOrder({ label: 'cancel-first' });
  const candleA = await createClosedCandle({
    openTime: cancelFirst.eligibleFrom,
    low: '90.00000000',
  });
  await cancelService.cancelOwnedLimitBuyOrder({
    userId: cancelFirst.userId,
    orderId: cancelFirst.orderId,
    canceledAt: new Date(),
  });
  const skipped = await execution.execute({
    orderId: cancelFirst.orderId,
    seasonParticipantId: cancelFirst.participantId,
    trigger: candleTrigger(candleA),
  });
  assert.equal(skipped.state, 'skipped');
  await assertReservationReleasedOnce(cancelFirst, { executed: false });

  // Path B first: cancel must fail and the reservation is consumed once.
  const fillFirst = await createSubmittedOrder({ label: 'cancel-second' });
  const candleB = await createClosedCandle({
    openTime: fillFirst.eligibleFrom,
    low: '90.00000000',
  });
  await execution.execute({
    orderId: fillFirst.orderId,
    seasonParticipantId: fillFirst.participantId,
    trigger: candleTrigger(candleB),
  });
  await assert.rejects(
    cancelService.cancelOwnedLimitBuyOrder({
      userId: fillFirst.userId,
      orderId: fillFirst.orderId,
      canceledAt: new Date(),
    }),
  );
  await assertReservationReleasedOnce(fillFirst, { executed: true });
}

async function testExclusionVsCandle(): Promise<void> {
  const moderation = buildModerationService();

  const excludedFirst = await createSubmittedOrder({
    label: 'exclusion-first',
  });
  const candleA = await createClosedCandle({
    openTime: excludedFirst.eligibleFrom,
    low: '90.00000000',
  });
  await moderation.excludeParticipant(
    operator as never,
    seasonId,
    excludedFirst.participantId,
    { reason: 'phase3 exclusion' },
  );
  const skipped = await execution.execute({
    orderId: excludedFirst.orderId,
    seasonParticipantId: excludedFirst.participantId,
    trigger: candleTrigger(candleA),
  });
  assert.equal(skipped.state, 'skipped');
  assert.equal(await orderStatus(excludedFirst.orderId), OrderStatus.canceled);

  const filledFirst = await createSubmittedOrder({ label: 'exclusion-second' });
  const candleB = await createClosedCandle({
    openTime: filledFirst.eligibleFrom,
    low: '90.00000000',
  });
  await execution.execute({
    orderId: filledFirst.orderId,
    seasonParticipantId: filledFirst.participantId,
    trigger: candleTrigger(candleB),
  });
  await moderation.excludeParticipant(
    operator as never,
    seasonId,
    filledFirst.participantId,
    { reason: 'phase3 exclusion after fill' },
  );
  assert.equal(await orderStatus(filledFirst.orderId), OrderStatus.executed);
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: filledFirst.orderId },
    }),
    1,
  );
}

async function testSeasonEndVsCandle(): Promise<void> {
  const cancelService = buildCancelService();
  const endingSeasonId = await createSeason({
    label: 'candle-season-end',
    endsInMs: 3_600_000,
  });

  const filledFirst = await createSubmittedOrder({
    label: 'season-end-second',
    seasonIdOverride: endingSeasonId,
  });
  const candle = await createClosedCandle({
    openTime: filledFirst.eligibleFrom,
    low: '90.00000000',
  });
  await execution.execute({
    orderId: filledFirst.orderId,
    seasonParticipantId: filledFirst.participantId,
    trigger: candleTrigger(candle),
  });

  const cleanupFirst = await createSubmittedOrder({
    label: 'season-end-first',
    seasonIdOverride: endingSeasonId,
  });
  await prisma.season.update({
    where: { id: endingSeasonId },
    data: { status: SeasonStatus.ended, endAt: new Date() },
  });
  await cancelService.cleanupEndedSeasonLimitReservations({ now: new Date() });

  assert.equal(await orderStatus(cleanupFirst.orderId), OrderStatus.canceled);
  const afterCleanup = await execution.execute({
    orderId: cleanupFirst.orderId,
    seasonParticipantId: cleanupFirst.participantId,
    trigger: candleTrigger(candle),
  });
  assert.equal(afterCleanup.state, 'skipped');
  // A fill that committed before the season ended is untouched.
  assert.equal(await orderStatus(filledFirst.orderId), OrderStatus.executed);

  // No retroactive fill from a candle confirmed after the season ended.
  const lateCandle = await createClosedCandle({
    openTime: alignWindow(new Date(Date.now() + FIVE_MINUTES_MS)),
    low: '90.00000000',
  });
  const lateOrder = await createSubmittedOrder({
    label: 'season-end-late',
    seasonIdOverride: endingSeasonId,
  });
  const late = await execution.execute({
    orderId: lateOrder.orderId,
    seasonParticipantId: lateOrder.participantId,
    trigger: candleTrigger(lateCandle),
  });
  assert.equal(late.state, 'skipped');
}

// ---------------------------------------------------------------------------
// Health gate and throughput
// ---------------------------------------------------------------------------

async function testHealthGate(): Promise<void> {
  const gate = new LimitOrderMatcherHealthService(prisma);
  const now = new Date();
  const healthy = {
    activeLeaderInstance: 'fixture',
    lastRedisRead: now.toISOString(),
    lastSuccessfulEvent: '1-0',
    lastAcknowledgedEvent: '1-0',
    lastAcknowledgedAt: now.toISOString(),
    pendingCount: 0,
    oldestPendingAgeMs: null,
    consumerLag: 0,
    streamFirstId: '1-0',
    streamLastId: '1-0',
    streamLength: 1,
    retentionHeadroomRatio: 0.99,
    processedEvents: null,
  };
  assert.equal(gate.evaluateHeartbeat(healthy, now), null);
  assert.equal(
    gate.evaluateHeartbeat({ ...healthy, consumerLag: 1_000_000 }, now)?.code,
    'LIMIT_ORDER_MATCHER_LAG_EXCEEDED',
  );
  assert.equal(
    gate.evaluateHeartbeat(
      { ...healthy, pendingCount: 1_000_000, oldestPendingAgeMs: 10 },
      now,
    )?.code,
    'LIMIT_ORDER_MATCHER_PENDING_EXCEEDED',
  );
  assert.equal(
    gate.evaluateHeartbeat(
      {
        ...healthy,
        pendingCount: 1,
        oldestPendingAgeMs: 10,
        lastAcknowledgedAt: new Date(now.getTime() - 86_400_000).toISOString(),
      },
      now,
    )?.code,
    'LIMIT_ORDER_MATCHER_ACK_STALE',
  );
  assert.equal(
    gate.evaluateHeartbeat({ ...healthy, retentionHeadroomRatio: 0 }, now)
      ?.code,
    'LIMIT_ORDER_EVENT_RETENTION_HEADROOM_LOW',
  );

  // The processed-event growth aggregate is real SQL against the real table.
  const stats = await gate.collectProcessedEventStats();
  assert.ok(Number.isSafeInteger(stats.rowCount));
  assert.ok(stats.tableBytes === null || stats.tableBytes >= 0);
}

/**
 * Synthetic multi-asset sweep with no external provider. It measures the
 * publisher path and, critically, proves that a burst of trades across many
 * assets performs at most one asset lookup per asset per cache window — never
 * one per event.
 */
async function testThroughput(): Promise<void> {
  const assetCount = 50;
  const eventsPerAsset = 20;
  const assets = await createThroughputAssets(assetCount);
  // Only a few assets carry an open order; most have none, which is the
  // realistic shape and the cheap path that must stay cheap.
  const withOrders = assets.slice(0, 5);
  for (const [index, asset] of withOrders.entries()) {
    await createSubmittedOrder({
      label: `throughput-${index}`,
      assetIdOverride: asset.id,
    });
  }

  let assetQueries = 0;
  const countingPrisma = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === 'asset') {
        return {
          findUnique: (args: unknown) => {
            assetQueries += 1;
            return (
              target as unknown as {
                asset: { findUnique: (value: unknown) => Promise<unknown> };
              }
            ).asset.findUnique(args);
          },
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as unknown as PrismaService;

  const countingPublisher = new LimitOrderPriceEventPublisher(
    countingPrisma,
    redis,
    new NormalizedProviderTradeEventBus(),
    health,
    tradeRoutes,
  );

  // Register the assets on a canonical connection generation, exactly as the
  // live-candle supervisor does when it builds its subscription.
  const generation = `throughput-${randomUUID()}`;
  tradeRoutes.claimProvider('binance', 'live_candle_supervisor');
  tradeRoutes.beginConnection({
    provider: 'binance',
    source: 'live_candle_supervisor',
    generation,
  });
  tradeRoutes.markConnectionOpen({
    provider: 'binance',
    generation,
    at: Date.now(),
  });
  tradeRoutes.registerSubscriptionTargets({
    provider: 'binance',
    generation,
    assets: assets.map((asset) => ({
      assetId: asset.id,
      symbol: asset.symbol,
      providerSymbol: asset.symbol,
      market: 'BINANCE',
      assetType: AssetType.crypto,
      settlementCurrency: CurrencyCode.USD,
      sourceName: 'binance_spot_ws_trade',
    })),
  });
  tradeRoutes.markSubscriptionsActive({ provider: 'binance', generation });

  const startedAt = Date.now();
  const latencies: number[] = [];
  for (let round = 0; round < eventsPerAsset; round += 1) {
    for (const asset of assets) {
      const at = Date.now();
      const eventId = `binance:${asset.id}:throughput-${round}`;
      eventIds.push(eventId);
      await countingPublisher.publish({
        provider: 'binance',
        providerEventId: `throughput-${round}`,
        providerSequence: String(round),
        providerConnectionId: generation,
        assetId: asset.id,
        symbol: asset.symbol,
        providerSymbol: asset.symbol,
        price: '150.00000000',
        currencyCode: CurrencyCode.USD,
        providerEventAt: new Date(at).toISOString(),
        receivedAt: new Date(at).toISOString(),
        sourceName: 'binance_spot_ws_trade',
        marketSessionCode: null,
        eventType: 'trade',
        asset: {
          assetId: asset.id,
          symbol: asset.symbol,
          market: 'BINANCE',
          assetType: AssetType.crypto,
          settlementCurrency: CurrencyCode.USD,
          generation,
        },
      });
      latencies.push(Date.now() - at);
    }
  }
  const totalEvents = assetCount * eventsPerAsset;
  const elapsedMs = Math.max(1, Date.now() - startedAt);
  latencies.sort((left, right) => left - right);

  console.log(
    JSON.stringify({
      event: 'limit_order_publisher_throughput',
      assetCount,
      totalEvents,
      elapsedMs,
      eventsPerSecond: Math.round((totalEvents / elapsedMs) * 1000),
      xaddLatencyMsAvg:
        Math.round(
          (latencies.reduce((sum, value) => sum + value, 0) / totalEvents) *
            100,
        ) / 100,
      xaddLatencyMsP95: latencies[Math.floor(totalEvents * 0.95)] ?? 0,
      xaddLatencyMsMax: latencies[totalEvents - 1] ?? 0,
      assetDatabaseQueries: assetQueries,
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1_048_576),
    }),
  );

  // The whole point: carried metadata means ZERO per-event asset lookups.
  assert.equal(
    assetQueries,
    0,
    'the publisher must not query assets per trade event',
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function createSharedMarket(): Promise<void> {
  seasonId = await createSeason({ label: 'shared', endsInMs: 86_400_000 });
  const asset = await prisma.asset.create({
    data: {
      symbol: PREFIX.slice(0, 32),
      name: PREFIX,
      market: 'BINANCE',
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.USD,
      priceCurrency: CurrencyCode.USD,
      settlementCurrency: CurrencyCode.USD,
      isActive: true,
    },
    select: { id: true },
  });
  assetId = asset.id;
  const now = await databaseNow();
  const fx = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      rate: '1300.00000000',
      sourceType: FxRateSourceType.provider_api,
      sourceName: 'exchange_rate_api',
      sourceTimestamp: now,
      effectiveAt: now,
      capturedAt: now,
    },
    select: { id: true },
  });
  fxRateSnapshotId = fx.id;
  // Path B creates NO price snapshot of its own (the candle IS the evidence),
  // so the ordinary market-price pipeline must already have one for the equity
  // valuation that every fill records. Production satisfies this through
  // provider ingestion; the fixture seeds one row to match.
  await prisma.assetPriceSnapshot.create({
    data: {
      assetId,
      price: '100.00000000',
      currencyCode: CurrencyCode.USD,
      sourceType: AssetPriceSourceType.provider_api,
      sourceName: 'binance_spot_ws_trade',
      sourceTimestamp: now,
      effectiveAt: now,
      capturedAt: now,
    },
  });
  const operatorUser = await prisma.user.create({
    data: {
      email: `${PREFIX}-operator@example.com`,
      passwordHash: 'integration-test-only',
      nickname: `p3-op-${process.pid}-${randomUUID()}`.slice(0, 40),
      role: UserRole.operator,
    },
    select: { id: true, role: true },
  });
  createdUserIds.push(operatorUser.id);
  operator = { userId: operatorUser.id, role: operatorUser.role };
}

async function createSeason(input: {
  label: string;
  endsInMs: number;
}): Promise<string> {
  const now = await databaseNow();
  const season = await prisma.season.create({
    data: {
      name: `${PREFIX}-${input.label}`,
      status: SeasonStatus.active,
      startAt: new Date(now.getTime() - 12 * 3_600_000),
      endAt: new Date(now.getTime() + input.endsInMs),
      initialCapitalKrw: '1300000.00000000',
      tradeFeeRate: '0.050000',
      fxFeeRate: '0.001000',
    },
    select: { id: true },
  });
  return season.id;
}

type Scenario = {
  orderId: string;
  participantId: string;
  userId: string;
  walletId: string;
  submittedAt: Date;
  eligibleFrom: Date;
};

async function createSubmittedOrder(input: {
  label: string;
  submittedAt?: Date;
  candleEligible?: boolean;
  seasonIdOverride?: string;
  assetIdOverride?: string;
}): Promise<Scenario> {
  // Default to an exact 5-minute boundary from the allocator so eligibleFrom
  // equals submittedAt and every scenario owns a distinct candle window.
  const submittedAt = input.submittedAt ?? nextWindowBase();
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${input.label}@example.com`,
      passwordHash: 'integration-test-only',
      nickname: `${input.label}-${process.pid}-${randomUUID()}`.slice(0, 40),
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  const participant = await prisma.seasonParticipant.create({
    data: {
      seasonId: input.seasonIdOverride ?? seasonId,
      userId: user.id,
      joinedAt: submittedAt,
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: '1300000.00000000',
      totalAssetKrw: '1300000.00000000',
      totalReturnRate: ZERO,
      maxDrawdown: ZERO,
    },
    select: { id: true },
  });
  createdParticipantIds.push(participant.id);
  const wallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: CurrencyCode.USD,
      balanceAmount: '1000.00000000',
      reservedAmount: '100.10000000',
    },
    select: { id: true },
  });
  await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: ZERO,
      reservedAmount: ZERO,
    },
  });
  const eligibleFrom = calculateCandleMatchingEligibleFrom(submittedAt);
  const orderId = randomUUID();
  await prisma.order.create({
    data: {
      id: orderId,
      seasonParticipantId: participant.id,
      assetId: input.assetIdOverride ?? assetId,
      side: OrderSide.buy,
      orderType: OrderType.limit,
      status: OrderStatus.submitted,
      quantity: '1.00000000',
      limitPrice: '100.00000000',
      currencyCode: CurrencyCode.USD,
      reservedAmount: '100.10000000',
      reservationFeeRate: '0.001000',
      matchingActivatedAt: submittedAt,
      matchingActivationStreamId: await redis.lastStreamId(
        readLimitOrderMatchingConfig().streamKey,
      ),
      candleMatchingEligibleFrom:
        input.candleEligible === false ? null : eligibleFrom,
      idempotencyKey: `${PREFIX}-${input.label}`,
      requestHash: `${PREFIX}-${input.label}`,
      submittedAt,
      createdAt: submittedAt,
      updatedAt: submittedAt,
    },
  });
  return {
    orderId,
    participantId: participant.id,
    userId: user.id,
    walletId: wallet.id,
    submittedAt,
    eligibleFrom,
  };
}

async function createClosedCandle(input: {
  openTime: Date;
  low: string;
  open?: string;
  high?: string;
  close?: string;
  isClosed?: boolean;
  interval?: string;
  assetIdOverride?: string;
}): Promise<{
  id: string;
  assetId: string;
  interval: string;
  openTime: Date;
  closeTime: Date;
  low: string;
  sourceProvider: string;
  sourceUpdatedAt: Date;
}> {
  const closeTime = new Date(input.openTime.getTime() + FIVE_MINUTES_MS);
  const created = await prisma.marketCandle.create({
    data: {
      assetId: input.assetIdOverride ?? assetId,
      interval: input.interval ?? '5m',
      openTime: input.openTime,
      closeTime,
      open: input.open ?? '100.00000000',
      high: input.high ?? '110.00000000',
      low: input.low,
      close: input.close ?? '105.00000000',
      volume: '10.00000000',
      amount: '1000.00000000',
      isClosed: input.isClosed ?? true,
      sourceProvider: 'binance_spot_ws_5m_kline',
      sourceUpdatedAt: closeTime,
    },
    select: { id: true },
  });
  createdCandleIds.push(created.id);
  return {
    id: created.id,
    assetId: input.assetIdOverride ?? assetId,
    interval: input.interval ?? '5m',
    openTime: input.openTime,
    closeTime,
    low: input.low,
    sourceProvider: 'binance_spot_ws_5m_kline',
    sourceUpdatedAt: closeTime,
  };
}

async function createThroughputAssets(
  count: number,
): Promise<Array<{ id: string; symbol: string }>> {
  const created: Array<{ id: string; symbol: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const symbol = `TP${index}${PREFIX.slice(-8)}`.slice(0, 32);
    const asset = await prisma.asset.create({
      data: {
        symbol,
        name: symbol,
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
        priceCurrency: CurrencyCode.USD,
        settlementCurrency: CurrencyCode.USD,
        isActive: true,
      },
      select: { id: true },
    });
    created.push({ id: asset.id, symbol });
  }
  throughputAssetIds.push(...created.map((asset) => asset.id));
  return created;
}

const throughputAssetIds: string[] = [];

function candleTrigger(candle: {
  id: string;
  assetId: string;
  interval: string;
  openTime: Date;
  closeTime: Date;
  low: string;
  sourceProvider: string;
  sourceUpdatedAt: Date;
}) {
  return {
    source: 'closed_5m_candle' as const,
    candle: {
      id: candle.id,
      assetId: candle.assetId,
      interval: candle.interval,
      openTime: candle.openTime,
      closeTime: candle.closeTime,
      low: new Prisma.Decimal(candle.low),
      sourceProvider: candle.sourceProvider,
      sourceUpdatedAt: candle.sourceUpdatedAt,
      finalizedAt: candle.sourceUpdatedAt,
    },
  };
}

function fixtureTick(providerEventId: string, price: string) {
  const at = new Date().toISOString();
  return {
    provider: 'binance' as const,
    providerEventId,
    providerSequence: providerEventId,
    providerConnectionId: 'phase3-fixture',
    assetId,
    symbol: 'BTCUSDT',
    providerSymbol: 'BTCUSDT',
    price,
    currencyCode: CurrencyCode.USD,
    providerEventAt: at,
    receivedAt: at,
    sourceName: 'binance_spot_ws_trade',
    marketSessionCode: null,
    eventType: 'trade' as const,
  };
}

function buildEvent(eventId: string, price: string) {
  const at = new Date().toISOString();
  return {
    schemaVersion: 1 as const,
    eventId,
    eventType: 'trade' as const,
    provider: 'binance' as const,
    assetId,
    symbol: 'BTCUSDT',
    market: 'BINANCE',
    assetType: AssetType.crypto,
    currencyCode: CurrencyCode.USD,
    price,
    providerEventAt: at,
    receivedAt: at,
    publishedAt: at,
    providerConnectionId: 'phase3-fixture',
    providerSequence: eventId,
    sourceName: 'binance_spot_ws_trade',
    marketSessionCode: null,
  };
}

function buildCancelService(): LimitOrderCancelService {
  return new LimitOrderCancelService(prisma, new OrderReservationService());
}

function buildModerationService(): OperatorSeasonModerationService {
  return new OperatorSeasonModerationService(
    prisma,
    new OperatorAuditService(prisma),
    buildCancelService(),
  );
}

async function assertReservationReleasedOnce(
  scenario: Scenario,
  expectation: { executed: boolean },
): Promise<void> {
  const wallet = await prisma.cashWallet.findUniqueOrThrow({
    where: { id: scenario.walletId },
    select: { balanceAmount: true, reservedAmount: true },
  });
  assert.equal(wallet.reservedAmount.toFixed(8), ZERO);
  assert.equal(
    wallet.balanceAmount.toFixed(8),
    expectation.executed ? '899.90000000' : '1000.00000000',
  );
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: scenario.orderId },
    }),
    expectation.executed ? 1 : 0,
  );
}

async function orderStatus(orderId: string): Promise<OrderStatus> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true },
  });
  return order.status;
}

async function processedCandleCount(marketCandleId: string): Promise<number> {
  return prisma.limitOrderProcessedCandle.count({ where: { marketCandleId } });
}

function alignWindow(value: Date): Date {
  return new Date(
    Math.floor(value.getTime() / FIVE_MINUTES_MS) * FIVE_MINUTES_MS,
  );
}

/**
 * Monotonic window allocator. Each scenario gets its own 5-minute windows
 * (four apart, so a test can create three consecutive candles) — MarketCandle
 * is unique on (assetId, interval, openTime), and reusing a window across
 * tests would collide instead of testing anything.
 */
let windowCursor = alignWindow(new Date(Date.now() - 6 * 3_600_000));

function nextWindowBase(): Date {
  windowCursor = new Date(windowCursor.getTime() + FIVE_MINUTES_MS * 4);
  return windowCursor;
}

function afterCandle(candle: { closeTime: Date }): Date {
  return new Date(candle.closeTime.getTime() + 60_000);
}

async function advisoryWaiterCount(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM pg_locks
    WHERE "locktype" = 'advisory'
      AND "classid" = ${LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE}
      AND "objid" = ${LIMIT_ORDER_MATCH_BOUNDARY_KEY}
      AND "granted" = false
  `;
  return Number(rows[0]?.count ?? 0) > 0;
}

async function advisoryHolderCount(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM pg_locks
    WHERE "locktype" = 'advisory'
      AND "classid" = ${LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE}
      AND "objid" = ${LIMIT_ORDER_MATCH_BOUNDARY_KEY}
      AND "granted" = true
  `;
  return Number(rows[0]?.count ?? 0);
}

async function databaseNow(): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
  `;
  return rows[0].now;
}

/**
 * Polls a CONDITION, never a duration. Every race in this file is decided by
 * an explicit lock/transaction barrier; this only bounds how long we wait for
 * PostgreSQL to publish an already-decided state.
 */
async function waitFor(
  condition: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function cleanupDatabase(): Promise<void> {
  const allAssetIds = [assetId, ...throughputAssetIds].filter(Boolean);
  await prisma.operatorAuditLog
    .deleteMany({ where: { actorUserId: operator?.userId } })
    .catch(() => undefined);
  await prisma.limitOrderProcessedEvent.deleteMany({
    where: { eventId: { in: eventIds } },
  });
  await prisma.limitOrderProcessedCandle.deleteMany({
    where: { marketCandleId: { in: createdCandleIds } },
  });
  await prisma.seasonRanking.deleteMany({ where: { seasonId } });
  await prisma.equitySnapshot.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.walletTransaction.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.order.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.limitOrderCandleEvidence.deleteMany({
    where: { marketCandleId: { in: createdCandleIds } },
  });
  await prisma.marketCandle.deleteMany({
    where: { id: { in: createdCandleIds } },
  });
  await prisma.position.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.assetPriceSnapshot.deleteMany({
    where: { assetId: { in: allAssetIds } },
  });
  await prisma.fxRateSnapshot.deleteMany({ where: { id: fxRateSnapshotId } });
  await prisma.seasonParticipant.deleteMany({
    where: { id: { in: createdParticipantIds } },
  });
  await prisma.asset.deleteMany({ where: { id: { in: allAssetIds } } });
  await prisma.season.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
