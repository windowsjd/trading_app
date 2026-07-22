/**
 * Path-B DURABLE SCAN runner (real PostgreSQL).
 *
 * The defect this exists to prevent: path B used to scan
 * `now - lookbackMs .. now` on every tick. A candle that stayed unprocessed
 * longer than the lookback — a provider outage, a repeatedly failing
 * dependency, a scheduler stopped over a weekend — simply fell out of the
 * window and was NEVER examined again. The safety net silently developed a
 * hole exactly in the situations it exists for.
 *
 * Everything below is asserted against real rows: the checkpoint watermark,
 * the deferred queue, the retention-gap alarm and the health gate. Nothing
 * sleeps to produce an ordering.
 *
 * REQUIRES A DISPOSABLE DATABASE. Like the other opt-in runners in this
 * directory it creates and deletes its own fixtures, and it additionally
 * resets the (rebuildable) path-B checkpoint row for the 5m scope.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  SeasonStatus,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { LimitOrderCandidateRepository } from '../src/orders/limit-matching/limit-order-candidate.repository';
import { calculateCandleMatchingEligibleFrom } from '../src/orders/limit-matching/limit-order-candle-eligibility';
import { LimitOrderCandleReconciliationHealthService } from '../src/orders/limit-matching/limit-order-candle-reconciliation-health.service';
import { LimitOrderCandleReconciliationService } from '../src/orders/limit-matching/limit-order-candle-reconciliation.service';
import { readLimitOrderCandleReconciliationConfig } from '../src/orders/limit-matching/limit-order-candle-reconciliation.config';
import { LimitOrderExecutionService } from '../src/orders/limit-matching/limit-order-execution.service';
import { LimitOrderMatchBoundaryService } from '../src/orders/limit-matching/limit-order-match-boundary.service';
import {
  LIMIT_ORDER_RECONCILIATION_SCOPE,
  LimitOrderReconciliationCheckpointRepository,
} from '../src/orders/limit-matching/limit-order-reconciliation-checkpoint.repository';

const PREFIX = `limit-order-ckpt-${process.pid}-${Date.now()}`;
const ZERO = '0.00000000';
const FIVE_MINUTES_MS = 5 * 60_000;

const prisma = new PrismaService();
const boundary = new LimitOrderMatchBoundaryService();
const checkpoints = new LimitOrderReconciliationCheckpointRepository(prisma);
const rankingStub = {
  refreshCurrentRankingAfterParticipantChange: () =>
    Promise.resolve({ skipped: false }),
};

const createdUserIds: string[] = [];
const createdParticipantIds: string[] = [];
const createdCandleIds: string[] = [];
let seasonId: string;
let assetId: string;
let fxRateSnapshotId: string;
let execution: LimitOrderExecutionService;
let sweep: LimitOrderCandleReconciliationService;
let health: LimitOrderCandleReconciliationHealthService;

async function main(): Promise<void> {
  requireEnvironment();
  await prisma.$connect();
  execution = new LimitOrderExecutionService(
    prisma,
    new PortfolioValuationService(prisma),
    rankingStub as never,
  );
  sweep = newSweep();
  health = new LimitOrderCandleReconciliationHealthService(checkpoints);

  try {
    await resetCheckpointState();
    await createSharedMarket();

    await run(
      'bootstrap anchors the watermark before the earliest activated order',
      testBootstrapAnchor,
    );
    await run(
      'a candle older than the lookback window is still processed',
      testCandleOlderThanLookbackIsProcessed,
    );
    await run(
      'a restarted process resumes from the durable checkpoint',
      testCheckpointResumeAcrossRestart,
    );
    await run(
      'a deferred candle does not block later candles',
      testDeferredCandleDoesNotBlockLaterCandles,
    );
    await run(
      'retrying a deferred candle never double fills the order',
      testRetryDoesNotDoubleFill,
    );
    await run(
      'retention passing the watermark is detected as a gap',
      testRetentionGapDetected,
    );
    await run(
      'a gap fails new quotes/creates closed and stays sticky',
      testGapFailsClosed,
    );
    console.log('limit order candle checkpoint integration ok');
  } finally {
    await cleanupDatabase().catch((error: unknown) => {
      console.error('cleanup failed', error);
    });
    await boundary.onModuleDestroy();
    await prisma.$disconnect();
  }
}

function newSweep(): LimitOrderCandleReconciliationService {
  // A fresh instance is what a process restart actually produces: no in-memory
  // cursor survives, only the durable checkpoint row.
  return new LimitOrderCandleReconciliationService(
    prisma,
    new LimitOrderCandidateRepository(prisma),
    execution,
    boundary,
    checkpoints,
  );
}

function requireEnvironment(): void {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be configured.');
  assert.equal(process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED, 'true');
  assert.equal(process.env.LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED, 'true');
  const config = readLimitOrderCandleReconciliationConfig();
  // The whole point of the suite: candles far OLDER than the lookback must
  // still be processed, so the lookback has to be genuinely short here.
  assert.ok(
    config.lookbackMs <= 3_600_000,
    'the runner needs a short lookback to prove the sliding window is gone',
  );
}

async function run(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  console.log(`ok ${name}`);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * With an activated path-B order present, the first run must anchor its
 * position BEFORE that order's first eligible window — otherwise the very
 * first sweep would skip the window the order was created for.
 */
