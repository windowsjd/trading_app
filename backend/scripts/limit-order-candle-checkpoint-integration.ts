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
import { LimitOrderWindowCompletionService } from '../src/orders/limit-matching/limit-order-window-completion.service';
import { LIMIT_ORDER_CANDLE_INTERVAL } from '../src/orders/limit-matching/limit-order-candle-eligibility';
import type { MarketCandleSyncService } from '../src/assets/market-candle-sync.service';
import {
  LIMIT_ORDER_RECONCILIATION_SCOPE,
  LimitOrderReconciliationCheckpointRepository,
} from '../src/orders/limit-matching/limit-order-reconciliation-checkpoint.repository';

const PREFIX = `limit-order-ckpt-${process.pid}-${Date.now()}`;
const ZERO = '0.00000000';
const FIVE_MINUTES_MS = 5 * 60_000;

const prisma = new PrismaService();
const boundary = new LimitOrderMatchBoundaryService();

/**
 * Deterministic stand-in for the REST-repair certifier. The completion
 * protocol's contract with the sync service is exactly two signals — "a
 * canonical row now exists" and "the provider cursor confirmed the range" —
 * so the stub provides provider behavior without a network: 'covered' answers
 * coverageComplete over the requested window (explicit no-trade), 'fail'
 * throws (feed unreachable -> the window must stay pending, never no-trade).
 */
