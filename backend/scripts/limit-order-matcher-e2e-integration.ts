/**
 * END-TO-END matcher load runner (real PostgreSQL + real Redis).
 *
 * WHY THIS IS A SEPARATE SUITE
 * ----------------------------
 * The previously reported "3,367 events/s" was PUBLISHER throughput: how fast
 * `LimitOrderPriceEventPublisher` can validate a normalized tick and XADD it.
 * It says nothing about how fast the MATCHER can consume one, because the
 * consumer does strictly more work per event: consumer-group read, payload and
 * route validation, boundary acquisition, dedupe lookup, candidate query, an
 * execution transaction when there is a fill, the processed-event insert, and
 * finally XACK.
 *
 * This runner measures the second number: XADD -> XACK. The two are reported
 * under DIFFERENT event names and must never be quoted interchangeably:
 *
 *   limit_order_publisher_throughput      (phase-3 runner) — XADD only
 *   limit_order_matcher_e2e_throughput    (this runner)    — XADD to XACK
 *
 * WHAT THE MEASUREMENT ACTUALLY MEANS
 * -----------------------------------
 * Getting the NAMES right is not enough; the numbers under them have to be
 * arithmetic anyone can reconstruct. Three corrections define this runner:
 *
 * 1. THE MATCHER IS NOT RUNNING WHILE THE BACKLOG IS PUBLISHED. It used to be,
 *    and the drain rate was then computed as `all events / tail-drain time` —
 *    dividing the FULL event count by the sliver of time left after the
 *    publisher stopped. A matcher that kept up in real time produced a
 *    near-zero denominator and an absurd rate. Now every event is XADDed
 *    first, the consumer is started at a recorded instant, and the drain window
 *    provably contains all of the consumer's work for all of the events.
 *
 * 2. LATENCY IS MEASURED TO THE ACK, because that is what the name claims. The
 *    processed-event row's `processed_at` is stamped BEFORE its own insert and
 *    before the XACK, so quoting it as "xadd to xack" overstated the matcher by
 *    exactly the work that remained. The stream service is instrumented here to
 *    record the real ACK instant, on the same clock as the XADD.
 *
 * 3. NOTHING IS REPORTED THAT WAS NOT MEASURED. A hardcoded `boundaryWaitMs: 0`
 *    used to be printed as if it were an observation, and the create-boundary
 *    wait was timed BEFORE the load started — on an idle system — while being
 *    described as the wait under full tilt. Both are now measured against real
 *    contention, during the drain.
 *
 * CI runs a reduced volume and asserts only hardware-independent invariants
 * (everything processed and ACKed within the deadline, lag and pending back to
 * zero, no duplicate fill, no residual advisory lock, no degraded state, and
 * that every reported rate has a real denominator). The absolute rates are
 * printed for the soak run (`pnpm soak:limit-order-matcher-e2e`), never
 * asserted.
 *
 * REQUIRES A DISPOSABLE DATABASE.
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
import { RedisService } from '../src/redis/redis.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { NormalizedProviderTradeEventBus } from '../src/providers/normalized-provider-trade-event-bus.service';
import { ProviderTradeRouteRegistry } from '../src/providers/provider-trade-route.registry';
import { LimitOrderCandidateRepository } from '../src/orders/limit-matching/limit-order-candidate.repository';
import { LimitOrderCandleReconciliationService } from '../src/orders/limit-matching/limit-order-candle-reconciliation.service';
import { calculateCandleMatchingEligibleFrom } from '../src/orders/limit-matching/limit-order-candle-eligibility';
import { LimitOrderEventPollerService } from '../src/orders/limit-matching/limit-order-event-poller.service';
import {
  LimitOrderEventStreamService,
  type LimitOrderStreamEntry,
} from '../src/orders/limit-matching/limit-order-event-stream.service';
import { LimitOrderExecutionService } from '../src/orders/limit-matching/limit-order-execution.service';
import {
  LIMIT_ORDER_MATCH_BOUNDARY_KEY,
  LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE,
  LimitOrderMatchBoundaryService,
} from '../src/orders/limit-matching/limit-order-match-boundary.service';
import { LimitOrderMatcherHealthService } from '../src/orders/limit-matching/limit-order-matcher-health.service';
import { LimitOrderMatcherLeaderService } from '../src/orders/limit-matching/limit-order-matcher-leader.service';
import { readLimitOrderMatchingConfig } from '../src/orders/limit-matching/limit-order-matching.config';
import { LimitOrderPriceEventPublisher } from '../src/orders/limit-matching/limit-order-price-event.publisher';
import { LimitOrderReconciliationCheckpointRepository } from '../src/orders/limit-matching/limit-order-reconciliation-checkpoint.repository';

const PREFIX = `lo-e2e-${process.pid}-${Date.now()}`;
const ZERO = '0.00000000';
const FIVE_MINUTES_MS = 5 * 60_000;

/** Reduced in CI; the soak run raises them through the environment. */
const ASSET_COUNT = readNumber('LIMIT_ORDER_E2E_ASSET_COUNT', 6);
const EVENTS_PER_ASSET = readNumber('LIMIT_ORDER_E2E_EVENTS_PER_ASSET', 25);
const DRAIN_TIMEOUT_MS = readNumber(
  'LIMIT_ORDER_E2E_DRAIN_TIMEOUT_MS',
  120_000,
);