async function testBootstrapAnchor(): Promise<void> {
  assert.equal(await checkpoints.find(), null, 'no checkpoint may exist yet');
  const scenario = await createSubmittedOrder({ label: 'bootstrap' });

  await sweep.reconcile({ now: new Date() });

  const checkpoint = await checkpoints.find();
  assert.ok(checkpoint, 'the first run must create a durable checkpoint');
  assert.equal(checkpoint.scope, LIMIT_ORDER_RECONCILIATION_SCOPE);
  assert.ok(checkpoint.lastSuccessfulRunAt, 'the run must record a heartbeat');
  // The stored position may have advanced past already-swept windows, but the
  // BOOTSTRAP anchor must not have started after the order's first window.
  const bootstrapAnchor = await earliestActivatedEligibleFrom();
  assert.ok(bootstrapAnchor);
  assert.ok(
    bootstrapAnchor.getTime() <= scenario.eligibleFrom.getTime(),
    'bootstrap must reach back to the earliest activated order',
  );
}

// ---------------------------------------------------------------------------
// The regression: no sliding-window loss
// ---------------------------------------------------------------------------

/**
 * THE regression test.
 *
 * A candle fails while its asset is inactive, so it lands in the durable retry
 * queue and the watermark moves past it. The failure then lasts LONGER than
 * the configured lookback window. Under the old implementation the candle was
 * by now outside `now - lookbackMs` and could never be seen again. It must
 * still be picked up and filled.
 */
async function testCandleOlderThanLookbackIsProcessed(): Promise<void> {
  const config = readLimitOrderCandleReconciliationConfig();
  // A dedicated asset with NO price snapshot. Every fill records an equity
  // valuation, so a missing valuation price is a real, transient, per-asset
  // failure — exactly the class the deferral path exists for — and it does not
  // disturb any other scenario's asset.
  const staleAsset = await createAsset('stale', { withPriceSnapshot: false });
  const scenario = await createSubmittedOrder({
    label: 'stale-retry',
    assetIdOverride: staleAsset,
  });
  const candle = await createClosedCandle({
    openTime: scenario.eligibleFrom,
    low: '90.00000000',
    assetIdOverride: staleAsset,
  });

  const firstNow = afterCandle(candle);
  const deferredSummary = await sweep.reconcile({ now: firstNow });
  assert.equal(
    deferredSummary.deferredCandles >= 1,
    true,
    'the failing candle must be deferred, not dropped',
  );
  const queued = await prisma.limitOrderDeferredCandle.findUnique({
    where: { marketCandleId: candle.id },
  });
  assert.ok(queued, 'the candle must be durably queued for retry');
  assert.equal(queued.status, 'deferred');
  assert.equal(
    await prisma.limitOrderProcessedCandle.count({
      where: { marketCandleId: candle.id },
    }),
    0,
    'a deferred candle must NOT be recorded as processed',
  );

  // 2. The outage outlasts the lookback window. The valuation source recovers
  //    long after the old sliding window would have moved past the candle.
  await seedPriceSnapshot(staleAsset);
  const laterNow = new Date(
    firstNow.getTime() + config.lookbackMs + 10 * 60_000,
  );
  assert.ok(
    candle.openTime.getTime() < laterNow.getTime() - config.lookbackMs,
    'the candle must now be OUTSIDE the old sliding lookback window',
  );

  const recovered = await sweep.reconcile({ now: laterNow });
  assert.equal(
    recovered.recoveredCandles >= 1,
    true,
    'the candle must be recovered from the durable queue',
  );
  assert.equal(
    await prisma.limitOrderDeferredCandle.count({
      where: { marketCandleId: candle.id },
    }),
    0,
    'a recovered candle must leave the retry queue',
  );
  const processed = await prisma.limitOrderProcessedCandle.findUnique({
    where: { marketCandleId: candle.id },
  });
  assert.ok(processed, 'the recovered candle must be recorded as processed');

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: scenario.orderId },
  });
  assert.equal(order.status, OrderStatus.executed);
  assert.equal(order.matchingSource, 'closed_5m_candle');
  // Path B always fills AT THE LIMIT PRICE; a 5m low proves the limit was
  // touched, never the price a fill could have been obtained at.
  assert.equal(order.executedPrice?.equals('100.00000000'), true);
}