let syncVerdict: (input: {
  assetId: string;
  from: Date;
}) => 'covered' | 'fail' = () => 'fail';
const stubSync = {
  syncAsset: (input: { assetId: string; from: Date; to: Date }) => {
    if (syncVerdict({ assetId: input.assetId, from: input.from }) === 'fail') {
      throw new Error('SYNC_UNAVAILABLE');
    }
    return Promise.resolve({
      assetId: input.assetId,
      symbol: 'stub',
      assetType: 'crypto',
      failedFeeds: 0,
      feeds: [
        {
          interval: '5m',
          coverageComplete: true,
          coveredFrom: input.from,
          coveredTo: input.to,
          errorCode: null,
        },
      ],
    });
  },
} as unknown as MarketCandleSyncService;
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
      'a candle stored after the watermark passed its window is still processed',
      testLateStoredCandleIsStillProcessed,
    );
    await run(
      'a candle that only becomes closed later is re-sequenced and swept',
      testLateClosedCandleIsReSequenced,
    );
    await run(
      'an unrelated candle update does not renumber the storage position',
      testUnrelatedUpdateDoesNotRenumber,
    );
    await run(
      'the storage position never passes an unsettled observation',
      testIngestWatermarkTwoPhaseAdvance,
    );
    await run(
      'retention passing an unscanned matchable candle gaps only that asset',
      testUnscannedRetentionGapDetected,
    );
    await run(
      'a deferred candle whose row vanished gaps only its own asset',
      testDeferredOrphanIsAssetScoped,
    );
    await run(
      'a window with no candle row stalls only its own asset',
      testMissingWindowStallsOnlyItsAsset,
    );
    await run(
      'a provider-confirmed empty window advances the cursor as no-trade',
      testNoTradeWindowAdvances,
    );
    await run(
      'a delayed candle row completes its pending window',
      testDelayedRowCompletesPendingWindow,
    );
    await run(
      'an asset retention gap blocks only that asset',
      testAssetRetentionGapIsAssetScoped,
    );
    await run(
      'a corrected candle is reprocessed as a new revision without double fills',
      testCandleRevisionReprocessing,
    );
    await run(
      'a DEFERRED candle recovers through a corrected revision',
      testDeferredRevisionRecovery,
    );
    await run(
      'a PERMANENT entry is reactivated by a corrected revision',
      testPermanentRevisionReactivation,
    );
    await run(
      'the deferred queue applies revision rules atomically',
      testDeferredUpsertRevisionRules,
    );
    await run(
      'a completion failure is never hidden by a healthy row scan',
      testCompletionFailureNotHidden,
    );
    await run(
      'a submitted order without a completion checkpoint fails closed',
      testSubmittedOrderWithoutCheckpoint,
    );
    await run(
      'a permanent entry blocks only its own asset and clears via revision',
      testAssetPermanentIsolation,
    );
    await run(
      'an emergency global backlog blocks every asset',
      testEmergencyGlobalBacklog,
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
    new LimitOrderWindowCompletionService(prisma, stubSync),
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
    candleIngestSeq: await ingestSeqOf(candle.id),
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
// The regression: storage order vs market order
// ---------------------------------------------------------------------------

/**
 * THE late-storage regression test.
 *
 * The sweep used to advance ONE GLOBAL position through the canonical
 * `(openTime, id)` ordering — MARKET time — while rows appear in STORAGE time.
 * A candle written late therefore arrived with an openTime the position had
 * already passed, and a scan that reads strictly after the position never
 * returned it again. Permanent, silent, and on the asset whose data was
 * already unreliable.
 *
 * Reproduced exactly: an on-time window advances the market-time marker, and
 * only THEN does an older window's row appear.
 */
async function testLateStoredCandleIsStillProcessed(): Promise<void> {
  // The order whose window will be stored late. Its eligible window is
  // allocated FIRST, so it is genuinely older than the on-time one below.
  const late = await createSubmittedOrder({ label: 'late-stored' });

  // An on-time window on a different asset pushes the market-time marker past
  // the late order's window.
  const onTimeAsset = await createAsset('on-time', { withPriceSnapshot: true });
  const onTime = await createSubmittedOrder({
    label: 'on-time',
    assetIdOverride: onTimeAsset,
  });
  const onTimeCandle = await createClosedCandle({
    openTime: onTime.eligibleFrom,
    low: '90.00000000',
    assetIdOverride: onTimeAsset,
  });
  // Past the safety lag, so the market-time marker genuinely advances onto the
  // on-time window rather than being held short of it.
  const settled = afterSafetyLag(onTimeCandle);
  await sweep.reconcile({ now: settled });

  const marker = await checkpoints.find();
  assert.ok(marker?.watermark, 'a market-time marker must exist');
  assert.ok(
    marker.watermark.openTime.getTime() > late.eligibleFrom.getTime(),
    'the market-time marker must already be PAST the window about to be stored — this is the precondition that used to lose it',
  );

  // Only now does the late row land, for a window behind that marker.
  const lateCandle = await createClosedCandle({
    openTime: late.eligibleFrom,
    low: '90.00000000',
  });
  const lateSeq = await ingestSeqOf(lateCandle.id);
  const onTimeSeq = await ingestSeqOf(onTimeCandle.id);
  assert.ok(
    lateSeq > onTimeSeq,
    'the late row must carry a HIGHER storage position than the on-time one it follows',
  );
  assert.ok(
    lateCandle.openTime.getTime() < onTimeCandle.openTime.getTime(),
    'while carrying an EARLIER market window',
  );

  const summary = await sweep.reconcile({ now: settled });
  assert.ok(
    summary.scannedCandles >= 1,
    'the late-stored candle must still be scanned',
  );
  assert.equal(
    (await prisma.order.findUniqueOrThrow({ where: { id: late.orderId } }))
      .status,
    OrderStatus.executed,
    'a candle stored after the market-time marker passed its window must still fill its order',
  );
  assert.ok(
    await prisma.limitOrderProcessedCandle.findUnique({
      where: { marketCandleId: lateCandle.id },
    }),
  );
}

/**
 * A row is often INSERTED while its window is still open and only UPDATEd to
 * closed five minutes later. Sequencing on insert alone would leave it below a
 * position that had since moved on, so the trigger re-sequences it on the
 * transition — this proves the row becomes reachable again exactly then.
 */
async function testLateClosedCandleIsReSequenced(): Promise<void> {
  const scenario = await createSubmittedOrder({ label: 'late-closed' });
  const openCandle = await createOpenCandle({
    openTime: scenario.eligibleFrom,
    low: '90.00000000',
  });
  const insertedSeq = await ingestSeqOf(openCandle.id);

  // A closed row stored AFTER it, on an asset nothing is ordering, so the
  // position has something legitimate to advance onto beyond the open row. The
  // ceiling deliberately ignores open rows, which is exactly why the open row
  // needs a closed successor to be stepped over at all.
  const fillerAsset = await createAsset('filler', { withPriceSnapshot: false });
  const filler = await createClosedCandle({
    openTime: nextWindowBase(),
    low: '90.00000000',
    assetIdOverride: fillerAsset,
  });

  // The sweep runs while the row is still open: it is not a candidate, and the
  // position moves past its storage value. TWO runs, because the two-phase
  // guard deliberately refuses to advance onto an observation the same run
  // took — the first run records it, the second may use it.
  const now = afterSafetyLag(filler);
  await sweep.reconcile({ now });
  await forceIngestCeilingSettled();
  await sweep.reconcile({ now });
  const passed = await checkpoints.find();
  assert.ok(
    (passed?.ingest.watermarkSeq ?? -1n) >= insertedSeq,
    'the position must have moved past the still-open row',
  );
  assert.equal(
    (await prisma.order.findUniqueOrThrow({ where: { id: scenario.orderId } }))
      .status,
    OrderStatus.submitted,
    'an open candle must never fill anything',
  );

  // The window closes. The trigger hands the row a NEW storage position.
  await prisma.marketCandle.update({
    where: { id: openCandle.id },
    data: { isClosed: true },
  });
  const closedSeq = await ingestSeqOf(openCandle.id);
  assert.ok(
    closedSeq > insertedSeq,
    'closing the window must re-sequence the row',
  );
  assert.ok(
    closedSeq > (passed?.ingest.watermarkSeq ?? 0n),
    'the re-sequenced row must land ABOVE the position that passed it',
  );

  await sweep.reconcile({ now });
  assert.equal(
    (await prisma.order.findUniqueOrThrow({ where: { id: scenario.orderId } }))
      .status,
    OrderStatus.executed,
    'a window that closes late must still fill its order',
  );
}

/**
 * The other half of the trigger's contract: an update that cannot change a
 * matching decision must NOT renumber the row. Churning the sequence on every
 * touch would drag already-processed rows back in front of the scan forever.
 */
async function testUnrelatedUpdateDoesNotRenumber(): Promise<void> {
  const candle = await createClosedCandle({
    openTime: nextWindowBase(),
    low: '90.00000000',
  });
  const before = await ingestSeqOf(candle.id);

  await prisma.marketCandle.update({
    where: { id: candle.id },
    data: { sourceUpdatedAt: new Date(candle.closeTime.getTime() + 1000) },
  });
  assert.equal(
    await ingestSeqOf(candle.id),
    before,
    'a metadata-only update must not renumber the row',
  );

  // A low that moves DOES change what the window could fill, so it must.
  await prisma.marketCandle.update({
    where: { id: candle.id },
    data: { low: '80.00000000' },
  });
  assert.ok(
    (await ingestSeqOf(candle.id)) > before,
    'a low that moves must re-sequence the row',
  );
}

/**
 * The two-phase guard.
 *
 * A storage position is assigned when a row is INSERTED but only becomes
 * visible when its transaction COMMITS, so the highest visible value can have
 * uncommitted holes below it. The position must therefore never advance onto a
 * value THIS run observed — only onto one an earlier run observed and that has
 * since settled.
 *
 * Elapsed time is simulated by ageing the stored observation rather than by
 * sleeping, so the assertion is deterministic.
 */
async function testIngestWatermarkTwoPhaseAdvance(): Promise<void> {
  const candle = await createClosedCandle({
    openTime: nextWindowBase(),
    low: '90.00000000',
  });
  const seq = await ingestSeqOf(candle.id);

  // Force a fresh, unsettled observation: nothing may advance onto it.
  await prisma.$executeRaw`
    UPDATE "limit_order_reconciliation_checkpoints"
    SET "pending_ingest_seq" = NULL,
        "pending_ingest_seq_observed_at" = NULL
    WHERE "scope" = ${LIMIT_ORDER_RECONCILIATION_SCOPE}
  `;
  const before = await checkpoints.find();
  const held = await sweep.reconcile({ now: afterCandle(candle) });
  assert.equal(
    held.ingestCeilingHeld,
    true,
    'the first observation must not be usable as its own ceiling',
  );
  const afterHeld = await checkpoints.find();
  assert.equal(
    afterHeld?.ingest.watermarkSeq?.toString(),
    before?.ingest.watermarkSeq?.toString(),
    'the position must not move onto an unsettled observation',
  );
  assert.ok(
    (afterHeld?.ingest.pendingSeq ?? 0n) >= seq,
    'but the observation itself must be recorded for the next run',
  );

  // The observation settles; the next run may now use it.
  await forceIngestCeilingSettled();
  const advanced = await sweep.reconcile({ now: afterCandle(candle) });
  assert.equal(advanced.ingestCeilingHeld, false);
  const afterAdvance = await checkpoints.find();
  assert.ok(
    (afterAdvance?.ingest.watermarkSeq ?? 0n) >= seq,
    'a settled observation must let the position advance',
  );
  // Monotonic, always.
  await sweep.reconcile({ now: afterCandle(candle) });
  const finalPosition = await checkpoints.find();
  assert.ok(
    (finalPosition?.ingest.watermarkSeq ?? 0n) >=
      (afterAdvance?.ingest.watermarkSeq ?? 0n),
    'the storage position must never move backwards',
  );
}

// ---------------------------------------------------------------------------
// Retention gap
// ---------------------------------------------------------------------------

/**
 * The gap signal the market-time marker structurally cannot raise.
 *
 * A single very old window stored late sits far behind the marker while the
 * marker itself looks perfectly current, so signal 1 stays silent. If that
 * window is old enough for retention to remove it before the sweep gets to it,
 * the exposure is real and must become a sticky alarm.
 */
async function testUnscannedRetentionGapDetected(): Promise<void> {
  const config = readLimitOrderCandleReconciliationConfig();
  await clearGap();

  // No valuation price, so the sweep DEFERS this candle instead of filling it.
  // That keeps both halves of this scenario meaningful: the first run sees an
  // untracked old window (gap), the second sees the same window sitting in the
  // durable queue (no gap).
  const gapAsset = await createAsset('retention-gap', {
    withPriceSnapshot: false,
  });
  // Older than the retention horizon, and matchable by a real activated order.
  const ancientWindow = alignWindow(
    new Date(Date.now() - (config.candleRetentionDays + 3) * 86_400_000),
  );
  // `submittedAt` on a 5-minute boundary makes eligibleFrom that same boundary,
  // so the order is activated for exactly the ancient window below.
  const scenario = await createSubmittedOrder({
    label: 'retention-unscanned',
    assetIdOverride: gapAsset,
    submittedAt: ancientWindow,
  });
  assert.equal(scenario.eligibleFrom.getTime(), ancientWindow.getTime());
  const ancient = await createClosedCandle({
    openTime: ancientWindow,
    low: '90.00000000',
    assetIdOverride: gapAsset,
  });

  // Hold the position BELOW that row, which is what "not scanned yet" means.
  const seq = await ingestSeqOf(ancient.id);
  await prisma.$executeRaw`
    UPDATE "limit_order_reconciliation_checkpoints"
    SET "watermark_ingest_seq" = ${(seq - 1n).toString()}::bigint
    WHERE "scope" = ${LIMIT_ORDER_RECONCILIATION_SCOPE}
  `;
  // The market-time marker stays current: signal 1 must NOT be what fires.
  await prisma.limitOrderReconciliationCheckpoint.update({
    where: { scope: LIMIT_ORDER_RECONCILIATION_SCOPE },
    data: { watermarkOpenTime: new Date(), watermarkCandleId: null },
  });

  // A second asset that is completely healthy. The exposure below belongs to
  // ONE asset, and this one must keep trading through it.
  const bystanderAsset = await createAsset('retention-gap-bystander');
  const bystanderOrder = await createSubmittedOrder({
    label: 'retention-bystander',
    assetIdOverride: bystanderAsset,
  });

  const summary = await sweep.reconcile({ now: new Date() });
  assert.equal(
    summary.assetGapsDetected,
    1,
    'the exposure must be reported against exactly one asset',
  );
  // ASSET-SCOPED, not global. The candle row names its asset, so the loss
  // blocks that asset alone: recording it on the shared checkpoint used to
  // fail every other asset's new limit orders for a window they had no part
  // in.
  assert.equal(
    summary.gapDetected,
    false,
    'a per-asset loss must not raise the system-wide alarm',
  );
  const shared = await checkpoints.find();
  assert.equal(shared?.gapDetectedAt ?? null, null);
  assert.equal(shared?.degradedReason ?? null, null);

  const checkpoint = await windowCheckpoint(gapAsset);
  assert.ok(checkpoint?.gapDetectedAt, 'the gap must be durable');
  assert.equal(
    checkpoint.gapReason,
    'candle_retention_passed_unscanned_candle',
    'the reason must name the unscanned row, not the marker',
  );
  assert.equal(
    checkpoint.gapMarketCandleId,
    ancient.id,
    'the gap must identify the candle it was observed on',
  );
  assert.ok(
    checkpoint.gapCandleIngestSeq !== null,
    'the gap must record the revision observed at detection',
  );

  await freshHeartbeats();
  assert.equal(
    (await health.evaluate(new Date(), gapAsset))?.code,
    'LIMIT_ORDER_CANDLE_ASSET_GAP_DETECTED',
    'the affected asset must fail closed',
  );
  assert.equal(
    await health.evaluate(new Date(), bystanderAsset),
    null,
    'an unrelated asset must keep accepting new limit orders',
  );
  assert.equal(
    await health.evaluate(new Date()),
    null,
    'the shared gate must stay open',
  );

  // Clear the asset gap so the "already queued" half below measures only the
  // detector, and so later scenarios start from a clean asset.
  await clearAssetGap(gapAsset);
  await prisma.order.deleteMany({ where: { id: bystanderOrder.orderId } });

  // That first run also DEFERRED the candle (its asset has no valuation
  // price), so it is now tracked. A tracked candle is not lost, and alarming
  // on it again would turn ordinary retry latency into a sticky gap that fails
  // every new limit order closed. Same fixture, same position — the signal
  // must fall silent.
  assert.ok(
    await prisma.limitOrderDeferredCandle.findUnique({
      where: { marketCandleId: ancient.id },
    }),
    'the first run must have queued the candle for retry',
  );
  await clearGap();
  await prisma.$executeRaw`
    UPDATE "limit_order_reconciliation_checkpoints"
    SET "watermark_ingest_seq" = ${(seq - 1n).toString()}::bigint
    WHERE "scope" = ${LIMIT_ORDER_RECONCILIATION_SCOPE}
  `;
  const queued = await sweep.reconcile({ now: new Date() });
  assert.equal(
    queued.gapDetected,
    false,
    'a candle already in the retry queue must not raise the unscanned gap',
  );
  assert.equal(
    queued.assetGapsDetected,
    0,
    'nor an asset-scoped one: a tracked candle is not a lost candle',
  );
  // The completion supervisor may independently gap this asset — its window
  // is ancient and no row will ever account for the windows after it, which
  // is a genuine and separate finding. What must not reappear is the ROW
  // detector's reason.
  assert.notEqual(
    (await windowCheckpoint(gapAsset))?.gapReason,
    'candle_retention_passed_unscanned_candle',
    'the unscanned-candle signal must stay silent for a queued candle',
  );

  // Leave nothing behind: the later health-gate scenario reads the deferred
  // backlog, and this fixture's ancient deferral would fail it for an
  // unrelated reason. The order never filled, so removing it is safe.
  await prisma.limitOrderDeferredCandle.deleteMany({
    where: { marketCandleId: ancient.id },
  });
  await prisma.order.deleteMany({ where: { id: scenario.orderId } });
  await clearGap();
}

async function clearGap(): Promise<void> {
  await prisma.limitOrderReconciliationCheckpoint.updateMany({
    where: { scope: LIMIT_ORDER_RECONCILIATION_SCOPE },
    data: {
      gapDetectedAt: null,
      gapFromOpenTime: null,
      gapToOpenTime: null,
      degradedReason: null,
    },
  });
}

/** The documented operator action for a sticky per-asset gap. */
async function clearAssetGap(targetAssetId: string): Promise<void> {
  await prisma.marketCandleFinalizationCheckpoint.updateMany({
    where: {
      assetId: targetAssetId,
      interval: LIMIT_ORDER_CANDLE_INTERVAL,
    },
    data: {
      gapDetectedAt: null,
      gapFromOpenTime: null,
      gapToOpenTime: null,
      gapReason: null,
      gapMarketCandleId: null,
      gapCandleIngestSeq: null,
      degradedReason: null,
    },
  });
}

/**
 * Re-stamps BOTH liveness heartbeats (row scan + window completion) on the
 * wall clock. The fixtures deliberately drive sweeps with SIMULATED clocks
 * hours in the past, so the stored heartbeats look ancient to a health
 * evaluation at `new Date()`; a scenario asserting "this asset is healthy"
 * must first pin liveness to the clock it evaluates with, or it would be
 * testing the fixture clock skew instead of the asset isolation it is about.
 */
async function freshHeartbeats(): Promise<void> {
  const now = new Date();
  await checkpoints.markRunSucceeded(now);
  await checkpoints.markWindowCompletionSucceeded(now);
}

/**
 * Ages the stored observation past the settle grace, so the next run may use
 * it as a ceiling. Simulating elapsed time beats sleeping for it: the
 * assertion becomes deterministic instead of timing-dependent.
 */
async function forceIngestCeilingSettled(): Promise<void> {
  const config = readLimitOrderCandleReconciliationConfig();
  const agedBy = config.ingestSettleGraceMs * 2;
  await prisma.$executeRaw`
    UPDATE "limit_order_reconciliation_checkpoints"
    SET "pending_ingest_seq_observed_at" =
      COALESCE("pending_ingest_seq_observed_at", clock_timestamp())
      - make_interval(secs => ${agedBy / 1000}::double precision)
    WHERE "scope" = ${LIMIT_ORDER_RECONCILIATION_SCOPE}
  `;
}

async function ingestSeqOf(marketCandleId: string): Promise<bigint> {
  const rows = await prisma.$queryRaw<Array<{ ingestSeq: bigint | null }>>`
    SELECT "ingest_seq" AS "ingestSeq"
    FROM "market_candles"
    WHERE "id" = ${marketCandleId}
  `;
  const seq = rows[0]?.ingestSeq;
  assert.ok(
    seq !== null && seq !== undefined,
    `market candle ${marketCandleId} has no storage position; the trigger did not run`,
  );
  return seq;
}

/**
 * If candle retention removes rows the watermark has not reached, path B can
 * never examine them. That must become an explicit, durable alarm — never a
 * silent skip.
 */
// ---------------------------------------------------------------------------
// Window completion: rows that never existed
// ---------------------------------------------------------------------------

async function windowCheckpoint(targetAssetId: string) {
  return prisma.marketCandleFinalizationCheckpoint.findUnique({
    where: {
      assetId_interval: {
        assetId: targetAssetId,
        interval: LIMIT_ORDER_CANDLE_INTERVAL,
      },
    },
  });
}

/**
 * THE missing-window regression: ingest_seq orders rows that EXIST, so a
 * window whose row was never written was invisible. The per-asset completion
 * cursor records it as PENDING — and asset A's stall must not stop asset B.
 */
async function testMissingWindowStallsOnlyItsAsset(): Promise<void> {
  const assetA = await createAsset('missing-window', {
    withPriceSnapshot: true,
  });
  const assetB = await createAsset('healthy-window', {
    withPriceSnapshot: true,
  });
  const orderA = await createSubmittedOrder({
    label: 'missing-window',
    assetIdOverride: assetA,
  });
  const orderB = await createSubmittedOrder({
    label: 'healthy-window',
    assetIdOverride: assetB,
  });
  // B's window has a canonical row; A's window has NO row at all.
  const candleB = await createClosedCandle({
    openTime: orderB.eligibleFrom,
    low: '90.00000000',
    assetIdOverride: assetB,
  });
  syncVerdict = () => 'fail';

  const now = afterSafetyLag(candleB);
  await sweep.reconcile({ now });

  // B advanced and filled; A is pending exactly at its missing window.
  const checkpointB = await windowCheckpoint(assetB);
  assert.ok(checkpointB);
  assert.ok(
    checkpointB.finalizedThroughCloseTime.getTime() >
      orderB.eligibleFrom.getTime(),
    "the healthy asset's cursor must advance past its finalized window",
  );
  assert.equal(checkpointB.pendingWindowOpenTime, null);
  assert.equal(
    (await prisma.order.findUniqueOrThrow({ where: { id: orderB.orderId } }))
      .status,
    OrderStatus.executed,
    'the healthy asset keeps filling while a sibling asset is stalled',
  );

  const checkpointA = await windowCheckpoint(assetA);
  assert.ok(checkpointA, 'the stalled asset must have a durable checkpoint');
  assert.ok(checkpointA.pendingWindowOpenTime);
  assert.equal(
    checkpointA.pendingWindowOpenTime.getTime(),
    orderA.eligibleFrom.getTime(),
    'the FIRST unaccounted window must be recorded, not silently skipped',
  );
  assert.ok(checkpointA.pendingSince);
  assert.equal(
    checkpointA.finalizedThroughCloseTime.getTime(),
    orderA.eligibleFrom.getTime(),
    'the stalled cursor must not advance past the missing window',
  );
  assert.equal(
    (await prisma.order.findUniqueOrThrow({ where: { id: orderA.orderId } }))
      .status,
    OrderStatus.submitted,
  );

  // The pending marker is what the ASSET-scoped gate turns into
  // FINALIZER_STALE once it ages past the threshold; simulate the age rather
  // than sleeping for it.
  const staleConfig = readLimitOrderCandleReconciliationConfig();
  await prisma.marketCandleFinalizationCheckpoint.update({
    where: {
      assetId_interval: {
        assetId: assetA,
        interval: LIMIT_ORDER_CANDLE_INTERVAL,
      },
    },
    data: {
      pendingSince: new Date(
        Date.now() - staleConfig.assetFinalizerStaleMs * 2,
      ),
    },
  });
  await freshHeartbeats();
  const failureA = await health.evaluate(new Date(), assetA);
  assert.equal(failureA?.code, 'LIMIT_ORDER_CANDLE_FINALIZER_STALE');
  const failureB = await health.evaluate(new Date(), assetB);
  assert.equal(
    failureB,
    null,
    'a stalled sibling must not gate a healthy asset',
  );

  await prisma.order.deleteMany({ where: { id: orderA.orderId } });
}

/**
 * "No trades happened" is PROVIDER evidence, never an inference from our own
 * silence: the cursor advances over an empty window only when the provider
 * cursor confirmed the range and returned no candle.
 */
async function testNoTradeWindowAdvances(): Promise<void> {
  const asset = await createAsset('no-trade', { withPriceSnapshot: true });
  const scenario = await createSubmittedOrder({
    label: 'no-trade',
    assetIdOverride: asset,
  });
  syncVerdict = (input) => (input.assetId === asset ? 'covered' : 'fail');

  const now = new Date(
    scenario.eligibleFrom.getTime() +
      FIVE_MINUTES_MS +
      readLimitOrderCandleReconciliationConfig().watermarkSafetyLagMs +
      60_000,
  );
  await sweep.reconcile({ now });
  syncVerdict = () => 'fail';

  const checkpoint = await windowCheckpoint(asset);
  assert.ok(checkpoint);
  assert.ok(
    checkpoint.finalizedThroughCloseTime.getTime() >
      scenario.eligibleFrom.getTime(),
    'a provider-confirmed empty window must not stall the cursor',
  );
  assert.ok(
    checkpoint.noTradeWindowCount >= 1,
    'the no-trade certification must be recorded durably',
  );
  assert.equal(checkpoint.pendingWindowOpenTime, null);
  assert.equal(
    (await prisma.order.findUniqueOrThrow({ where: { id: scenario.orderId } }))
      .status,
    OrderStatus.submitted,
    'a no-trade window fills nothing',
  );
  await freshHeartbeats();
  assert.equal(
    await health.evaluate(new Date(), asset),
    null,
    'a quiet market is never a failure',
  );

  await prisma.order.deleteMany({ where: { id: scenario.orderId } });
}

/**
 * Feed down, then the row arrives late: the pending window resolves through
 * the ordinary row path and the order still fills — nothing was lost while
 * the window was unaccounted.
 */
async function testDelayedRowCompletesPendingWindow(): Promise<void> {
  const asset = await createAsset('delayed-row', { withPriceSnapshot: true });
  const scenario = await createSubmittedOrder({
    label: 'delayed-row',
    assetIdOverride: asset,
  });
  syncVerdict = () => 'fail';

  const now = new Date(
    scenario.eligibleFrom.getTime() +
      FIVE_MINUTES_MS +
      readLimitOrderCandleReconciliationConfig().watermarkSafetyLagMs +
      60_000,
  );
  await sweep.reconcile({ now });
  const pending = await windowCheckpoint(asset);
  assert.ok(pending?.pendingWindowOpenTime, 'the window must be pending');

  // The canonical row finally lands (finalizer recovery, REST repair, ...).
  const candle = await createClosedCandle({
    openTime: scenario.eligibleFrom,
    low: '90.00000000',
    assetIdOverride: asset,
  });
  await forceIngestCeilingSettled();
  await sweep.reconcile({ now: afterSafetyLag(candle) });

  const resolved = await windowCheckpoint(asset);
  assert.ok(resolved);
  assert.equal(resolved.pendingWindowOpenTime, null, 'pending must clear');
  assert.ok(
    resolved.finalizedThroughCloseTime.getTime() >
      scenario.eligibleFrom.getTime(),
  );
  assert.equal(
    (await prisma.order.findUniqueOrThrow({ where: { id: scenario.orderId } }))
      .status,
    OrderStatus.executed,
    'the delayed window must still fill once its row exists',
  );
}

/**
 * Retention passing an asset's unresolved window is an unrecoverable,
 * ASSET-scoped loss: that asset fails closed with its own code while every
 * other asset keeps trading.
 */
async function testAssetRetentionGapIsAssetScoped(): Promise<void> {
  const config = readLimitOrderCandleReconciliationConfig();
  const gapAsset = await createAsset('asset-gap', { withPriceSnapshot: true });
  const healthyAsset = await createAsset('asset-gap-healthy', {
    withPriceSnapshot: true,
  });
  // The gap asset owes a window OLDER than the retention horizon whose row
  // never existed and whose feed cannot confirm anything.
  const ancientWindow = alignWindow(
    new Date(Date.now() - (config.candleRetentionDays + 3) * 86_400_000),
  );
  const gapOrder = await createSubmittedOrder({
    label: 'asset-gap',
    assetIdOverride: gapAsset,
    submittedAt: ancientWindow,
  });
  const healthyOrder = await createSubmittedOrder({
    label: 'asset-gap-healthy',
    assetIdOverride: healthyAsset,
  });
  const healthyCandle = await createClosedCandle({
    openTime: healthyOrder.eligibleFrom,
    low: '90.00000000',
    assetIdOverride: healthyAsset,
  });
  syncVerdict = () => 'fail';

  await sweep.reconcile({ now: afterSafetyLag(healthyCandle) });

  const gapCheckpoint = await windowCheckpoint(gapAsset);
  assert.ok(gapCheckpoint?.gapDetectedAt, 'the asset gap must be durable');
  await freshHeartbeats();
  const gapFailure = await health.evaluate(new Date(), gapAsset);
  assert.equal(gapFailure?.code, 'LIMIT_ORDER_CANDLE_ASSET_GAP_DETECTED');
  assert.equal(
    await health.evaluate(new Date(), healthyAsset),
    null,
    'an asset gap must not block other assets',
  );
  assert.equal(
    (
      await prisma.order.findUniqueOrThrow({
        where: { id: healthyOrder.orderId },
      })
    ).status,
    OrderStatus.executed,
  );

  // Sticky: a later sweep must not clear it.
  await sweep.reconcile({ now: new Date() });
  const still = await windowCheckpoint(gapAsset);
  assert.equal(
    still?.gapDetectedAt?.getTime(),
    gapCheckpoint.gapDetectedAt.getTime(),
  );

  await prisma.order.deleteMany({ where: { id: gapOrder.orderId } });
}

/**
 * A DEFERRED entry whose candle row disappeared under retention. The queue
 * deliberately carries no foreign key so exactly this is observable, and the
 * entry carries the asset id so the loss can be ATTRIBUTED.
 *
 * It used to be recorded on the shared reconciliation checkpoint, whose gap
 * flag fails new limit quotes/creates for every asset — so one asset's deleted
 * candle stopped the whole book. It must now block that asset alone, and only
 * one asset's finding must never hide another's.
 */
async function testDeferredOrphanIsAssetScoped(): Promise<void> {
  await clearGap();
  // Two assets, each with a deferred entry whose candle row is then removed.
  // Two, not one, because the detector used to return a single global row:
  // the older asset's orphan hid the newer asset's completely.
  const first = await createAsset('orphan-a', { withPriceSnapshot: false });
  const second = await createAsset('orphan-b', { withPriceSnapshot: false });
  const healthy = await createAsset('orphan-healthy');

  const orphanIds: string[] = [];
  for (const [index, targetAsset] of [first, second].entries()) {
    const order = await createSubmittedOrder({
      label: `orphan-${index}`,
      assetIdOverride: targetAsset,
    });
    const candle = await createClosedCandle({
      openTime: order.eligibleFrom,
      low: '90.00000000',
      assetIdOverride: targetAsset,
    });
    // No valuation price on these assets, so the sweep DEFERS rather than
    // fills — which is what puts a real entry in the queue.
    await sweep.reconcile({ now: afterSafetyLag(candle) });
    assert.ok(
      await prisma.limitOrderDeferredCandle.findUnique({
        where: { marketCandleId: candle.id },
      }),
      'the sweep must have queued the candle',
    );
    // Retention removes the row from under the queue entry.
    await prisma.marketCandle.delete({ where: { id: candle.id } });
    orphanIds.push(candle.id);
  }

  const healthyOrder = await createSubmittedOrder({
    label: 'orphan-healthy',
    assetIdOverride: healthy,
  });
  const healthyCandle = await createClosedCandle({
    openTime: healthyOrder.eligibleFrom,
    low: '90.00000000',
    assetIdOverride: healthy,
  });

  const summary = await sweep.reconcile({ now: afterSafetyLag(healthyCandle) });
  assert.equal(
    summary.gapDetected,
    false,
    'a deferred orphan must not raise the system-wide alarm',
  );
  assert.equal(
    summary.assetGapsDetected,
    2,
    'BOTH affected assets must be recorded in one pass',
  );
  assert.equal(
    (await checkpoints.find())?.gapDetectedAt ?? null,
    null,
    'the shared checkpoint must stay clean',
  );

  for (const [index, targetAsset] of [first, second].entries()) {
    const checkpoint = await windowCheckpoint(targetAsset);
    assert.ok(checkpoint?.gapDetectedAt, `asset ${index} must carry the gap`);
    assert.equal(checkpoint.gapReason, 'deferred_candle_retention_removed');
    assert.equal(checkpoint.gapMarketCandleId, orphanIds[index]);
  }

  await freshHeartbeats();
  for (const targetAsset of [first, second]) {
    const failure = await health.evaluate(new Date(), targetAsset);
    assert.equal(failure?.code, 'LIMIT_ORDER_CANDLE_ASSET_GAP_DETECTED');
  }
  assert.equal(
    await health.evaluate(new Date(), healthy),
    null,
    'the unaffected asset must keep accepting new limit orders',
  );
  assert.equal(
    await health.evaluate(new Date()),
    null,
    'and the shared gate must stay open',
  );
  // Path B keeps FILLING the healthy asset while the other two are gapped.
  assert.equal(
    (
      await prisma.order.findUniqueOrThrow({
        where: { id: healthyOrder.orderId },
      })
    ).status,
    OrderStatus.executed,
    'an asset gap must not stop other assets being filled',
  );

  // Sticky: a second pass must not rewrite the original evidence.
  const before = await windowCheckpoint(first);
  await sweep.reconcile({ now: new Date() });
  const after = await windowCheckpoint(first);
  assert.equal(
    after?.gapDetectedAt?.getTime(),
    before?.gapDetectedAt?.getTime(),
    'the first detection must win',
  );

  await prisma.limitOrderDeferredCandle.deleteMany({
    where: { marketCandleId: { in: orphanIds } },
  });
  for (const targetAsset of [first, second]) {
    await clearAssetGap(targetAsset);
  }
  await clearGap();
}

// ---------------------------------------------------------------------------
// Candle revision
// ---------------------------------------------------------------------------

/**
 * A correction to an already-processed candle re-sequences it; the sweep
 * reprocesses the NEW revision additively: orders the correction newly
 * qualifies fill once, orders already executed are untouched, and the
 * evidence written for the earlier revision stays verbatim.
 */
async function testCandleRevisionReprocessing(): Promise<void> {
  const asset = await createAsset('revision', { withPriceSnapshot: true });
  const submittedAt = nextWindowBase();
  // Order 1 (limit 100) fills at low 90; order 2 (limit 85) does not.
  const first = await createSubmittedOrder({
    label: 'revision-first',
    assetIdOverride: asset,
    submittedAt,
  });
  const second = await createSubmittedOrder({
    label: 'revision-second',
    assetIdOverride: asset,
    submittedAt,
    limitPriceOverride: '85.00000000',
  });
  const candle = await createClosedCandle({
    openTime: first.eligibleFrom,
    low: '90.00000000',
    assetIdOverride: asset,
  });
  syncVerdict = () => 'fail';
  await forceIngestCeilingSettled();
  const now = afterSafetyLag(candle);
  await sweep.reconcile({ now });

  assert.equal(await orderStatusOf(first.orderId), OrderStatus.executed);
  assert.equal(await orderStatusOf(second.orderId), OrderStatus.submitted);
  const firstEvidenceId = (
    await prisma.order.findUniqueOrThrow({
      where: { id: first.orderId },
      select: { limitOrderCandleEvidenceId: true },
    })
  ).limitOrderCandleEvidenceId;
  assert.ok(firstEvidenceId);
  const processedBefore =
    await prisma.limitOrderProcessedCandle.findUniqueOrThrow({
      where: { marketCandleId: candle.id },
    });

  // The CORRECTION: the provider revises the low to 84. The DB trigger
  // re-sequences the row; the revision-aware sweep re-examines it.
  await prisma.marketCandle.update({
    where: { id: candle.id },
    data: { low: '84.00000000' },
  });
  await forceIngestCeilingSettled();
  await sweep.reconcile({ now });

  // Order 2 newly qualifies and fills ONCE, at ITS limit price.
  const secondOrder = await prisma.order.findUniqueOrThrow({
    where: { id: second.orderId },
  });
  assert.equal(secondOrder.status, OrderStatus.executed);
  assert.equal(secondOrder.executedPrice?.toFixed(8), '85.00000000');
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: second.orderId },
    }),
    1,
  );
  // Order 1 is untouched: same single fill, same evidence row, and that
  // evidence still carries the ORIGINAL low it filled against.
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: first.orderId },
    }),
    1,
    'a revision must never double fill an executed order',
  );
  const firstOrderAfter = await prisma.order.findUniqueOrThrow({
    where: { id: first.orderId },
    select: { limitOrderCandleEvidenceId: true },
  });
  assert.equal(firstOrderAfter.limitOrderCandleEvidenceId, firstEvidenceId);
  const firstEvidence = await prisma.limitOrderCandleEvidence.findUniqueOrThrow(
    { where: { id: firstEvidenceId } },
  );
  assert.equal(
    firstEvidence.triggerLowPrice.toFixed(8),
    '90.00000000',
    'revision-1 evidence must stay immutable',
  );
  // The correction produced a SECOND evidence row scoped to the new revision.
  const evidenceRows = await prisma.limitOrderCandleEvidence.findMany({
    where: { marketCandleId: candle.id },
    orderBy: { candleIngestSeq: 'asc' },
  });
  assert.equal(evidenceRows.length, 2);
  assert.equal(evidenceRows[1].triggerLowPrice.toFixed(8), '84.00000000');
  assert.ok(evidenceRows[1].candleIngestSeq > evidenceRows[0].candleIngestSeq);
  // The processed row advanced to the new revision, keeping its first
  // processing instant for audit.
  const processedAfter =
    await prisma.limitOrderProcessedCandle.findUniqueOrThrow({
      where: { marketCandleId: candle.id },
    });
  assert.ok(processedAfter.candleIngestSeq > processedBefore.candleIngestSeq);
  assert.equal(processedAfter.revisionCount, processedBefore.revisionCount + 1);
  assert.equal(
    processedAfter.firstProcessedAt.getTime(),
    processedBefore.firstProcessedAt.getTime(),
  );

  // A THIRD pass with no further correction is a no-op: same revision.
  await sweep.reconcile({ now });
  assert.equal(
    (
      await prisma.limitOrderProcessedCandle.findUniqueOrThrow({
        where: { marketCandleId: candle.id },
      })
    ).revisionCount,
    processedAfter.revisionCount,
    'an unchanged revision must not be reprocessed',
  );
}