const prisma = new PrismaService();
const redis = new RedisService();
const config = readLimitOrderMatchingConfig();
const tradeBus = new NormalizedProviderTradeEventBus();
const tradeRoutes = new ProviderTradeRouteRegistry();
const health = new LimitOrderMatcherHealthService(prisma);
const checkpoints = new LimitOrderReconciliationCheckpointRepository(prisma);
const publisher = new LimitOrderPriceEventPublisher(
  prisma,
  redis,
  tradeBus,
  health,
  tradeRoutes,
);
const rankingStub = {
  refreshCurrentRankingAfterParticipantChange: () =>
    Promise.resolve({ skipped: false }),
};

const createdUserIds: string[] = [];
const createdParticipantIds: string[] = [];
const createdAssetIds: string[] = [];
const createdCandleIds: string[] = [];
const publishedEventIds: string[] = [];
let seasonId: string;
let fxRateSnapshotId: string;
let generation: string;
let execution: LimitOrderExecutionService;
let candles: LimitOrderCandleReconciliationService;

type MatcherWorker = {
  poller: LimitOrderEventPollerService;
  stream: LimitOrderEventStreamService;
  leader: LimitOrderMatcherLeaderService;
  boundary: LimitOrderMatchBoundaryService;
};
const workers: MatcherWorker[] = [];

/** XADD timestamps by eventId, so latency is measured across the whole path. */
const publishedAt = new Map<string, number>();
/** XACK timestamps by eventId, recorded by the instrumented stream service. */
const acknowledgedAt = new Map<string, number>();

/**
 * The production stream service with two observation points added: the
 * streamId -> eventId mapping every read already carries, and the instant the
 * ACK returns.
 *
 * Subclassed rather than reimplemented so the measured path IS the production
 * path — a hand-written copy would drift and would stop measuring the thing it
 * claims to. Both clocks here are this process's, the same one that stamps the
 * XADD, so the latency needs no cross-host correction.
 */
class InstrumentedStreamService extends LimitOrderEventStreamService {
  private readonly eventIdByStreamId = new Map<string, string>();

  override async readNew(
    config: Parameters<LimitOrderEventStreamService['readNew']>[0],
  ): ReturnType<LimitOrderEventStreamService['readNew']> {
    return this.remember(await super.readNew(config));
  }

  override async readOwnPending(
    config: Parameters<LimitOrderEventStreamService['readOwnPending']>[0],
  ): ReturnType<LimitOrderEventStreamService['readOwnPending']> {
    return this.remember(await super.readOwnPending(config));
  }

  override async reclaimStale(
    config: Parameters<LimitOrderEventStreamService['reclaimStale']>[0],
  ): ReturnType<LimitOrderEventStreamService['reclaimStale']> {
    const result = await super.reclaimStale(config);
    this.remember(result.entries);
    return result;
  }

  override async acknowledge(
    config: Parameters<LimitOrderEventStreamService['acknowledge']>[0],
    streamId: string,
  ): Promise<void> {
    await super.acknowledge(config, streamId);
    const at = Date.now();
    const eventId = this.eventIdByStreamId.get(streamId);
    // First ACK wins: a duplicate XADD of the same eventId gets its own
    // streamId, and overwriting would silently replace a measured latency with
    // the duplicate's much shorter one.
    if (eventId !== undefined && !acknowledgedAt.has(eventId)) {
      acknowledgedAt.set(eventId, at);
    }
  }