/**
 * A restart must resume from the DURABLE position: a brand new service
 * instance may not re-process an already-processed candle, and may not skip an
 * unprocessed one.
 */
async function testCheckpointResumeAcrossRestart(): Promise<void> {
  const before = await checkpoints.find();
  assert.ok(before?.watermark, 'a watermark must exist by now');

  const scenario = await createSubmittedOrder({ label: 'resume' });
  const candle = await createClosedCandle({
    openTime: scenario.eligibleFrom,
    low: '90.00000000',
  });

  // A different instance, with no in-memory state whatsoever.
  const restarted = newSweep();
  const summary = await restarted.reconcile({ now: afterCandle(candle) });
  assert.equal(summary.matchedOrders >= 1, true);

  const processedCount = await prisma.limitOrderProcessedCandle.count({
    where: { marketCandleId: candle.id },
  });
  assert.equal(processedCount, 1);

  // A second run of yet another instance must be a no-op for that candle.
  const again = newSweep();
  const repeat = await again.reconcile({ now: afterCandle(candle) });
  assert.equal(repeat.matchedOrders, 0, 'a resumed sweep must not re-fill');
  assert.equal(
    await prisma.limitOrderProcessedCandle.count({
      where: { marketCandleId: candle.id },
    }),
    1,
  );

  const after = await checkpoints.find();
  assert.ok(after?.watermark);
  assert.ok(
    after.watermark.openTime.getTime() >= before.watermark.openTime.getTime(),
    'the watermark must never move backwards',
  );
}

/**
 * Head-of-line blocking check. A deferred candle must not stop the candles
 * after it: the watermark passes it BECAUSE it is durably queued.
 */
async function testDeferredCandleDoesNotBlockLaterCandles(): Promise<void> {
  // The blocked asset has no valuation price, so its candle defers; the
  // healthy asset's LATER window must still go through.
  const otherAsset = await createAsset('blocked', { withPriceSnapshot: false });
  const blockedOrder = await createSubmittedOrder({
    label: 'blocked-asset',
    assetIdOverride: otherAsset,
  });
  const blockedCandle = await createClosedCandle({
    openTime: blockedOrder.eligibleFrom,
    low: '90.00000000',
    assetIdOverride: otherAsset,
  });

  // A LATER window on the healthy asset.
  const laterOrder = await createSubmittedOrder({ label: 'later' });
  const laterCandle = await createClosedCandle({
    openTime: laterOrder.eligibleFrom,
    low: '90.00000000',
  });

  const summary = await sweep.reconcile({ now: afterCandle(laterCandle) });
  assert.equal(summary.matchedOrders >= 1, true);

  // The later candle went through even though an earlier one is stuck.
  assert.equal(
    (
      await prisma.order.findUniqueOrThrow({
        where: { id: laterOrder.orderId },
      })
    ).status,
    OrderStatus.executed,
    'a later candle must not be blocked by an earlier deferral',
  );
  // And the stuck one is still durably queued rather than lost.
  const queued = await prisma.limitOrderDeferredCandle.findUnique({
    where: { marketCandleId: blockedCandle.id },
  });
  assert.ok(queued, 'the blocked candle stays in the durable retry queue');
  assert.equal(
    (
      await prisma.order.findUniqueOrThrow({
        where: { id: blockedOrder.orderId },
      })
    ).status,
    OrderStatus.submitted,
  );

  await seedPriceSnapshot(otherAsset);
  // The retry schedule lives on the SAME simulated clock the sweep is driven
  // with; using the wall clock here would leave the entry not-yet-due.
  await prisma.limitOrderDeferredCandle.update({
    where: { marketCandleId: blockedCandle.id },
    data: { nextRetryAt: new Date(laterCandle.closeTime.getTime() - 1000) },
  });
  await sweep.reconcile({ now: afterCandle(laterCandle) });
  assert.equal(
    (
      await prisma.order.findUniqueOrThrow({
        where: { id: blockedOrder.orderId },
      })
    ).status,
    OrderStatus.executed,
    'the previously blocked candle fills once its valuation source recovers',
  );
}

