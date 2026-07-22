import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import IORedis from 'ioredis';
import {
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  SeasonStatus,
  UserRole,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { NormalizedProviderTradeEventBus } from '../src/providers/normalized-provider-trade-event-bus.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { LimitOrderCandidateRepository } from '../src/orders/limit-matching/limit-order-candidate.repository';
import { LimitOrderEventPollerService } from '../src/orders/limit-matching/limit-order-event-poller.service';
import { LimitOrderEventStreamService } from '../src/orders/limit-matching/limit-order-event-stream.service';
import { LimitOrderExecutionService } from '../src/orders/limit-matching/limit-order-execution.service';
import { LimitOrderMatcherHealthService } from '../src/orders/limit-matching/limit-order-matcher-health.service';
import { LimitOrderMatcherLeaderService } from '../src/orders/limit-matching/limit-order-matcher-leader.service';
import { readLimitOrderMatchingConfig } from '../src/orders/limit-matching/limit-order-matching.config';
import { LimitOrderPriceEventPublisher } from '../src/orders/limit-matching/limit-order-price-event.publisher';
import { buildLimitOrderPriceEvent } from '../src/orders/limit-matching/limit-order-price-event.types';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { OperatorAuditService } from '../src/operator/operator-audit.service';
import { OperatorSeasonModerationService } from '../src/operator/operator-season-moderation.service';

const PREFIX = `limit-order-auto-integration-${process.pid}-${Date.now()}`;
const ZERO = '0.00000000';
const prisma = new PrismaService();
const redis = new RedisService();
const tradeBus = new NormalizedProviderTradeEventBus();
const publisherHealth = new LimitOrderMatcherHealthService(prisma);
const publisher = new LimitOrderPriceEventPublisher(
  prisma,
  redis,
  tradeBus,
  publisherHealth,
);
const createdParticipantIds: string[] = [];
const createdUserIds: string[] = [];
const createdOpsRunIds: string[] = [];
const eventIds: string[] = [];
let seasonId: string;
let assetId: string;
let fxRateSnapshotId: string;
let poller: LimitOrderEventPollerService | null = null;
let pollerStream: LimitOrderEventStreamService | null = null;
let executionService: LimitOrderExecutionService;
let operator: { userId: string; role: UserRole };

const rankingStub = {
  refreshCurrentRankingAfterParticipantChange: () =>
    Promise.resolve({ skipped: false }),
};

async function main(): Promise<void> {
  requireEnvironment();
  await prisma.$connect();
  await redis.connect();
  try {
    await createSharedMarket();
    await run(
      'postgres advisory leader and standby takeover',
      testLeaderAndStandby,
    );
    await run('pending event recovery executes once', testPendingRecovery);
    await run(
      'normal execution and price improvement accounting',
      testPriceImprovement,
    );
    await run('price above limit remains submitted', testPriceNotReached);
    await run(
      'pre-submission receiver timestamp remains submitted',
      testPreSubmissionEvent,
    );
    await run(
      'duplicate event never double fills or fills a later order',
      testDuplicateEvent,
    );
    await stopPoller();
    await run(
      'cancel and execution each win one deterministic ordering',
      testCancelVsExecution,
    );
    await run(
      'exclusion and execution each win one deterministic ordering',
      testExclusionVsExecution,
    );
    await run(
      'season ending and execution each win one deterministic ordering',
      testSeasonEndVsExecution,
    );
    await run(
      'publisher Redis outage degrades matcher while cancel remains available',
      testPublisherRedisOutage,
    );
    await run(
      'stream retention gap fails closed without a price fallback',
      testStreamGapFailClosed,
    );
    console.log('limit order auto execution postgres redis integration ok');
  } finally {
    if (poller) await poller.onModuleDestroy().catch(() => undefined);
    if (pollerStream)
      await pollerStream.onModuleDestroy().catch(() => undefined);
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
}

async function run(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  console.log(`ok ${name}`);
}

async function createSharedMarket(): Promise<void> {
  const now = await databaseNow();
  const season = await prisma.season.create({
    data: {
      name: PREFIX,
      status: SeasonStatus.active,
      startAt: new Date(now.getTime() - 60_000),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: '1300000.00000000',
      tradeFeeRate: '0.050000',
      fxFeeRate: '0.001000',
    },
    select: { id: true },
  });
  seasonId = season.id;
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
  const operatorUser = await prisma.user.create({
    data: {
      email: `${PREFIX}-operator@example.com`,
      passwordHash: 'integration-test-only',
      nickname: `limit-op-${process.pid}-${randomUUID()}`.slice(0, 40),
      role: UserRole.operator,
    },
    select: { id: true, role: true },
  });
  createdUserIds.push(operatorUser.id);
  operator = { userId: operatorUser.id, role: operatorUser.role };
}

async function testLeaderAndStandby(): Promise<void> {
  const first = new LimitOrderMatcherLeaderService();
  const second = new LimitOrderMatcherLeaderService();
  try {
    assert.equal(await first.tryAcquire(), true);
    await first.assertHeld();
    assert.equal(await second.tryAcquire(), false);
    await first.release();
    assert.equal(await second.tryAcquire(), true);
    await second.assertHeld();
  } finally {
    await first.release();
    await second.release();
  }
}

async function startPoller(): Promise<void> {
  pollerStream = new LimitOrderEventStreamService();
  const leader = new LimitOrderMatcherLeaderService();
  const health = new LimitOrderMatcherHealthService(prisma);
  const candidates = new LimitOrderCandidateRepository(prisma);
  const valuation = new PortfolioValuationService(prisma);
  executionService = new LimitOrderExecutionService(
    prisma,
    valuation,
    rankingStub as never,
  );
  poller = new LimitOrderEventPollerService(
    prisma,
    pollerStream,
    leader,
    health,
    candidates,
    executionService,
  );
  poller.onModuleInit();
  await waitFor(async () => {
    const run = await prisma.opsJobRun.findFirst({
      where: { jobName: 'limit_order_matcher', status: 'running' },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    if (run && !createdOpsRunIds.includes(run.id)) {
      createdOpsRunIds.push(run.id);
    }
    return Boolean(run);
  }, 'matcher leader health');
  await health.assertAvailable();
}

async function stopPoller(): Promise<void> {
  if (poller) await poller.onModuleDestroy();
  if (pollerStream) await pollerStream.onModuleDestroy();
  poller = null;
  pollerStream = null;
}

async function testPendingRecovery(): Promise<void> {
  const config = readLimitOrderMatchingConfig();
  const abandonedStream = new LimitOrderEventStreamService();
  await abandonedStream.ensureConsumerGroup(config);
  const scenario = await createSubmittedOrder({
    label: 'pending',
    limitPrice: '100.00000000',
    quantity: '1.00000000',
    reservedAmount: '100.10000000',
  });
  const eventId = await publishTrade('pending-event', '90.00000000');
  const abandoned = await abandonedStream.readNew(config);
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].eventId, eventId);
  await abandonedStream.onModuleDestroy();

  const laterScenario = await createSubmittedOrder({
    label: 'pending-newer',
    limitPrice: '85.00000000',
    quantity: '1.00000000',
    reservedAmount: '85.08500000',
  });
  await publishTrade('pending-newer-event', '80.00000000');

  // Start before XAUTOCLAIM's idle boundary. A correct standby reports the
  // older pending event plus one unit of lag and refuses to read the newer
  // event. This state barrier proves ordering without a sleep-based race.
  await startPoller();
  const firstHeartbeat = await latestMatcherHeartbeat();
  await waitFor(async () => {
    const heartbeat = await latestMatcherHeartbeat();
    return (
      heartbeat.lastHeartbeat !== firstHeartbeat.lastHeartbeat &&
      heartbeat.pendingCount === 1 &&
      heartbeat.consumerLag === 1
    );
  }, 'standby waits behind non-claimable pending event');
  assert.equal(
    (
      await prisma.order.findUniqueOrThrow({
        where: { id: laterScenario.orderId },
        select: { status: true },
      })
    ).status,
    OrderStatus.submitted,
  );

  await waitForOrderStatus(scenario.orderId, OrderStatus.executed);
  await waitForOrderStatus(laterScenario.orderId, OrderStatus.executed);
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: scenario.orderId },
    }),
    1,
  );
  const inspection = await pollerStream!.inspect(config);
  assert.equal(inspection.pendingCount, 0);
}