async function orderStatusOf(orderId: string): Promise<OrderStatus> {
  return (
    await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true },
    })
  ).status;
}

// ---------------------------------------------------------------------------
// Deferred-queue revision identity
// ---------------------------------------------------------------------------

/**
 * A candle corrected WHILE SITTING IN THE DEFERRED QUEUE. The queue entry
 * tracks revision 1; the forward scan must re-surface revision 2 (the entry
 * only covers the revision it tracks) and processing the current rows must
 * settle the entry.
 */
async function testDeferredRevisionRecovery(): Promise<void> {
  const asset = await createAsset('rev-deferred', { withPriceSnapshot: false });
  const scenario = await createSubmittedOrder({
    label: 'rev-deferred',
    assetIdOverride: asset,
  });
  const candle = await createClosedCandle({
    openTime: scenario.eligibleFrom,
    low: '90.00000000',
    assetIdOverride: asset,
  });
  syncVerdict = () => 'fail';

  await sweep.reconcile({ now: afterCandle(candle) });
  const rev1 = await ingestSeqOf(candle.id);
  const queued = await prisma.limitOrderDeferredCandle.findUniqueOrThrow({
    where: { marketCandleId: candle.id },
  });
  assert.equal(
    queued.candleIngestSeq?.toString(),
    rev1.toString(),
    'the queue entry must record the revision it tracks',
  );

  // The correction lands while the entry is still queued. Push the retry far
  // into the future so ONLY the forward scan can re-surface the candle — that
  // is the path a lower-revision entry used to suppress forever.
  await prisma.marketCandle.update({
    where: { id: candle.id },
    data: { low: '89.00000000' },
  });
  const rev2 = await ingestSeqOf(candle.id);
  assert.ok(rev2 > rev1, 'the correction must re-sequence the candle');
  await prisma.limitOrderDeferredCandle.update({
    where: { marketCandleId: candle.id },
    data: { nextRetryAt: new Date(Date.now() + 3_600_000) },
  });

  await seedPriceSnapshot(asset);
  await forceIngestCeilingSettled();
  await sweep.reconcile({ now: afterCandle(candle) });

  assert.equal(
    await prisma.limitOrderDeferredCandle.count({
      where: { marketCandleId: candle.id },
    }),
    0,
    'processing the corrected revision must settle the queue entry',
  );
  assert.equal(await orderStatusOf(scenario.orderId), OrderStatus.executed);
  const processed = await prisma.limitOrderProcessedCandle.findUniqueOrThrow({
    where: { marketCandleId: candle.id },
  });
  assert.equal(
    processed.candleIngestSeq.toString(),
    rev2.toString(),
    'the processed row must record the revision actually processed',
  );
}