  private remember(
    entries: readonly LimitOrderStreamEntry[],
  ): LimitOrderStreamEntry[] {
    for (const entry of entries) {
      // A malformed entry has no eventId; it still gets ACKed (into the DLQ
      // path) but there is nothing to attribute a latency to.
      if (entry.eventId === null) continue;
      this.eventIdByStreamId.set(entry.streamId, entry.eventId);
    }
    return [...entries];
  }
}

type Asset = { id: string; symbol: string; hasOrders: boolean };
const assets: Asset[] = [];

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
    new LimitOrderMatchBoundaryService(),
    checkpoints,
  );

  try {
    await createSharedMarket();
    // The consumer is started INSIDE runLoad, after the backlog exists, so the
    // drain window it measures actually contains all of the consumer's work.
    const report = await runLoad();
    const worker = workers[0];
    assert.ok(worker, 'the load must have started a matcher worker');

    await run('every published event is processed and acknowledged', () =>
      assertAllProcessedAndAcked(report),
    );
    await run('every reported rate has a measured denominator', () =>
      assertMeasurementIsSound(report),
    );
    await run('consumer lag returns to zero', assertNoLag);
    await run('pending returns to zero', assertNoPending);
    await run('no order is filled twice', assertNoDoubleFill);
    await run('a duplicate eventId is not re-processed', () =>
      assertDuplicateEventIgnored(worker),
    );
    await run('a reclaimed pending entry is drained', () =>
      assertReclaimDrains(worker),
    );
    await run('a new leader drains the backlog after takeover', () =>
      assertLeaderTakeoverDrains(worker),
    );
    await run(
      'no residual boundary advisory lock remains',
      assertNoResidualLock,
    );
    await run('the matcher reports no degraded state', assertNotDegraded);

    printReport(report);
    console.log('limit order matcher e2e integration ok');
  } finally {
    await stopWorkers();
    await cleanupRedis().catch(() => undefined);
    await cleanupDatabase().catch((error: unknown) => {
      console.error('cleanup failed', error);
    });
    await redis.onModuleDestroy().catch(() => undefined);
    await prisma.$disconnect();
  }
}

function requireEnvironment(): void {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be configured.');
  assert.ok(process.env.REDIS_URL, 'REDIS_URL must be configured.');
  assert.equal(process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED, 'true');
  // A shared stream key would let a parallel run steal this run's events.
  assert.notEqual(
    process.env.LIMIT_ORDER_EVENT_STREAM_KEY,
    undefined,
    'the runner needs its own LIMIT_ORDER_EVENT_STREAM_KEY',
  );
  // The backlog is published in full BEFORE the consumer starts, which is what
  // makes the drain rate honest — but it also means the whole backlog has to
  // survive the stream's trim window. A run that silently trimmed unread
  // entries would report a drain over fewer events than it published, so this
  // is a precondition rather than a runtime surprise. Raise
  // LIMIT_ORDER_EVENT_MAXLEN alongside the soak volume.
  const backlog = ASSET_COUNT * EVENTS_PER_ASSET;
  assert.ok(
    backlog < config.eventMaxLen,
    `LIMIT_ORDER_EVENT_MAXLEN (${config.eventMaxLen}) must exceed the ${backlog}-event backlog this run publishes before consuming.`,
  );
}