async function latestMatcherHeartbeat(): Promise<{
  lastHeartbeat: string | null;
  pendingCount: number | null;
  consumerLag: number | null;
}> {
  const row = await prisma.opsJobRun.findFirstOrThrow({
    where: { jobName: 'limit_order_matcher', status: 'running' },
    orderBy: { startedAt: 'desc' },
    select: { metadataJson: true },
  });
  const metadata =
    row.metadataJson &&
    typeof row.metadataJson === 'object' &&
    !Array.isArray(row.metadataJson)
      ? (row.metadataJson as Record<string, unknown>)
      : {};
  return {
    lastHeartbeat:
      typeof metadata.lastHeartbeat === 'string'
        ? metadata.lastHeartbeat
        : null,
    pendingCount:
      typeof metadata.pendingCount === 'number' ? metadata.pendingCount : null,
    consumerLag:
      typeof metadata.consumerLag === 'number' ? metadata.consumerLag : null,
  };
}

async function testPriceImprovement(): Promise<void> {
  const scenario = await createSubmittedOrder({
    label: 'improvement',
    limitPrice: '100.00000000',
    quantity: '2.00000000',
    reservedAmount: '200.20000000',
  });
  const initialPayload = await prisma.order.findUniqueOrThrow({
    where: { id: scenario.orderId },
    select: { responsePayloadJson: true },
  });
  const eventId = await publishTrade('improvement-event', '90.00000000');
  await waitForOrderStatus(scenario.orderId, OrderStatus.executed);

  const [order, wallet, transactions, position, snapshots] = await Promise.all([
    prisma.order.findUniqueOrThrow({
      where: { id: scenario.orderId },
      select: {
        status: true,
        executedPrice: true,
        grossAmount: true,
        feeAmount: true,
        netAmount: true,
        reservedAmount: true,
        reservationReleasedAt: true,
        assetPriceSnapshotId: true,
        triggerEventId: true,
        triggerEventAt: true,
        matchedAt: true,
        matchingSource: true,
        responsePayloadJson: true,
      },
    }),
    prisma.cashWallet.findUniqueOrThrow({
      where: { id: scenario.walletId },
      select: { balanceAmount: true, reservedAmount: true },
    }),
    prisma.walletTransaction.findMany({
      where: { referenceId: scenario.orderId },
    }),
    prisma.position.findUniqueOrThrow({
      where: {
        seasonParticipantId_assetId: {
          seasonParticipantId: scenario.participantId,
          assetId,
        },
      },
    }),
    prisma.equitySnapshot.findMany({
      where: { seasonParticipantId: scenario.participantId },
    }),
  ]);
  assert.equal(order.status, OrderStatus.executed);
  assert.equal(order.executedPrice?.toFixed(8), '90.00000000');
  assert.equal(order.grossAmount?.toFixed(8), '180.00000000');
  // The live season fee is 5%; the order's pinned fee is 0.1%.
  assert.equal(order.feeAmount?.toFixed(8), '0.18000000');
  assert.equal(order.netAmount?.toFixed(8), '180.18000000');
  assert.equal(order.reservedAmount?.toFixed(8), '200.20000000');
  assert.ok(order.reservationReleasedAt);
  const evidenceId = order.assetPriceSnapshotId;
  assert.ok(evidenceId);
  assert.equal(order.triggerEventId, eventId);
  assert.ok(order.triggerEventAt);
  assert.ok(order.matchedAt);
  assert.equal(order.matchingSource, 'live_trade_event');
  assert.deepEqual(
    order.responsePayloadJson,
    initialPayload.responsePayloadJson,
  );
  assert.equal(wallet.balanceAmount.toFixed(8), '819.82000000');
  assert.equal(wallet.reservedAmount.toFixed(8), ZERO);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].amount.toFixed(8), '180.18000000');
  assert.equal(transactions[0].balanceAfter.toFixed(8), '819.82000000');
  assert.equal(position.quantity.toFixed(8), '2.00000000');
  assert.equal(position.averageCost.toFixed(8), '90.09000000');
  assert.equal(snapshots.length, 1);
  const evidence = await prisma.assetPriceSnapshot.findUniqueOrThrow({
    where: { id: evidenceId },
  });
  assert.equal(evidence.providerEventKey, eventId);
  assert.equal(evidence.price.toFixed(8), '90.00000000');
}