/**
 * THE reactivation regression: revision 1 exhausted its budget and was parked
 * PERMANENT; a correction produced revision 2. Permanent rows are never
 * retried and the old scan skipped any candle with a queue entry — revision 2
 * was silently lost forever. Now: the scan re-surfaces the candle, the entry
 * is atomically re-pointed (permanent -> deferred, attempts restart), and the
 * retry fills exactly the orders the correction newly qualifies.
 */
async function testPermanentRevisionReactivation(): Promise<void> {
  const asset = await createAsset('rev-permanent', {
    withPriceSnapshot: false,
  });
  const submittedAt = nextWindowBase();
  const first = await createSubmittedOrder({
    label: 'rev-perm-first',
    assetIdOverride: asset,
    submittedAt,
  });
  const second = await createSubmittedOrder({
    label: 'rev-perm-second',
    assetIdOverride: asset,
    submittedAt,
    limitPriceOverride: '85.00000000',
  });
  const candle = await createClosedCandle({
    openTime: first.eligibleFrom,
    low: '90.00000000',
    assetIdOverride: asset,
  });
  syncVerdict = () => 'fail';

  await sweep.reconcile({ now: afterCandle(candle) });
  const rev1 = await ingestSeqOf(candle.id);
  // Park it PERMANENT, exactly as an exhausted retry budget would.
  await prisma.limitOrderDeferredCandle.update({
    where: { marketCandleId: candle.id },
    data: {
      status: 'permanent',
      nextRetryAt: new Date(Date.now() + 3_600_000),
    },
  });
  const parked = await prisma.limitOrderDeferredCandle.findUniqueOrThrow({
    where: { marketCandleId: candle.id },
  });

  // The correction: low 84 — order 2 (limit 85) NEWLY qualifies.
  await prisma.marketCandle.update({
    where: { id: candle.id },
    data: { low: '84.00000000' },
  });
  const rev2 = await ingestSeqOf(candle.id);
  assert.ok(rev2 > rev1);

  // Still no valuation price: the re-surfaced revision fails processing, and
  // the failure must RE-POINT the entry rather than count another attempt
  // against the obsolete revision. A strictly later simulated clock, so the
  // age-anchor reset below is observable.
  await forceIngestCeilingSettled();
  await sweep.reconcile({
    now: new Date(afterCandle(candle).getTime() + 60_000),
  });
  const reactivated = await prisma.limitOrderDeferredCandle.findUniqueOrThrow({
    where: { marketCandleId: candle.id },
  });
  assert.equal(
    reactivated.status,
    'deferred',
    'a corrected revision must reactivate a PERMANENT entry',
  );
  assert.equal(
    reactivated.candleIngestSeq?.toString(),
    rev2.toString(),
    'the entry must now track the corrected revision',
  );
  assert.equal(
    reactivated.attemptCount,
    1,
    'the attempt budget must restart for the new revision',
  );
  assert.ok(
    reactivated.firstDeferredAt.getTime() > parked.firstDeferredAt.getTime(),
    'backlog age must describe the revision actually being retried',
  );

  // The valuation source recovers; the ordinary retry drains the entry.
  await seedPriceSnapshot(asset);
  await prisma.limitOrderDeferredCandle.update({
    where: { marketCandleId: candle.id },
    data: { nextRetryAt: new Date(Date.now() - 1000) },
  });
  await sweep.reconcile({ now: new Date() });

  assert.equal(
    await prisma.limitOrderDeferredCandle.count({
      where: { marketCandleId: candle.id },
    }),
    0,
  );
  const firstOrder = await prisma.order.findUniqueOrThrow({
    where: { id: first.orderId },
  });
  const secondOrder = await prisma.order.findUniqueOrThrow({
    where: { id: second.orderId },
  });
  // Both fill at THEIR limit prices (path B never improves on the low), and
  // exactly once each.
  assert.equal(firstOrder.status, OrderStatus.executed);
  assert.equal(firstOrder.executedPrice?.toFixed(8), '100.00000000');
  assert.equal(secondOrder.status, OrderStatus.executed);
  assert.equal(secondOrder.executedPrice?.toFixed(8), '85.00000000');
  for (const orderId of [first.orderId, second.orderId]) {
    assert.equal(
      await prisma.walletTransaction.count({ where: { referenceId: orderId } }),
      1,
      'reactivation must never double fill',
    );
  }
  // Evidence exists only for the revision that actually filled.
  const evidence = await prisma.limitOrderCandleEvidence.findMany({
    where: { marketCandleId: candle.id },
  });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].candleIngestSeq.toString(), rev2.toString());
}