/**
 * Idempotence across the retry path: a candle that is retried after a partial
 * failure must not fill the same order twice, create a second wallet
 * transaction, or increase the position twice.
 */
async function testRetryDoesNotDoubleFill(): Promise<void> {
  const scenario = await createSubmittedOrder({ label: 'no-double' });
  const candle = await createClosedCandle({
    openTime: scenario.eligibleFrom,
    low: '90.00000000',
  });

  await sweep.reconcile({ now: afterCandle(candle) });
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: scenario.orderId },
  });
  assert.equal(order.status, OrderStatus.executed);

  const walletTxBefore = await prisma.walletTransaction.count({
    where: { seasonParticipantId: scenario.participantId },
  });
  const positionBefore = await prisma.position.findFirst({
    where: { seasonParticipantId: scenario.participantId },
  });

  // Force the SAME candle back through the retry stage, exactly as a crash
  // between the fill and the processed-candle row would.
  await prisma.limitOrderProcessedCandle.delete({
    where: { marketCandleId: candle.id },
  });
  await checkpoints.upsertDeferred({
    marketCandleId: candle.id,
    assetId: candle.assetId,
    interval: candle.interval,
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    now: new Date(),
    nextRetryAt: new Date(Date.now() - 1000),
    errorCode: null,
    errorMessage: 'forced retry',
  });

  await sweep.reconcile({ now: new Date() });

  assert.equal(
    await prisma.walletTransaction.count({
      where: { seasonParticipantId: scenario.participantId },
    }),
    walletTxBefore,
    'a retry must not create a second wallet transaction',
  );
  const positionAfter = await prisma.position.findFirst({
    where: { seasonParticipantId: scenario.participantId },
  });
  assert.equal(
    positionAfter?.quantity.toString(),
    positionBefore?.quantity.toString(),
    'a retry must not increase the position twice',
  );
  assert.equal(
    await prisma.limitOrderDeferredCandle.count({
      where: { marketCandleId: candle.id },
    }),
    0,
    'the forced retry must resolve and leave the queue',
  );
}

// ---------------------------------------------------------------------------
// Retention gap
// ---------------------------------------------------------------------------

/**
 * If candle retention removes rows the watermark has not reached, path B can
 * never examine them. That must become an explicit, durable alarm — never a
 * silent skip.
 */
async function testRetentionGapDetected(): Promise<void> {
  const config = readLimitOrderCandleReconciliationConfig();
  // Push the watermark behind the candle RETENTION HORIZON. That is exactly
  // what a sweep stopped for longer than the retention window looks like:
  // retention is now deleting windows the sweep never examined.
  const beyondRetention = new Date(
    Date.now() - (config.candleRetentionDays + 5) * 86_400_000,
  );
  await prisma.limitOrderReconciliationCheckpoint.update({
    where: { scope: LIMIT_ORDER_RECONCILIATION_SCOPE },
    data: {
      watermarkOpenTime: beyondRetention,
      watermarkCandleId: null,
      gapDetectedAt: null,
      gapFromOpenTime: null,
      gapToOpenTime: null,
      degradedReason: null,
    },
  });

  const summary = await sweep.reconcile({ now: new Date() });
  assert.equal(summary.gapDetected, true, 'the gap must be reported');

  const checkpoint = await checkpoints.find();
  assert.ok(checkpoint?.gapDetectedAt, 'the gap must be durable');
  assert.equal(checkpoint.degradedReason, 'candle_retention_passed_watermark');

  // Sticky: a later run must not clear it by itself.
  const firstDetection = checkpoint.gapDetectedAt.getTime();
  await sweep.reconcile({ now: new Date() });
  const still = await checkpoints.find();
  assert.equal(still?.gapDetectedAt?.getTime(), firstDetection);
}