async function testPriceNotReached(): Promise<void> {
  const scenario = await createSubmittedOrder({
    label: 'not-reached',
    limitPrice: '100.00000000',
    quantity: '1.00000000',
    reservedAmount: '100.10000000',
  });
  const eventId = await publishTrade('not-reached-event', '101.00000000');
  await waitForProcessedEvent(eventId);
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: scenario.orderId },
    select: { status: true },
  });
  const wallet = await prisma.cashWallet.findUniqueOrThrow({
    where: { id: scenario.walletId },
    select: { balanceAmount: true, reservedAmount: true },
  });
  assert.equal(order.status, OrderStatus.submitted);
  assert.equal(wallet.balanceAmount.toFixed(8), '1000.00000000');
  assert.equal(wallet.reservedAmount.toFixed(8), '100.10000000');
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: scenario.orderId },
    }),
    0,
  );
}

async function testPreSubmissionEvent(): Promise<void> {
  const scenario = await createSubmittedOrder({
    label: 'pre-submission-event',
    limitPrice: '100.00000000',
    quantity: '1.00000000',
    reservedAmount: '100.10000000',
  });
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: scenario.orderId },
    select: { submittedAt: true },
  });
  const oldTime = new Date(order.submittedAt.getTime() - 1000).toISOString();
  const providerTradeId = 'pre-submission-event';
  const eventId = `binance:${assetId}:${providerTradeId}`;
  eventIds.push(eventId);
  await publisher.publish({
    provider: 'binance',
    providerEventId: providerTradeId,
    providerSequence: providerTradeId,
    providerConnectionId: 'fixture-generation-1',
    assetId,
    symbol: 'BTCUSDT',
    providerSymbol: 'BTCUSDT',
    price: '90',
    currencyCode: CurrencyCode.USD,
    providerEventAt: oldTime,
    receivedAt: oldTime,
    sourceName: 'binance_spot_ws_trade',
    marketSessionCode: null,
    eventType: 'trade',
  });
  await waitForProcessedEvent(eventId);
  assert.equal(
    (
      await prisma.order.findUniqueOrThrow({
        where: { id: scenario.orderId },
        select: { status: true },
      })
    ).status,
    OrderStatus.submitted,
  );
}