/**
 * The queue's revision rules, pinned at the repository level against real
 * PostgreSQL: same revision counts an attempt, a higher revision replaces the
 * entry's identity and metadata, a lower revision is a strict no-op, and the
 * revision-guarded resolve never deletes a newer entry.
 */
async function testDeferredUpsertRevisionRules(): Promise<void> {
  const asset = await createAsset('rev-rules', { withPriceSnapshot: true });
  const otherAsset = await createAsset('rev-rules-b', {
    withPriceSnapshot: true,
  });
  const candle = await createClosedCandle({
    openTime: nextWindowBase(),
    low: '90.00000000',
    assetIdOverride: asset,
  });
  const seq = await ingestSeqOf(candle.id);
  const future = new Date(Date.now() + 3_600_000);
  const t0 = new Date('2026-07-23T10:00:00.000Z');
  const t1 = new Date('2026-07-23T10:05:00.000Z');
  const t2 = new Date('2026-07-23T10:10:00.000Z');
  const t3 = new Date('2026-07-23T10:15:00.000Z');

  const base = {
    marketCandleId: candle.id,
    assetId: asset,
    interval: '5m',
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    nextRetryAt: future,
  };
  await checkpoints.upsertDeferred({
    ...base,
    candleIngestSeq: seq,
    now: t0,
    errorCode: 'E_FIRST',
    errorMessage: 'first failure',
  });
  // Same revision -> one more attempt; firstDeferredAt preserved.
  await checkpoints.upsertDeferred({
    ...base,
    candleIngestSeq: seq,
    now: t1,
    errorCode: 'E_RETRY',
    errorMessage: 'second failure',
  });
  let row = await prisma.limitOrderDeferredCandle.findUniqueOrThrow({
    where: { marketCandleId: candle.id },
  });
  assert.equal(row.attemptCount, 2);
  assert.equal(row.firstDeferredAt.getTime(), t0.getTime());
  assert.equal(row.lastErrorCode, 'E_RETRY');

  // Higher revision -> full replacement: identity, metadata, status,
  // attempts, error, age anchor. Even out of PERMANENT.
  await prisma.limitOrderDeferredCandle.update({
    where: { marketCandleId: candle.id },
    data: { status: 'permanent' },
  });
  const shifted = new Date(candle.openTime.getTime() + FIVE_MINUTES_MS);
  await checkpoints.upsertDeferred({
    ...base,
    candleIngestSeq: seq + 10n,
    assetId: otherAsset,
    openTime: shifted,
    closeTime: new Date(shifted.getTime() + FIVE_MINUTES_MS),
    now: t2,
    errorCode: 'E_REVISION',
    errorMessage: 'revision failure',
  });
  row = await prisma.limitOrderDeferredCandle.findUniqueOrThrow({
    where: { marketCandleId: candle.id },
  });
  assert.equal(row.candleIngestSeq?.toString(), (seq + 10n).toString());
  assert.equal(row.status, 'deferred');
  assert.equal(row.attemptCount, 1);
  assert.equal(row.assetId, otherAsset);
  assert.equal(row.openTime.getTime(), shifted.getTime());
  assert.equal(row.firstDeferredAt.getTime(), t2.getTime());
  assert.equal(row.lastErrorCode, 'E_REVISION');

  // Lower revision (a late callback for the superseded revision) -> no-op.
  await checkpoints.upsertDeferred({
    ...base,
    candleIngestSeq: seq,
    now: t3,
    errorCode: 'E_LATE',
    errorMessage: 'late duplicate',
    status: 'permanent',
  });
  row = await prisma.limitOrderDeferredCandle.findUniqueOrThrow({
    where: { marketCandleId: candle.id },
  });
  assert.equal(row.candleIngestSeq?.toString(), (seq + 10n).toString());
  assert.equal(row.status, 'deferred');
  assert.equal(row.attemptCount, 1);
  assert.equal(row.lastErrorCode, 'E_REVISION');

  // Revision-guarded resolve: settling an OLDER revision must not delete the
  // newer entry; settling the tracked revision does.
  await checkpoints.resolveDeferred(candle.id, seq);
  assert.equal(
    await prisma.limitOrderDeferredCandle.count({
      where: { marketCandleId: candle.id },
    }),
    1,
    'resolving a superseded revision must leave the newer entry',
  );
  await checkpoints.resolveDeferred(candle.id, seq + 10n);
  assert.equal(
    await prisma.limitOrderDeferredCandle.count({
      where: { marketCandleId: candle.id },
    }),
    0,
  );
}