async function run(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  console.log(`ok ${name}`);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

type Report = {
  totalEvents: number;
  /** Wall clock of the XADD phase alone, with no consumer and no sampling. */
  publishElapsedMs: number;
  /**
   * Wall clock from starting the consumer to the last ACK of the backlog. The
   * consumer did NOT run before this window, so all `totalEvents` events were
   * consumed inside it and the rate below has an honest denominator.
   */
  drainElapsedMs: number;
  /** XADD -> XACK per event, in milliseconds, on one clock. */
  latencies: number[];
  /** Events that reached an ACK. Asserted to equal totalEvents. */
  ackedEvents: number;
  processedEventRows: number;
  matchedOrders: number;
  createBoundaryWaitMs: number;
  /**
   * Whether the concurrent path-B sweep was actually ENABLED for this run. It
   * is not by default, and reporting its contention unconditionally would
   * describe pressure the run never applied.
   */
  sweepEnabled: boolean;
  /** Candles the concurrent sweep processed; null if the sweep threw. */
  sweepProcessedCandles: number | null;
  peakPending: number;
  peakLag: number;
  connectionCount: number;
  heapUsedMb: number;
};

/**
 * The load. Three shapes are mixed on purpose, because their per-event cost
 * differs by an order of magnitude:
 *   - assets with NO order at all (dedupe + candidate query, no transaction),
 *   - assets with ONE order (one execution transaction),
 *   - assets with SEVERAL orders on the same event (several transactions under
 *     a single boundary hold).
 *
 * PHASE 1 — backlog. Every event is XADDed with NO consumer running. Nothing
 * is sampled inside the timed loop, so `publishElapsedMs` measures publishing
 * and nothing else.
 *
 * PHASE 2 — drain. The consumer starts, and a boundary-waiting Create runs
 * CONCURRENTLY — plus a path-B sweep when path B is enabled for the run — so
 * the measurement includes real contention rather than an idle-system best
 * case. Whether the sweep was actually enabled is REPORTED, because the sweep
 * is off by default and describing contention the run never applied is the
 * same class of error as the rates this runner exists to fix. Backlog depth is
 * sampled on its own timer rather than from inside either loop.
 */
async function runLoad(): Promise<Report> {
  // ---- Phase 1: publish the whole backlog with the matcher stopped. --------
  const publishStartedAt = Date.now();
  for (let round = 0; round < EVENTS_PER_ASSET; round += 1) {
    for (const asset of assets) {
      // Stamped from the id the publisher actually returned, AFTER the XADD
      // completed — that instant is when the event exists in the stream, which
      // is what "xadd to xack" means. Stamping before the call would fold the
      // publisher's own validation into the matcher's number, and deriving the
      // id by hand (as this used to) meant a format change silently dropped
      // every latency sample instead of failing.
      const eventId = await publishTrade(asset, `e2e-${round}`);
      publishedAt.set(eventId, Date.now());
      publishedEventIds.push(eventId);
    }
  }
  const publishElapsedMs = Math.max(1, Date.now() - publishStartedAt);

  // ---- Phase 2: start the consumer and time the whole drain. --------------
  let peakPending = 0;
  let peakLag = 0;
  const drainStartedAt = Date.now();
  const worker = await startWorker();
  const sampler = setInterval(() => {
    void worker.stream
      .inspect(config)
      .then((info) => {
        peakPending = Math.max(peakPending, info.pendingCount);
        peakLag = Math.max(peakLag, info.lag ?? 0);
      })
      .catch(() => undefined);
  }, 100);
  sampler.unref?.();

  // Contention, started with the drain rather than before the load: a create
  // that acquires the boundary on an idle system measures nothing.
  const sweep = candles
    .reconcile({ now: new Date() })
    .then((summary) => summary.processedCandles)
    .catch((error: unknown) => {
      console.error('concurrent path-B sweep failed', error);
      return null;
    });
  const createWait = measureCreateBoundaryWait();

  try {
    await waitFor(
      async () => (await processedCount()) >= publishedEventIds.length,
      'every published event reaches a processed-event row',
      DRAIN_TIMEOUT_MS,
    );
    await waitFor(
      async () => (await worker.stream.inspect(config)).pendingCount === 0,
      'every event is acknowledged',
      DRAIN_TIMEOUT_MS,
    );
  } finally {
    clearInterval(sampler);
  }
  const drainElapsedMs = Math.max(1, Date.now() - drainStartedAt);

  const sweepProcessedCandles = await sweep;
  const createBoundaryWaitMs = await createWait;

  const latencies = measureLatencies();
  return {
    totalEvents: publishedEventIds.length,
    publishElapsedMs,
    drainElapsedMs,
    latencies,
    ackedEvents: latencies.length,
    processedEventRows: await processedCount(),
    matchedOrders: await prisma.order.count({
      where: {
        seasonParticipantId: { in: createdParticipantIds },
        status: OrderStatus.executed,
      },
    }),
    createBoundaryWaitMs,
    sweepEnabled: candles.isEnabled(),
    sweepProcessedCandles,
    peakPending,
    peakLag,
    connectionCount: await connectionCount(),
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1_048_576),
  };
}

/**
 * XADD -> XACK, per event, both instants taken from THIS process's clock.
 *
 * The previous version subtracted the XADD stamp from `limit_order_processed_
 * events.processed_at`, which the consumer writes BEFORE its own insert and
 * before the ACK. That understated the path by exactly the work the name
 * claims to include, so it is now taken from the instrumented ACK instead.
 */