async function testDuplicateEvent(): Promise<void> {
  const first = await createSubmittedOrder({
    label: 'duplicate-first',
    limitPrice: '100.00000000',
    quantity: '1.00000000',
    reservedAmount: '100.10000000',
  });
  const eventId = await publishTrade('duplicate-event', '95.00000000');
  await waitForOrderStatus(first.orderId, OrderStatus.executed);
  const later = await createSubmittedOrder({
    label: 'duplicate-later',
    limitPrice: '100.00000000',
    quantity: '1.00000000',
    reservedAmount: '100.10000000',
  });
  await publishTrade('duplicate-event', '95.00000000');
  await waitFor(async () => {
    const config = readLimitOrderMatchingConfig();
    const info = await pollerStream!.inspect(config);
    return info.pendingCount === 0 && info.lag === 0;
  }, 'duplicate event acknowledgement');

  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: first.orderId },
    }),
    1,
  );
  assert.equal(
    (
      await prisma.order.findUniqueOrThrow({
        where: { id: later.orderId },
        select: { status: true },
      })
    ).status,
    OrderStatus.submitted,
  );
  assert.equal(
    await prisma.assetPriceSnapshot.count({
      where: { providerEventKey: eventId },
    }),
    1,
  );
  assert.equal(
    await prisma.limitOrderProcessedEvent.count({ where: { eventId } }),
    1,
  );
}