// ---------------------------------------------------------------------------
// Window-completion heartbeat separation
// ---------------------------------------------------------------------------

/**
 * THE hidden-failure regression: the completion pass throws, the row scan
 * continues and used to stamp the ONLY heartbeat — so a safety net that was
 * blind to absent rows looked perfectly healthy. The two heartbeats are now
 * separate and the gate reads BOTH.
 */
async function testCompletionFailureNotHidden(): Promise<void> {
  const failingCompletion = {
    supervise: () => Promise.reject(new Error('completion exploded')),
  } as unknown as LimitOrderWindowCompletionService;
  const failingSweep = new LimitOrderCandleReconciliationService(
    prisma,
    new LimitOrderCandidateRepository(prisma),
    execution,
    boundary,
    checkpoints,
    failingCompletion,
  );

  const now = new Date();
  const summary = await failingSweep.reconcile({ now });
  assert.equal(summary.rowScanSucceeded, true, 'the row scan must continue');
  assert.equal(
    summary.windowCompletion?.succeeded,
    false,
    'the failure must be reported explicitly, never as silent success',
  );

  const checkpoint = await checkpoints.find();
  assert.ok(checkpoint);
  assert.equal(
    checkpoint.lastSuccessfulRunAt?.getTime(),
    now.getTime(),
    'the row-scan heartbeat moves',
  );
  assert.equal(checkpoint.lastWindowCompletionRunAt?.getTime(), now.getTime());
  assert.notEqual(
    checkpoint.lastWindowCompletionSuccessfulAt?.getTime(),
    now.getTime(),
    'the completion SUCCESS heartbeat must not move on a failed pass',
  );
  assert.equal(
    checkpoint.windowCompletionErrorCode,
    'LIMIT_ORDER_WINDOW_COMPLETION_FAILED',
  );
  assert.ok(checkpoint.windowCompletionConsecutiveFailures >= 1);

  // A failed latest pass must block IMMEDIATELY even when the previous
  // completion success is recent. Waiting for the freshness window to elapse
  // would admit new orders after the supervisor already proved it was blind.
  await checkpoints.markRunSucceeded(new Date());
  await prisma.limitOrderReconciliationCheckpoint.updateMany({
    where: { scope: LIMIT_ORDER_RECONCILIATION_SCOPE },
    data: {
      lastWindowCompletionSuccessfulAt: new Date(Date.now() - 1_000),
    },
  });
  assert.equal(
    (await health.evaluate(new Date()))?.code,
    'LIMIT_ORDER_CANDLE_COMPLETION_UNAVAILABLE',
  );

  // With no failed latest pass, age alone produces COMPLETION_STALE.
  await prisma.limitOrderReconciliationCheckpoint.updateMany({
    where: { scope: LIMIT_ORDER_RECONCILIATION_SCOPE },
    data: {
      lastWindowCompletionSuccessfulAt: new Date(Date.now() - 3_600_000),
      lastWindowCompletionRunAt: new Date(Date.now() - 3_600_000),
      windowCompletionErrorCode: null,
      windowCompletionErrorMessage: null,
      windowCompletionConsecutiveFailures: 0,
    },
  });
  assert.equal(
    (await health.evaluate(new Date()))?.code,
    'LIMIT_ORDER_CANDLE_COMPLETION_STALE',
  );
  // And a pass that NEVER succeeded -> COMPLETION_UNAVAILABLE.
  await prisma.limitOrderReconciliationCheckpoint.updateMany({
    where: { scope: LIMIT_ORDER_RECONCILIATION_SCOPE },
    data: { lastWindowCompletionSuccessfulAt: null },
  });
  assert.equal(
    (await health.evaluate(new Date()))?.code,
    'LIMIT_ORDER_CANDLE_COMPLETION_UNAVAILABLE',
  );

  // Recovery: one healthy pass clears the error state and reopens the gate.
  syncVerdict = () => 'fail';
  await sweep.reconcile({ now: new Date() });
  const recovered = await checkpoints.find();
  assert.equal(recovered?.windowCompletionErrorCode, null);
  assert.equal(recovered?.windowCompletionConsecutiveFailures, 0);
  assert.ok(recovered?.lastWindowCompletionSuccessfulAt);
  assert.equal(await health.evaluate(new Date()), null);
}