/**
 * A gap must fail NEW limit quotes/creates closed with the path-B specific
 * code, and must NOT be confused with a path-A matcher failure. Cancel,
 * cleanup, market orders and FX are untouched by this gate — it is only ever
 * consulted on the limit quote/create path.
 */
async function testGapFailsClosed(): Promise<void> {
  const failure = await health.evaluate(new Date());
  assert.ok(failure, 'a detected gap must fail the gate closed');
  assert.equal(
    failure.code,
    'LIMIT_ORDER_CANDLE_RECONCILIATION_GAP_DETECTED',
    'the code must name the reconciliation subsystem, not the matcher',
  );
  await assert.rejects(() => health.assertAvailable(new Date()));

  // Clearing the alarm (the documented operator action) restores service.
  await prisma.limitOrderReconciliationCheckpoint.update({
    where: { scope: LIMIT_ORDER_RECONCILIATION_SCOPE },
    data: {
      gapDetectedAt: null,
      gapFromOpenTime: null,
      gapToOpenTime: null,
      degradedReason: null,
    },
  });
  await checkpoints.markRunSucceeded(new Date());
  assert.equal(
    await health.evaluate(new Date()),
    null,
    'the gate must reopen once the operator clears the gap',
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function resetCheckpointState(): Promise<void> {
  await prisma.limitOrderDeferredCandle.deleteMany({});
  await prisma.limitOrderReconciliationCheckpoint.deleteMany({});
}

async function earliestActivatedEligibleFrom(): Promise<Date | null> {
  const rows = await prisma.$queryRaw<Array<{ earliest: Date | null }>>`
    SELECT MIN("candle_matching_eligible_from") AS "earliest"
    FROM "orders"
    WHERE "order_type" = 'limit'
      AND "side" = 'buy'
      AND "status" = 'submitted'
      AND "candle_matching_eligible_from" IS NOT NULL
  `;
  return rows[0]?.earliest ?? null;
}

async function createSharedMarket(): Promise<void> {
  const now = await databaseNow();
  const season = await prisma.season.create({
    data: {
      name: `${PREFIX}-season`,
      status: SeasonStatus.active,
      startAt: new Date(now.getTime() - 12 * 3_600_000),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: '1300000.00000000',
      tradeFeeRate: '0.050000',
      fxFeeRate: '0.001000',
    },
    select: { id: true },
  });
  seasonId = season.id;
  assetId = await createAsset('primary');
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
}

const createdAssetIds: string[] = [];

async function createAsset(
  label: string,
  options: { withPriceSnapshot?: boolean } = {},
): Promise<string> {
  const now = await databaseNow();
  const asset = await prisma.asset.create({
    data: {
      // Asset.symbol is unique per market and capped at 32 chars; the run
      // prefix alone already exceeds that, so a short unique token is used and
      // the readable name carries the label.
      symbol: `CK${randomUUID().replace(/-/gu, '').slice(0, 20)}`,
      name: `${PREFIX}-${label}`,
      market: 'BINANCE',
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.USD,
      priceCurrency: CurrencyCode.USD,
      settlementCurrency: CurrencyCode.USD,
      isActive: true,
    },
    select: { id: true },
  });
  createdAssetIds.push(asset.id);
  if (options.withPriceSnapshot === false) return asset.id;
  // Path B creates NO price snapshot of its own (the candle IS the evidence),
  // so the ordinary market-price pipeline must already have one for the equity
  // valuation every fill records.
  await prisma.assetPriceSnapshot.create({
    data: {
      assetId: asset.id,
      price: '100.00000000',
      currencyCode: CurrencyCode.USD,
      sourceType: AssetPriceSourceType.provider_api,
      sourceName: 'binance_spot_ws_trade',
      sourceTimestamp: now,
      effectiveAt: now,
      capturedAt: now,
    },
  });
  return asset.id;
}

async function seedPriceSnapshot(targetAssetId: string): Promise<void> {
  const now = await databaseNow();
  await prisma.assetPriceSnapshot.create({
    data: {
      assetId: targetAssetId,
      price: '100.00000000',
      currencyCode: CurrencyCode.USD,
      sourceType: AssetPriceSourceType.provider_api,
      sourceName: 'binance_spot_ws_trade',
      sourceTimestamp: now,
      effectiveAt: now,
      capturedAt: now,
    },
  });
}

type Scenario = {
  orderId: string;
  participantId: string;
  userId: string;
  submittedAt: Date;
  eligibleFrom: Date;
};

async function createSubmittedOrder(input: {
  label: string;
  submittedAt?: Date;
  assetIdOverride?: string;
}): Promise<Scenario> {
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
      seasonId,
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
  await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: CurrencyCode.USD,
      balanceAmount: '1000.00000000',
      reservedAmount: '100.10000000',
    },
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
      // Path A's activation cursor must accompany matchingActivatedAt (DB
      // CHECK constraint). This runner never publishes an event, so the cursor
      // is a fixed synthetic tail: it only has to exist and be well-formed.
      matchingActivationStreamId: `${submittedAt.getTime()}-0`,
      candleMatchingEligibleFrom: eligibleFrom,
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
    submittedAt,
    eligibleFrom,
  };
}