async function testCancelVsExecution(): Promise<void> {
  const cancel = new LimitOrderCancelService(
    prisma,
    new OrderReservationService(),
  );

  const executionFirst = await createSubmittedOrder({
    label: 'cancel-execution-first',
    limitPrice: '100.00000000',
    quantity: '1.00000000',
    reservedAmount: '100.10000000',
  });
  const trigger = await createDirectTrigger('cancel-execution-first', '90');
  const blocker = await openClient('limit-auto-cancel-wallet-blocker');
  const observer = await openClient('limit-auto-cancel-observer');
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM cash_wallets WHERE id = $1 FOR UPDATE',
      [executionFirst.walletId],
    );
    const executionPromise = executionService.executeCandidate({
      orderId: executionFirst.orderId,
      seasonParticipantId: executionFirst.participantId,
      ...trigger,
    });
    await waitForBlockedSql(observer, 'cash_wallets');
    const cancelPromise = cancel.cancelOwnedLimitBuyOrder({
      userId: executionFirst.userId,
      orderId: executionFirst.orderId,
      canceledAt: new Date(),
    });
    await waitForBlockedSql(observer, 'orders');
    await blocker.query('COMMIT');
    assert.equal((await executionPromise).state, 'executed');
    await assert.rejects(cancelPromise, (error: unknown) => {
      return apiErrorCode(error) === 'ORDER_NOT_CANCELABLE';
    });
    await assertSingleSettlement(executionFirst);
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    await blocker.end();
    await observer.end();
  }

  const cancelFirst = await createSubmittedOrder({
    label: 'cancel-first',
    limitPrice: '100.00000000',
    quantity: '1.00000000',
    reservedAmount: '100.10000000',
  });
  await cancel.cancelOwnedLimitBuyOrder({
    userId: cancelFirst.userId,
    orderId: cancelFirst.orderId,
    canceledAt: new Date(),
  });
  const canceledTrigger = await createDirectTrigger('cancel-first', '90');
  assert.equal(
    (
      await executionService.executeCandidate({
        orderId: cancelFirst.orderId,
        seasonParticipantId: cancelFirst.participantId,
        ...canceledTrigger,
      })
    ).state,
    'skipped',
  );
  await assertCanceledWithoutDebit(cancelFirst);
}

async function testExclusionVsExecution(): Promise<void> {
  const reservation = new OrderReservationService();
  const cancel = new LimitOrderCancelService(prisma, reservation);
  const moderation = new OperatorSeasonModerationService(
    prisma,
    new OperatorAuditService(prisma),
    cancel,
  );

  const executionFirst = await createSubmittedOrder({
    label: 'exclusion-execution-first',
    limitPrice: '100.00000000',
    quantity: '1.00000000',
    reservedAmount: '100.10000000',
  });
  const trigger = await createDirectTrigger('exclusion-execution-first', '90');
  const blocker = await openClient('limit-auto-exclusion-wallet-blocker');
  const observer = await openClient('limit-auto-exclusion-observer');
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM cash_wallets WHERE id = $1 FOR UPDATE',
      [executionFirst.walletId],
    );
    const executionPromise = executionService.executeCandidate({
      orderId: executionFirst.orderId,
      seasonParticipantId: executionFirst.participantId,
      ...trigger,
    });
    await waitForBlockedSql(observer, 'cash_wallets');
    const exclusionPromise = moderation.excludeParticipant(
      operator,
      seasonId,
      executionFirst.participantId,
      { reason: 'integration race' },
    );
    await waitForBlockedSql(observer, 'season_participants');
    await blocker.query('COMMIT');
    assert.equal((await executionPromise).state, 'executed');
    await exclusionPromise;
    await assertSingleSettlement(executionFirst);
    assert.equal(
      (
        await prisma.order.findUniqueOrThrow({
          where: { id: executionFirst.orderId },
          select: { status: true },
        })
      ).status,
      OrderStatus.executed,
    );
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    await blocker.end();
    await observer.end();
  }

  const exclusionFirst = await createSubmittedOrder({
    label: 'exclusion-first',
    limitPrice: '100.00000000',
    quantity: '1.00000000',
    reservedAmount: '100.10000000',
  });
  await moderation.excludeParticipant(
    operator,
    seasonId,
    exclusionFirst.participantId,
    { reason: 'integration first' },
  );
  const excludedTrigger = await createDirectTrigger('exclusion-first', '90');
  assert.equal(
    (
      await executionService.executeCandidate({
        orderId: exclusionFirst.orderId,
        seasonParticipantId: exclusionFirst.participantId,
        ...excludedTrigger,
      })
    ).state,
    'skipped',
  );
  await assertCanceledWithoutDebit(exclusionFirst);
}