/**
 * Missing-checkpoint policy: with a submitted path-B order the asset is OWED
 * completion accounting, so an absent checkpoint fails closed; without such
 * an order nothing is owed and the absence passes.
 */
async function testSubmittedOrderWithoutCheckpoint(): Promise<void> {
  const asset = await createAsset('no-ckpt', { withPriceSnapshot: true });
  const scenario = await createSubmittedOrder({
    label: 'no-ckpt',
    assetIdOverride: asset,
  });
  await freshHeartbeats();

  const failure = await health.evaluate(new Date(), asset);
  assert.equal(
    failure?.code,
    'LIMIT_ORDER_CANDLE_COMPLETION_UNAVAILABLE',
    'a submitted order with no completion checkpoint must fail closed',
  );

  await prisma.order.deleteMany({ where: { id: scenario.orderId } });
  assert.equal(
    await health.evaluate(new Date(), asset),
    null,
    'with no activated order, a missing checkpoint owes nothing',
  );
}

// ---------------------------------------------------------------------------
// Asset-scoped permanent isolation + emergency global tier
// ---------------------------------------------------------------------------

async function testAssetPermanentIsolation(): Promise<void> {
  const assetA = await createAsset('perm-a', { withPriceSnapshot: true });
  const assetB = await createAsset('perm-b', { withPriceSnapshot: true });
  // The limit sits BELOW the candle low, so the sweep itself never examines
  // the candle; the permanent entry below is planted by hand.
  const orderA = await createSubmittedOrder({
    label: 'perm-a',
    assetIdOverride: assetA,
    limitPriceOverride: '50.00000000',
  });
  const orderB = await createSubmittedOrder({
    label: 'perm-b',
    assetIdOverride: assetB,
  });
  // A real candle row backs the permanent entry (the queue deliberately has
  // no FK, but an orphaned entry raises the retention-gap alarm instead).
  const candleA = await createClosedCandle({
    openTime: orderA.eligibleFrom,
    low: '90.00000000',
    assetIdOverride: assetA,
  });
  // Give both assets completion checkpoints via a provider-confirmed pass.
  syncVerdict = () => 'covered';
  await sweep.reconcile({ now: new Date() });
  syncVerdict = () => 'fail';

  await checkpoints.upsertDeferred({
    marketCandleId: candleA.id,
    candleIngestSeq: await ingestSeqOf(candleA.id),
    assetId: assetA,
    interval: '5m',
    openTime: candleA.openTime,
    closeTime: candleA.closeTime,
    now: new Date(),
    nextRetryAt: new Date(Date.now() + 3_600_000),
    errorCode: 'E_PERMANENT',
    errorMessage: 'parked for the isolation scenario',
    status: 'permanent',
  });
  await freshHeartbeats();

  assert.equal(
    (await health.evaluate(new Date(), assetA))?.code,
    'LIMIT_ORDER_CANDLE_ASSET_PERMANENT_FAILURE',
    "asset A's permanent entry must block asset A",
  );
  assert.equal(
    await health.evaluate(new Date(), assetB),
    null,
    "asset A's permanent entry must NOT block asset B",
  );
  assert.equal(
    await health.evaluate(new Date()),
    null,
    'one permanent entry is asset-scoped, never a global outage',
  );

  // Spec scenario E: a corrected revision drains the permanent entry and the
  // asset recovers on its own — no operator surgery on the queue. Low 45 now
  // touches the 50 limit, so the corrected revision newly qualifies order A.
  await prisma.marketCandle.update({
    where: { id: candleA.id },
    data: { low: '45.00000000' },
  });
  await forceIngestCeilingSettled();
  await sweep.reconcile({ now: new Date() });
  assert.equal(await orderStatusOf(orderA.orderId), OrderStatus.executed);
  assert.equal(
    await prisma.limitOrderDeferredCandle.count({
      where: { marketCandleId: candleA.id },
    }),
    0,
  );
  await freshHeartbeats();
  assert.equal(
    await health.evaluate(new Date(), assetA),
    null,
    'processing the corrected revision must restore the asset gate',
  );

  await prisma.order.deleteMany({ where: { id: orderB.orderId } });
}