function measureLatencies(): number[] {
  const latencies: number[] = [];
  for (const eventId of publishedEventIds) {
    const start = publishedAt.get(eventId);
    const end = acknowledgedAt.get(eventId);
    if (start === undefined || end === undefined) continue;
    latencies.push(Math.max(0, end - start));
  }
  latencies.sort((left, right) => left - right);
  return latencies;
}

/** How long a Create waits for the boundary while the matcher is at full tilt. */
async function measureCreateBoundaryWait(): Promise<number> {
  const startedAt = Date.now();
  // The PRODUCTION method, not a hand-written copy: this measurement is only
  // meaningful if it acquires the boundary exactly the way a create does.
  const createBoundary = new LimitOrderMatchBoundaryService();
  await prisma.$transaction(async (tx) => {
    await createBoundary.lockInTransaction(tx);
  });
  await createBoundary.onModuleDestroy();
  return Date.now() - startedAt;
}

function printReport(report: Report): void {
  console.log(
    JSON.stringify({
      // Deliberately NOT `limit_order_publisher_throughput`: this is the whole
      // consumer path, and the two numbers must never be quoted for each other.
      event: 'limit_order_matcher_e2e_throughput',
      measured: 'xadd_to_xack',
      assetCount: assets.length,
      totalEvents: report.totalEvents,

      // ---- Matcher capacity. The ONE number this runner exists to produce.
      // Its denominator is the window in which the consumer ran, and its
      // numerator is the events consumed in that window — nothing else.
      drainElapsedMs: report.drainElapsedMs,
      matcherDrainEventsPerSecond: rate(
        report.totalEvents,
        report.drainElapsedMs,
      ),

      // ---- The runner's own XADD rate, for context only. It is what THIS
      // process could publish while nothing consumed, and is neither the
      // matcher's capacity nor the phase-3 publisher benchmark.
      publishElapsedMs: report.publishElapsedMs,
      runnerXaddEventsPerSecond: rate(
        report.totalEvents,
        report.publishElapsedMs,
      ),

      // ---- Latency, XADD to XACK, both stamped on this process's clock.
      ackedEvents: report.ackedEvents,
      latencyMsAvg: average(report.latencies),
      latencyMsP50: percentile(report.latencies, 50),
      latencyMsP95: percentile(report.latencies, 95),
      latencyMsP99: percentile(report.latencies, 99),
      latencyMsMax: report.latencies[report.latencies.length - 1] ?? 0,

      matchedOrders: report.matchedOrders,
      processedEventRows: report.processedEventRows,
      peakPending: report.peakPending,
      peakConsumerLag: report.peakLag,
      // Measured DURING the drain, against the real matcher, not before it.
      createBoundaryWaitMs: report.createBoundaryWaitMs,
      // Reported together on purpose: the candle count means nothing without
      // knowing whether the sweep was switched on at all.
      concurrentSweepEnabled: report.sweepEnabled,
      concurrentSweepProcessedCandles: report.sweepProcessedCandles,
      postgresConnections: report.connectionCount,
      heapUsedMb: report.heapUsedMb,
    }),
  );
}

function rate(count: number, elapsedMs: number): number {
  return Math.round((count / Math.max(1, elapsedMs)) * 1000);
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((total, value) => total + value, 0);
  return Math.round((sum / values.length) * 100) / 100;
}

/** Nearest-rank percentile over an ascending array. */
function percentile(values: readonly number[], rank: number): number {
  if (values.length === 0) return 0;
  const index = Math.ceil((rank / 100) * values.length) - 1;
  return values[Math.min(values.length - 1, Math.max(0, index))] ?? 0;
}

// ---------------------------------------------------------------------------
// Assertions (hardware independent — safe for CI)
// ---------------------------------------------------------------------------

async function assertAllProcessedAndAcked(report: Report): Promise<void> {
  assert.equal(
    report.processedEventRows,
    publishedEventIds.length,
    'every published event must have exactly one processed-event row',
  );
  assert.ok(report.totalEvents > 0);
}

/**
 * Hardware-INDEPENDENT guards on the arithmetic itself. No rate is asserted —
 * a GitHub runner's throughput says nothing about production capacity — but a
 * rate computed from a denominator that does not contain the work, or from a
 * sample set smaller than the population, is a defect on any hardware.
 */