async function createClosedCandle(input: {
  openTime: Date;
  low: string;
  assetIdOverride?: string;
}): Promise<{
  id: string;
  assetId: string;
  interval: string;
  openTime: Date;
  closeTime: Date;
}> {
  const closeTime = new Date(input.openTime.getTime() + FIVE_MINUTES_MS);
  const targetAssetId = input.assetIdOverride ?? assetId;
  const created = await prisma.marketCandle.create({
    data: {
      assetId: targetAssetId,
      interval: '5m',
      openTime: input.openTime,
      closeTime,
      open: '100.00000000',
      high: '110.00000000',
      low: input.low,
      close: '105.00000000',
      volume: '10.00000000',
      amount: '1000.00000000',
      isClosed: true,
      sourceProvider: 'binance_spot_ws_5m_kline',
      sourceUpdatedAt: closeTime,
    },
    select: { id: true },
  });
  createdCandleIds.push(created.id);
  return {
    id: created.id,
    assetId: targetAssetId,
    interval: '5m',
    openTime: input.openTime,
    closeTime,
  };
}

/**
 * Monotonic window allocator. MarketCandle is unique on
 * (assetId, interval, openTime); reusing a window across tests would collide
 * instead of testing anything. Starts far enough in the past that every
 * fixture candle is well outside the runner's short lookback.
 */
let windowCursor = alignWindow(new Date(Date.now() - 8 * 3_600_000));

function nextWindowBase(): Date {
  windowCursor = new Date(windowCursor.getTime() + FIVE_MINUTES_MS * 4);
  return windowCursor;
}

function alignWindow(value: Date): Date {
  return new Date(
    Math.floor(value.getTime() / FIVE_MINUTES_MS) * FIVE_MINUTES_MS,
  );
}

function afterCandle(candle: { closeTime: Date }): Date {
  return new Date(candle.closeTime.getTime() + 60_000);
}

async function databaseNow(): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
  `;
  return rows[0].now;
}

async function cleanupDatabase(): Promise<void> {
  await prisma.limitOrderDeferredCandle.deleteMany({
    where: { marketCandleId: { in: createdCandleIds } },
  });
  await prisma.limitOrderReconciliationCheckpoint.deleteMany({});
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
    where: { assetId: { in: createdAssetIds } },
  });
  await prisma.fxRateSnapshot.deleteMany({ where: { id: fxRateSnapshotId } });
  await prisma.seasonParticipant.deleteMany({
    where: { id: { in: createdParticipantIds } },
  });
  await prisma.asset.deleteMany({ where: { id: { in: createdAssetIds } } });
  await prisma.season.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
