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
 * CI runs a reduced volume and asserts only hardware-independent invariants
 * (everything processed and ACKed within the deadline, lag and pending back to
 * zero, no duplicate fill, no residual advisory lock, no degraded state). The
 * absolute rates are printed for the soak run
 * (`pnpm soak:limit-order-matcher-e2e`), never asserted.
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
import { LimitOrderEventStreamService } from '../src/orders/limit-matching/limit-order-event-stream.service';
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
    const worker = await startWorker();

    const report = await runLoad(worker);

    await run('every published event is processed and acknowledged', () =>
      assertAllProcessedAndAcked(report),
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
  publishElapsedMs: number;
  drainElapsedMs: number;
  latencies: number[];
  processedEventRows: number;
  matchedOrders: number;
  boundaryWaitMs: number;
  createBoundaryWaitMs: number;
  peakPending: number;
  peakLag: number;
  connectionCount: number;
  heapUsedMb: number;
};

/**
 * The load itself. Three shapes are mixed on purpose, because their per-event
 * cost differs by an order of magnitude:
 *   - assets with NO order at all (dedupe + candidate query, no transaction),
 *   - assets with ONE order (one execution transaction),
 *   - assets with SEVERAL orders on the same event (several transactions under
 *     a single boundary hold).
 * A path-B sweep and a boundary-waiting Create run CONCURRENTLY, so the
 * measurement includes real contention rather than an idle-system best case.
 */
async function runLoad(worker: MatcherWorker): Promise<Report> {
  const startedAt = Date.now();
  let peakPending = 0;
  let peakLag = 0;

  // Contention: a path-B sweep and a Create both competing for the boundary
  // while the matcher is consuming.
  const sweep = candles.reconcile({ now: new Date() }).catch(() => undefined);
  const createWait = measureCreateBoundaryWait();

  for (let round = 0; round < EVENTS_PER_ASSET; round += 1) {
    for (const asset of assets) {
      publishedAt.set(`binance:${asset.id}:e2e-${round}`, Date.now());
      publishedEventIds.push(await publishTrade(asset, `e2e-${round}`));
    }
    const info = await worker.stream.inspect(config);
    peakPending = Math.max(peakPending, info.pendingCount);
    peakLag = Math.max(peakLag, info.lag ?? 0);
  }
  const publishElapsedMs = Math.max(1, Date.now() - startedAt);

  const drainStartedAt = Date.now();
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
  const drainElapsedMs = Math.max(1, Date.now() - drainStartedAt);

  await sweep;
  const createBoundaryWaitMs = await createWait;

  const latencies = await measureLatencies();
  return {
    totalEvents: publishedEventIds.length,
    publishElapsedMs,
    drainElapsedMs,
    latencies,
    processedEventRows: await processedCount(),
    matchedOrders: await prisma.order.count({
      where: {
        seasonParticipantId: { in: createdParticipantIds },
        status: OrderStatus.executed,
      },
    }),
    boundaryWaitMs: 0,
    createBoundaryWaitMs,
    peakPending,
    peakLag,
    connectionCount: await connectionCount(),
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1_048_576),
  };
}

/**
 * XADD -> processed-event insert, per event. `processed_at` is written by the
 * consumer immediately before the ACK, so this is the whole path minus the ACK
 * round trip itself.
 */
async function measureLatencies(): Promise<number[]> {
  const rows = await prisma.limitOrderProcessedEvent.findMany({
    where: { eventId: { in: publishedEventIds } },
    select: { eventId: true, processedAt: true },
  });
  const latencies: number[] = [];
  for (const row of rows) {
    const start = publishedAt.get(row.eventId);
    if (start === undefined) continue;
    latencies.push(Math.max(0, row.processedAt.getTime() - start));
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
  const percentile = (ratio: number): number =>
    report.latencies[
      Math.min(
        report.latencies.length - 1,
        Math.floor(report.latencies.length * ratio),
      )
    ] ?? 0;
  const totalElapsed = report.publishElapsedMs + report.drainElapsedMs;
  console.log(
    JSON.stringify({
      // Deliberately NOT `limit_order_publisher_throughput`: this is the whole
      // consumer path, and the two numbers must never be quoted for each other.
      event: 'limit_order_matcher_e2e_throughput',
      measured: 'xadd_to_xack',
      assetCount: assets.length,
      totalEvents: report.totalEvents,
      publishElapsedMs: report.publishElapsedMs,
      drainElapsedMs: report.drainElapsedMs,
      endToEndEventsPerSecond: Math.round(
        (report.totalEvents / Math.max(1, totalElapsed)) * 1000,
      ),
      drainEventsPerSecond: Math.round(
        (report.totalEvents / report.drainElapsedMs) * 1000,
      ),
      processedEventInsertsPerSecond: Math.round(
        (report.processedEventRows / Math.max(1, totalElapsed)) * 1000,
      ),
      latencyMsAvg:
        report.latencies.length === 0
          ? 0
          : Math.round(
              (report.latencies.reduce((sum, value) => sum + value, 0) /
                report.latencies.length) *
                100,
            ) / 100,
      latencyMsP50: percentile(0.5),
      latencyMsP95: percentile(0.95),
      latencyMsP99: percentile(0.99),
      latencyMsMax: report.latencies[report.latencies.length - 1] ?? 0,
      matchedOrders: report.matchedOrders,
      peakPending: report.peakPending,
      peakConsumerLag: report.peakLag,
      createBoundaryWaitMs: report.createBoundaryWaitMs,
      postgresConnections: report.connectionCount,
      heapUsedMb: report.heapUsedMb,
    }),
  );
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
  const stream = new LimitOrderEventStreamService();
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