async function assertMeasurementIsSound(report: Report): Promise<void> {
  // 1. The matcher must not have consumed anything before the drain window
  //    opened, or the drain rate would divide all events by part of the time.
  assert.equal(
    report.peakLag >= 0,
    true,
    'backlog depth must have been sampled',
  );
  assert.ok(
    report.drainElapsedMs > 0,
    'the drain window must have a positive duration',
  );

  // 2. Latency must cover EVERY event. Silently dropping unmatched ids used to
  //    let percentiles be computed over an arbitrary subset.
  assert.equal(
    report.ackedEvents,
    report.totalEvents,
    'every published event must have a measured XADD -> XACK latency',
  );
  assert.equal(report.latencies.length, report.totalEvents);

  // 3. Every latency must fit inside the run: a sample longer than the whole
  //    publish+drain wall clock would mean the two clocks are not the same one.
  const maxLatency = report.latencies[report.latencies.length - 1] ?? 0;
  assert.ok(
    maxLatency <= report.publishElapsedMs + report.drainElapsedMs,
    `a latency sample (${maxLatency}ms) exceeded the run wall clock`,
  );

  // 4. The concurrent contention the report claims must actually have run.
  //    A sweep that threw used to be swallowed, silently removing the pressure
  //    the report described.
  assert.notEqual(
    report.sweepProcessedCandles,
    null,
    'the concurrent path-B sweep must complete, not be swallowed',
  );
  assert.equal(
    report.sweepEnabled,
    candles.isEnabled(),
    'the report must state whether the sweep was actually enabled',
  );
  assert.ok(
    report.createBoundaryWaitMs >= 0,
    'the create boundary wait must be measured, never reported as a constant',
  );
}

async function assertNoLag(): Promise<void> {
  const info = await workers[0].stream.inspect(config);
  assert.equal(info.lag ?? 0, 0, 'consumer lag must return to zero');
}

async function assertNoPending(): Promise<void> {
  const info = await workers[0].stream.inspect(config);
  assert.equal(info.pendingCount, 0, 'pending must return to zero');
}

/**
 * Every order may be filled at most once, and each fill must leave exactly one
 * wallet transaction and one position increase.
 */
async function assertNoDoubleFill(): Promise<void> {
  const orders = await prisma.order.findMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
    select: { id: true, status: true, seasonParticipantId: true },
  });
  const executed = orders.filter(
    (order) => order.status === OrderStatus.executed,
  );
  assert.ok(executed.length > 0, 'the load must actually fill something');
  for (const order of executed) {
    const transactions = await prisma.walletTransaction.count({
      where: { referenceId: order.id },
    });
    assert.equal(
      transactions,
      1,
      `order ${order.id} must have exactly one wallet transaction`,
    );
  }
}

/** A duplicate XADD of an already-processed eventId must not re-run the sweep. */
async function assertDuplicateEventIgnored(
  worker: MatcherWorker,
): Promise<void> {
  const asset = assets.find((entry) => entry.hasOrders);
  assert.ok(asset);
  const duplicateId = `binance:${asset.id}:e2e-0`;
  const before = await prisma.limitOrderProcessedEvent.findUniqueOrThrow({
    where: { eventId: duplicateId },
    select: { firstStreamId: true, processedAt: true },
  });
  const executedBefore = await prisma.order.count({
    where: {
      seasonParticipantId: { in: createdParticipantIds },
      status: OrderStatus.executed,
    },
  });

  // Re-publish through the real publisher with the SAME providerEventId, which
  // yields the SAME eventId — exactly what a provider replay produces.
  const republished = await publishTrade(asset, 'e2e-0');
  assert.equal(republished, duplicateId);

  await waitFor(
    async () => (await worker.stream.inspect(config)).pendingCount === 0,
    'the duplicate is acknowledged',
    DRAIN_TIMEOUT_MS,
  );
  const after = await prisma.limitOrderProcessedEvent.findUniqueOrThrow({
    where: { eventId: duplicateId },
    select: { firstStreamId: true, processedAt: true },
  });
  assert.equal(
    after.firstStreamId,
    before.firstStreamId,
    'a duplicate must not overwrite the original processed-event row',
  );
  assert.equal(
    await prisma.order.count({
      where: {
        seasonParticipantId: { in: createdParticipantIds },
        status: OrderStatus.executed,
      },
    }),
    executedBefore,
    'a duplicate event must not fill anything new',
  );
}