async function testSeasonEndVsExecution(): Promise<void> {
  const cancel = new LimitOrderCancelService(
    prisma,
    new OrderReservationService(),
  );
  const executionFirst = await createSubmittedOrder({
    label: 'season-execution-first',
    limitPrice: '100.00000000',
    quantity: '1.00000000',
    reservedAmount: '100.10000000',
  });
  const trigger = await createDirectTrigger('season-execution-first', '90');
  const blocker = await openClient('limit-auto-season-wallet-blocker');
  const ender = await openClient('limit-auto-season-ender');
  const observer = await openClient('limit-auto-season-observer');
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM cash_wallets WHERE id = $1 FOR UPDATE',
      [executionFirst.walletId],
    );
    const executionPromise = executionService.executeCandidate({
      orderId: executionFirst.orderId,
      seasonParticipantId: executionFirst.participantId,
      ...trigger,
    });
    await waitForBlockedSql(observer, 'cash_wallets');
    await ender.query('BEGIN');
    const endPromise = ender.query(
      "UPDATE seasons SET status = 'ended' WHERE id = $1",
      [seasonId],
    );
    await waitForBlockedApplication(observer, 'limit-auto-season-ender');
    await blocker.query('COMMIT');
    assert.equal((await executionPromise).state, 'executed');
    await endPromise;
    await ender.query('COMMIT');
    await cancel.cleanupEndedSeasonLimitReservations({ now: new Date() });
    await assertSingleSettlement(executionFirst);
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    await ender.query('ROLLBACK').catch(() => undefined);
    await blocker.end();
    await ender.end();
    await observer.end();
  }

  const seasonFirst = await createSubmittedOrder({
    label: 'season-first',
    limitPrice: '100.00000000',
    quantity: '1.00000000',
    reservedAmount: '100.10000000',
  });
  const endedTrigger = await createDirectTrigger('season-first', '90');
  assert.equal(
    (
      await executionService.executeCandidate({
        orderId: seasonFirst.orderId,
        seasonParticipantId: seasonFirst.participantId,
        ...endedTrigger,
      })
    ).state,
    'skipped',
  );
  await cancel.cleanupEndedSeasonLimitReservations({ now: new Date() });
  await assertCanceledWithoutDebit(seasonFirst);
}