async function testEmergencyGlobalBacklog(): Promise<void> {
  const asset = await createAsset('emergency', { withPriceSnapshot: true });
  const bystander = await createAsset('emergency-bystander', {
    withPriceSnapshot: true,
  });
  const candles = [] as Array<Awaited<ReturnType<typeof createClosedCandle>>>;
  // No orders exist on this asset, so the sweep never examines these rows;
  // they exist only to back the queue entries with real candles.
  for (let index = 0; index < 3; index += 1) {
    candles.push(
      await createClosedCandle({
        openTime: nextWindowBase(),
        low: '90.00000000',
        assetIdOverride: asset,
      }),
    );
  }
  for (const candle of candles) {
    await checkpoints.upsertDeferred({
      marketCandleId: candle.id,
      candleIngestSeq: await ingestSeqOf(candle.id),
      assetId: asset,
      interval: '5m',
      openTime: candle.openTime,
      closeTime: candle.closeTime,
      now: new Date(),
      nextRetryAt: new Date(Date.now() + 3_600_000),
      errorCode: 'E_EMERGENCY',
      errorMessage: 'emergency backlog fixture',
      status: 'deferred',
    });
  }

  // A gate configured with a LOW emergency ceiling, so three entries breach
  // it without allocating dozens of fixture windows. The asset threshold sits
  // below it, as the config validation enforces in production too.
  const previous = { ...process.env };
  Object.assign(process.env, {
    LIMIT_ORDER_CANDLE_RECONCILIATION_MAX_DEFERRED_BACKLOG: '2',
    LIMIT_ORDER_CANDLE_MAX_ASSET_DEFERRED_BACKLOG: '1',
  });
  let strictHealth: LimitOrderCandleReconciliationHealthService;
  try {
    strictHealth = new LimitOrderCandleReconciliationHealthService(checkpoints);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }

  await freshHeartbeats();
  assert.equal(
    (await strictHealth.evaluate(new Date()))?.code,
    'LIMIT_ORDER_CANDLE_RECONCILIATION_BACKLOG_EXCEEDED',
    'the emergency tier trips on TOTAL queue size',
  );
  assert.equal(
    (await strictHealth.evaluate(new Date(), bystander))?.code,
    'LIMIT_ORDER_CANDLE_RECONCILIATION_BACKLOG_EXCEEDED',
    'an emergency blocks EVERY asset, including healthy bystanders',
  );

  await prisma.limitOrderDeferredCandle.deleteMany({
    where: { marketCandleId: { in: candles.map((candle) => candle.id) } },
  });
  await freshHeartbeats();
  assert.equal(await health.evaluate(new Date()), null);
}

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
  await freshHeartbeats();
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
  await prisma.marketCandleFinalizationCheckpoint.deleteMany({});
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
  limitPriceOverride?: string;
}): Promise<Scenario> {
  const submittedAt = input.submittedAt ?? nextWindowBase();
  const limitPrice = input.limitPriceOverride ?? '100.00000000';
  // reservation = limit x quantity(1) x (1 + fee 0.001), 8 decimals.
  const reservedAmount = (Number(limitPrice) * 1.001).toFixed(8);
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
      reservedAmount,
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
      limitPrice,
      currencyCode: CurrencyCode.USD,
      reservedAmount,
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
 * A row for a window that has NOT closed yet — what the live finalizer writes
 * while the window is still running. It gets a storage position on INSERT and
 * a fresh one when it is later updated to closed.
 */
async function createOpenCandle(input: {
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
      isClosed: false,
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
// 16h of budget: the suite allocates ~25 windows at 20-minute strides, and
// the completion/revision scenarios added several more. Every fixture window
// must stay in the past (and far inside candle retention).
let windowCursor = alignWindow(new Date(Date.now() - 16 * 3_600_000));

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

/**
 * Far enough past a window that the MARKET-TIME marker may actually advance
 * onto it. `afterCandle` alone leaves it inside `watermarkSafetyLagMs`, where
 * the marker deliberately holds back.
 */
function afterSafetyLag(candle: { closeTime: Date }): Date {
  const config = readLimitOrderCandleReconciliationConfig();
  return new Date(
    candle.closeTime.getTime() + config.watermarkSafetyLagMs + 60_000,
  );
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
  await prisma.marketCandleFinalizationCheckpoint.deleteMany({
    where: { assetId: { in: createdAssetIds } },
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