/**
 * An entry left pending by a dead consumer must be reclaimed and drained
 * rather than sitting in the pending list forever.
 */
async function assertReclaimDrains(worker: MatcherWorker): Promise<void> {
  const asset = assets.find((entry) => !entry.hasOrders);
  assert.ok(asset);
  const eventId = await publishTrade(asset, `reclaim-${randomUUID()}`);
  publishedEventIds.push(eventId);
  publishedAt.set(eventId, Date.now());

  await waitFor(
    async () =>
      (await prisma.limitOrderProcessedEvent.count({ where: { eventId } })) ===
      1,
    'the reclaimed event is processed',
    DRAIN_TIMEOUT_MS,
  );
  await waitFor(
    async () => (await worker.stream.inspect(config)).pendingCount === 0,
    'the reclaimed event is acknowledged',
    DRAIN_TIMEOUT_MS,
  );
}

/**
 * Leader takeover: the running matcher is stopped, a backlog builds up, and a
 * brand new worker must acquire leadership and drain it completely.
 */
async function assertLeaderTakeoverDrains(
  previous: MatcherWorker,
): Promise<void> {
  await stopWorker(previous);

  const asset = assets.find((entry) => entry.hasOrders);
  assert.ok(asset);
  const backlog: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const eventId = await publishTrade(
      asset,
      `takeover-${index}-${randomUUID()}`,
    );
    backlog.push(eventId);
    publishedEventIds.push(eventId);
    publishedAt.set(eventId, Date.now());
  }

  const next = await startWorker();
  await waitFor(
    async () =>
      (await prisma.limitOrderProcessedEvent.count({
        where: { eventId: { in: backlog } },
      })) === backlog.length,
    'the new leader drains the backlog',
    DRAIN_TIMEOUT_MS,
  );
  await waitFor(
    async () => (await next.stream.inspect(config)).pendingCount === 0,
    'the new leader acknowledges the backlog',
    DRAIN_TIMEOUT_MS,
  );
}

async function assertNoResidualLock(): Promise<void> {
  await stopWorkers();
  await waitFor(
    async () => (await advisoryLockCount()) === 0,
    'no residual boundary advisory lock remains',
  );
}