async function testStreamGapFailClosed(): Promise<void> {
  const config = readLimitOrderMatchingConfig();
  const testStartedAt = await databaseNow();
  await createDirectTrigger('gap-trimmed-event', '90');
  await createDirectTrigger('gap-retained-event', '90');
  const lastId = await redis.lastStreamId(config.streamKey);
  assert.notEqual(lastId, '0-0');
  const raw = new IORedis(process.env.REDIS_URL!, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  try {
    await raw.connect();
    await raw.xtrim(config.streamKey, 'MINID', lastId);
  } finally {
    await raw.quit().catch(() => raw.disconnect());
  }

  pollerStream = new LimitOrderEventStreamService();
  const leader = new LimitOrderMatcherLeaderService();
  const health = new LimitOrderMatcherHealthService(prisma);
  poller = new LimitOrderEventPollerService(
    prisma,
    pollerStream,
    leader,
    health,
    new LimitOrderCandidateRepository(prisma),
    executionService,
  );
  poller.onModuleInit();
  await waitFor(async () => {
    const failed = await prisma.opsJobRun.findFirst({
      where: {
        jobName: 'limit_order_matcher',
        status: 'failed',
        errorCode: 'LIMIT_ORDER_EVENT_GAP_DETECTED',
        startedAt: { gte: testStartedAt },
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    if (failed && !createdOpsRunIds.includes(failed.id)) {
      createdOpsRunIds.push(failed.id);
    }
    return Boolean(failed);
  }, 'gap failure Ops row');
  await assert.rejects(
    health.assertAvailable(),
    (error: unknown) =>
      apiErrorCode(error) === 'LIMIT_ORDER_MATCHER_UNAVAILABLE',
  );
  await stopPoller();
}

async function testPublisherRedisOutage(): Promise<void> {
  await startPoller();
  const failureAt = await databaseNow();
  const unavailableRedis = new RedisService({
    url: 'redis://127.0.0.1:1',
    connectTimeoutMs: 100,
    commandTimeoutMs: 100,
  });
  const failingPublisher = new LimitOrderPriceEventPublisher(
    prisma,
    unavailableRedis,
    new NormalizedProviderTradeEventBus(),
    publisherHealth,
  );
  const now = await databaseNow();
  await assert.rejects(
    failingPublisher.publish({
      provider: 'binance',
      providerEventId: 'redis-outage',
      providerSequence: 'redis-outage',
      providerConnectionId: 'fixture-outage',
      assetId,
      symbol: 'BTCUSDT',
      providerSymbol: 'BTCUSDT',
      price: '90',
      currencyCode: CurrencyCode.USD,
      providerEventAt: now.toISOString(),
      receivedAt: now.toISOString(),
      sourceName: 'binance_spot_ws_trade',
      marketSessionCode: null,
      eventType: 'trade',
    }),
  );
  await unavailableRedis.onModuleDestroy();
  await stopPoller();

  const failed = await prisma.opsJobRun.findFirst({
    where: {
      jobName: 'limit_order_matcher',
      status: 'failed',
      errorCode: 'LIMIT_ORDER_EVENT_STREAM_UNAVAILABLE',
      finishedAt: { gte: failureAt },
    },
    orderBy: { finishedAt: 'desc' },
    select: { id: true },
  });
  assert.ok(failed);
  if (!createdOpsRunIds.includes(failed.id)) createdOpsRunIds.push(failed.id);
  await assert.rejects(
    publisherHealth.assertAvailable(),
    (error: unknown) =>
      apiErrorCode(error) === 'LIMIT_ORDER_MATCHER_UNAVAILABLE',
  );

  const cancelScenario = await createSubmittedOrder({
    label: 'cancel-during-stream-outage',
    limitPrice: '100.00000000',
    quantity: '1.00000000',
    reservedAmount: '100.10000000',
  });
  const cancel = new LimitOrderCancelService(
    prisma,
    new OrderReservationService(),
  );
  await cancel.cancelOwnedLimitBuyOrder({
    userId: cancelScenario.userId,
    orderId: cancelScenario.orderId,
    canceledAt: new Date(),
  });
  await assertCanceledWithoutDebit(cancelScenario);
}

async function createDirectTrigger(
  tradeId: string,
  price: string,
): Promise<{
  streamId: string;
  event: ReturnType<typeof buildLimitOrderPriceEvent>;
}> {
  const now = await databaseNow();
  const tick = {
    provider: 'binance' as const,
    providerEventId: tradeId,
    providerSequence: tradeId,
    providerConnectionId: 'fixture-race-generation',
    assetId,
    symbol: 'BTCUSDT',
    providerSymbol: 'BTCUSDT',
    price,
    currencyCode: CurrencyCode.USD,
    providerEventAt: now.toISOString(),
    receivedAt: now.toISOString(),
    sourceName: 'binance_spot_ws_trade',
    marketSessionCode: null,
    eventType: 'trade' as const,
  };
  const event = buildLimitOrderPriceEvent({
    tick,
    asset: {
      id: assetId,
      symbol: PREFIX.slice(0, 32),
      market: 'BINANCE',
      assetType: AssetType.crypto,
      settlementCurrency: CurrencyCode.USD,
    },
    publishedAt: now,
  });
  if (!eventIds.includes(event.eventId)) eventIds.push(event.eventId);
  const streamId = await publisher.publish(tick);
  return { streamId, event };
}

async function openClient(applicationName: string): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("SELECT set_config('application_name', $1, false)", [
    applicationName,
  ]);
  return client;
}

async function waitForBlockedSql(
  observer: Client,
  fragment: string,
): Promise<void> {
  await waitFor(async () => {
    const result = await observer.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1 LIMIT 1",
      [`%${fragment}%`],
    );
    return (result.rowCount ?? 0) > 0;
  }, `blocked SQL containing ${fragment}`);
}

async function waitForBlockedApplication(
  observer: Client,
  applicationName: string,
): Promise<void> {
  await waitFor(async () => {
    const result = await observer.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' LIMIT 1",
      [applicationName],
    );
    return (result.rowCount ?? 0) > 0;
  }, `blocked application ${applicationName}`);
}

async function assertSingleSettlement(scenario: {
  orderId: string;
  walletId: string;
}): Promise<void> {
  const wallet = await prisma.cashWallet.findUniqueOrThrow({
    where: { id: scenario.walletId },
    select: { balanceAmount: true, reservedAmount: true },
  });
  assert.equal(wallet.balanceAmount.toFixed(8), '909.91000000');
  assert.equal(wallet.reservedAmount.toFixed(8), ZERO);
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: scenario.orderId },
    }),
    1,
  );
}