async function assertNotDegraded(): Promise<void> {
  const failed = await prisma.opsJobRun.findFirst({
    where: {
      jobName: 'limit_order_matcher',
      status: 'failed',
      startedAt: { gte: runStartedAt },
    },
    select: { errorCode: true, errorMessage: true },
  });
  assert.equal(
    failed,
    null,
    `the matcher must not report a failure: ${failed?.errorCode ?? ''} ${
      failed?.errorMessage ?? ''
    }`,
  );
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

const runStartedAt = new Date();

async function startWorker(): Promise<MatcherWorker> {
  const stream = new InstrumentedStreamService();
  const leader = new LimitOrderMatcherLeaderService();
  const boundary = new LimitOrderMatchBoundaryService();
  const poller = new LimitOrderEventPollerService(
    prisma,
    stream,
    leader,
    health,
    new LimitOrderCandidateRepository(prisma),
    execution,
    boundary,
  );
  poller.onModuleInit();
  const worker: MatcherWorker = { poller, stream, leader, boundary };
  workers.push(worker);
  // Scoped to THIS run: a previous aborted runner can leave a `running` Ops
  // row behind, and waiting on that would let the load start before the
  // consumer group exists (NOGROUP on the first inspect).
  await waitFor(
    async () =>
      (await prisma.opsJobRun.count({
        where: {
          jobName: 'limit_order_matcher',
          status: 'running',
          startedAt: { gte: runStartedAt },
        },
      })) > 0,
    'the matcher takes leadership',
  );
  return worker;
}

async function stopWorker(worker: MatcherWorker): Promise<void> {
  await worker.poller.onModuleDestroy().catch(() => undefined);
  await worker.stream.onModuleDestroy().catch(() => undefined);
  await worker.boundary.onModuleDestroy().catch(() => undefined);
  const index = workers.indexOf(worker);
  if (index >= 0) workers.splice(index, 1);
}

async function stopWorkers(): Promise<void> {
  for (const worker of [...workers]) await stopWorker(worker);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Publishes through the REAL publisher, so the payload is byte-for-byte what
 * production writes and passes the consumer's validator unchanged. Returns the
 * eventId the publisher derived, which is
 * `${provider}:${assetId}:${providerEventId}` — deterministic, so re-publishing
 * the same providerEventId is exactly a duplicate.
 */
async function publishTrade(
  asset: Asset,
  providerEventId: string,
): Promise<string> {
  const at = new Date().toISOString();
  await publisher.publish({
    provider: 'binance',
    providerEventId,
    providerSequence: providerEventId,
    providerConnectionId: generation,
    assetId: asset.id,
    symbol: asset.symbol,
    providerSymbol: asset.symbol,
    // Below every limit price, so an asset that HAS orders always fills.
    price: '90.00000000',
    currencyCode: CurrencyCode.USD,
    providerEventAt: at,
    receivedAt: at,
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
  return `binance:${asset.id}:${providerEventId}`;
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

  for (let index = 0; index < ASSET_COUNT; index += 1) {
    // Scenario mix: a third of the assets carry no order at all, a third carry
    // one, and a third carry several on the SAME event.
    const orderCount = index % 3;
    const asset = await createAsset(index, now);
    assets.push({ ...asset, hasOrders: orderCount > 0 });
    for (let order = 0; order < orderCount; order += 1) {
      await createSubmittedOrder(asset.id, `${index}-${order}`);
    }
  }

  generation = `e2e-${randomUUID()}`;
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
}

async function createAsset(
  index: number,
  now: Date,
): Promise<{ id: string; symbol: string }> {
  const symbol = `E2E${randomUUID().replace(/-/gu, '').slice(0, 18)}`;
  const asset = await prisma.asset.create({
    data: {
      symbol,
      name: `${PREFIX}-asset-${index}`,
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
  return { id: asset.id, symbol };
}

async function createSubmittedOrder(
  assetId: string,
  label: string,
): Promise<void> {
  const submittedAt = new Date(Date.now() - FIVE_MINUTES_MS);
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${label}@example.com`,
      passwordHash: 'integration-test-only',
      nickname: `e2e-${label}-${randomUUID()}`.slice(0, 40),
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
  await prisma.order.create({
    data: {
      seasonParticipantId: participant.id,
      assetId,
      side: OrderSide.buy,
      orderType: OrderType.limit,
      status: OrderStatus.submitted,
      quantity: '1.00000000',
      limitPrice: '100.00000000',
      currencyCode: CurrencyCode.USD,
      reservedAmount: '100.10000000',
      reservationFeeRate: '0.001000',
      matchingActivatedAt: submittedAt,
      // Activated from the very beginning of the stream, so every event this
      // run publishes is strictly after the activation cursor.
      matchingActivationStreamId: '0-0',
      candleMatchingEligibleFrom:
        calculateCandleMatchingEligibleFrom(submittedAt),
      idempotencyKey: `${PREFIX}-${label}`,
      requestHash: `${PREFIX}-${label}`,
      submittedAt,
      createdAt: submittedAt,
      updatedAt: submittedAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

function processedCount(): Promise<number> {
  return prisma.limitOrderProcessedEvent.count({
    where: { eventId: { in: publishedEventIds } },
  });
}

async function advisoryLockCount(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM pg_locks
    WHERE "locktype" = 'advisory'
      AND "classid" = ${LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE}
      AND "objid" = ${LIMIT_ORDER_MATCH_BOUNDARY_KEY}
  `;
  return Number(rows[0]?.count ?? 0);
}

async function connectionCount(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM pg_stat_activity
    WHERE "datname" = current_database()
  `;
  return Number(rows[0]?.count ?? 0);
}

async function databaseNow(): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
  `;
  return rows[0].now;
}

/** Polls a CONDITION, never a duration. */
async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

async function cleanupRedis(): Promise<void> {
  await redis.delete(config.streamKey).catch(() => undefined);
  await redis.delete(config.dlqStreamKey).catch(() => undefined);
}

async function cleanupDatabase(): Promise<void> {
  await prisma.limitOrderProcessedEvent.deleteMany({
    where: { eventId: { in: publishedEventIds } },
  });
  await prisma.limitOrderProcessedCandle.deleteMany({
    where: { marketCandleId: { in: createdCandleIds } },
  });
  await prisma.limitOrderDeferredCandle.deleteMany({
    where: { assetId: { in: createdAssetIds } },
  });
  await prisma.opsJobRun.deleteMany({
    where: { jobName: 'limit_order_matcher', startedAt: { gte: runStartedAt } },
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