async function assertCanceledWithoutDebit(scenario: {
  orderId: string;
  walletId: string;
}): Promise<void> {
  const [order, wallet, ledgerCount] = await Promise.all([
    prisma.order.findUniqueOrThrow({
      where: { id: scenario.orderId },
      select: { status: true },
    }),
    prisma.cashWallet.findUniqueOrThrow({
      where: { id: scenario.walletId },
      select: { balanceAmount: true, reservedAmount: true },
    }),
    prisma.walletTransaction.count({
      where: { referenceId: scenario.orderId },
    }),
  ]);
  assert.equal(order.status, OrderStatus.canceled);
  assert.equal(wallet.balanceAmount.toFixed(8), '1000.00000000');
  assert.equal(wallet.reservedAmount.toFixed(8), ZERO);
  assert.equal(ledgerCount, 0);
}

function apiErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('getResponse' in error)) {
    return null;
  }
  const getResponse = (error as { getResponse?: () => unknown }).getResponse;
  if (typeof getResponse !== 'function') return null;
  const response = getResponse.call(error) as
    | { error?: { code?: string } }
    | undefined;
  return response?.error?.code ?? null;
}

async function createSubmittedOrder(input: {
  label: string;
  limitPrice: string;
  quantity: string;
  reservedAmount: string;
}): Promise<{
  orderId: string;
  participantId: string;
  walletId: string;
  userId: string;
}> {
  const now = await databaseNow();
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
      joinedAt: now,
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
      reservedAmount: input.reservedAmount,
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
  const activationCursor = await redis.lastStreamId(
    readLimitOrderMatchingConfig().streamKey,
  );
  const orderId = randomUUID();
  await prisma.order.create({
    data: {
      id: orderId,
      seasonParticipantId: participant.id,
      assetId,
      side: OrderSide.buy,
      orderType: OrderType.limit,
      status: OrderStatus.submitted,
      quantity: input.quantity,
      limitPrice: input.limitPrice,
      currencyCode: CurrencyCode.USD,
      reservedAmount: input.reservedAmount,
      reservationFeeRate: '0.001000',
      matchingActivatedAt: now,
      matchingActivationStreamId: activationCursor,
      idempotencyKey: `${input.label}-key`,
      requestHash: `${input.label}-hash`,
      responsePayloadJson: {
        success: true,
        data: { execution: { state: 'submitted' } },
      },
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  return {
    orderId,
    participantId: participant.id,
    walletId: wallet.id,
    userId: user.id,
  };
}

async function publishTrade(
  providerTradeId: string,
  price: string,
): Promise<string> {
  const eventId = `binance:${assetId}:${providerTradeId}`;
  if (!eventIds.includes(eventId)) eventIds.push(eventId);
  await publisher.publish({
    provider: 'binance',
    providerEventId: providerTradeId,
    providerSequence: providerTradeId,
    providerConnectionId: 'fixture-generation-1',
    assetId,
    symbol: 'BTCUSDT',
    providerSymbol: 'BTCUSDT',
    price,
    currencyCode: CurrencyCode.USD,
    providerEventAt: (await databaseNow()).toISOString(),
    receivedAt: (await databaseNow()).toISOString(),
    sourceName: 'binance_spot_ws_trade',
    marketSessionCode: null,
    eventType: 'trade',
  });
  return eventId;
}

async function waitForOrderStatus(
  orderId: string,
  status: OrderStatus,
): Promise<void> {
  await waitFor(async () => {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    return order?.status === status;
  }, `order ${orderId} status ${status}`);
}

async function waitForProcessedEvent(eventId: string): Promise<void> {
  await waitFor(async () => {
    const row = await prisma.limitOrderProcessedEvent.findUnique({
      where: { eventId },
      select: { eventId: true },
    });
    return Boolean(row);
  }, `processed event ${eventId}`);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function databaseNow(): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
  `;
  assert.ok(rows[0]?.now);
  return rows[0].now;
}

async function cleanupDatabase(): Promise<void> {
  await prisma.operatorAuditLog.deleteMany({
    where: { actorUserId: operator?.userId },
  });
  await prisma.limitOrderProcessedEvent.deleteMany({
    where: { eventId: { in: eventIds } },
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
  await prisma.position.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.assetPriceSnapshot.deleteMany({ where: { assetId } });
  await prisma.fxRateSnapshot.deleteMany({ where: { id: fxRateSnapshotId } });
  await prisma.seasonParticipant.deleteMany({
    where: { id: { in: createdParticipantIds } },
  });
  await prisma.asset.deleteMany({ where: { id: assetId } });
  await prisma.opsJobRun.deleteMany({
    where: { id: { in: createdOpsRunIds } },
  });
  await prisma.season.deleteMany({ where: { id: seasonId } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
