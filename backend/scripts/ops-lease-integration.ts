import 'dotenv/config';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AssetType,
  CurrencyCode,
  OpsJobName,
  OpsJobRunStatus,
  OrderSide,
  Prisma,
} from '../src/generated/prisma/client';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { OpsJobRunnerService } from '../src/ops/ops-job-runner.service';
import { LimitOrderMatchingService } from '../src/orders/limit-order-matching.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOCK_KEY = 'limit_order_matching:current';
const prismaA = new PrismaService();
const prismaB = new PrismaService();
const lockA = new OpsJobLockService(prismaA);
const lockB = new OpsJobLockService(prismaB);
const runA = new OpsJobRunService(prismaA);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function runner(
  lock: Pick<OpsJobLockService, 'acquireLock' | 'extendLock' | 'releaseLock'>,
  matcher: {
    matchDueLimitOrders: (
      input: Parameters<LimitOrderMatchingService['matchDueLimitOrders']>[0],
    ) => Promise<unknown>;
  },
) {
  // Only the three real collaborators used by runLimitOrderMatchingJob are
  // supplied. The runner's other jobs are intentionally not invoked here.
  const args = Array.from({ length: 18 }, () => ({})) as unknown[];
  args[12] = prismaA;
  args[13] = lock;
  args[14] = runA;
  args[17] = matcher;
  return new OpsJobRunnerService(
    ...(args as ConstructorParameters<typeof OpsJobRunnerService>),
  );
}

async function clean() {
  await prismaA.opsJobRun.deleteMany({ where: { lockKey: LOCK_KEY } });
  await prismaA.opsJobLock.deleteMany({ where: { lockKey: LOCK_KEY } });
}

async function assertFailedRun(runId: string) {
  const run = await prismaA.opsJobRun.findUniqueOrThrow({
    where: { id: runId },
  });
  assert.equal(run.status, OpsJobRunStatus.failed);
  assert.equal(run.errorCode, 'OPS_JOB_LOCK_LOST');
}

function matcherWithPausedFirstFill(
  started: ReturnType<typeof deferred>,
  finish: ReturnType<typeof deferred>,
  filled: string[],
) {
  const asset = {
    id: 'lease-test-asset',
    assetType: AssetType.crypto,
    market: 'BINANCE',
    symbol: 'LEASE',
    currencyCode: CurrencyCode.USD,
    priceCurrency: CurrencyCode.USD,
    settlementCurrency: CurrencyCode.USD,
    isActive: true,
  };
  const rows = ['first', 'second'].map((id, index) => {
    const submittedAt = new Date(Date.now() - 60_000 + index);
    return {
      cursor: { submittedAt, id },
      assetId: asset.id,
      candidate: {
        id,
        side: OrderSide.buy,
        tradingAccountId: 'lease-test-account',
        assetId: asset.id,
        quantity: new Prisma.Decimal(1),
        limitPrice: new Prisma.Decimal(100),
        currencyCode: CurrencyCode.USD,
        reservedAmount: new Prisma.Decimal(100),
        reservedQuantity: null,
        reservationFeeRate: new Prisma.Decimal(0),
        submittedAt,
        seasonId: null,
        seasonEndAt: null,
        asset,
      },
    };
  });
  const candidates = {
    findFillableLimitOrdersAfter: (
      _now: Date,
      _limit: number,
      cursor: { submittedAt: Date; id: string } | null,
    ) => Promise.resolve(cursor ? [] : rows),
  };
  const candles = {
    findEligibleClosedCandlesForAsset: () => Promise.resolve([]),
    selectTriggerCandleForOrder: () => null,
  };
  const execution = {
    fillLimitOrder: async ({ orderId }: { orderId: string }) => {
      filled.push(orderId);
      if (orderId === 'first') {
        started.resolve();
        await finish.promise;
      }
      return {
        state: 'filled',
        path: 'snapshot',
        seasonId: null,
        seasonParticipantId: null,
      };
    },
  };
  const matcher = new LimitOrderMatchingService(
    prismaA,
    candidates as never,
    candles as never,
    execution as never,
  );
  // The lease test owns evidence selection; the real matcher controls
  // traversal and checks ownership before each execution attempt.
  (
    matcher as never as { resolvePathASnapshot: () => Promise<unknown> }
  ).resolvePathASnapshot = () =>
    Promise.resolve({
      id: 'lease-test-snapshot',
      price: new Prisma.Decimal(100),
    });
  return matcher;
}

async function normalRenewal() {
  await clean();
  const started = deferred();
  const finish = deferred();
  const service = runner(lockA, {
    matchDueLimitOrders: async ({ isLockOwned }) => {
      assert.equal(isLockOwned?.(), true);
      started.resolve();
      await finish.promise;
      return { scanned: 1 };
    },
  });
  const pending = service.runLimitOrderMatchingJob({ lockTtlSeconds: 1 });
  await started.promise;
  await delay(2200);
  const blocked = await lockB.acquireLock({
    jobName: OpsJobName.limit_order_matching,
    lockKey: LOCK_KEY,
    ttlSeconds: 1,
    ownerId: 'successor',
  });
  assert.equal(blocked.acquired, false);
  finish.resolve();
  const response = await pending;
  assert.equal(response.success, true);
  if (!response.success) throw new Error('normal renewal unexpectedly failed');
  const run = await prismaA.opsJobRun.findUniqueOrThrow({
    where: { id: response.data.run.id },
  });
  assert.equal(run.status, OpsJobRunStatus.succeeded);
  const afterRelease = await lockB.acquireLock({
    jobName: OpsJobName.limit_order_matching,
    lockKey: LOCK_KEY,
    ttlSeconds: 1,
    ownerId: 'successor',
  });
  assert.equal(afterRelease.acquired, true);
  console.log('normal lease renewal blocks takeover');
}

async function takeoverAfterExpiredLease() {
  await clean();
  const extensionEntered = deferred();
  const allowExtension = deferred();
  const started = deferred();
  const finish = deferred();
  const releaseResults: boolean[] = [];
  const filled: string[] = [];
  const pausedLock = {
    acquireLock: (input: Parameters<OpsJobLockService['acquireLock']>[0]) =>
      lockA.acquireLock(input),
    extendLock: async (
      input: Parameters<OpsJobLockService['extendLock']>[0],
    ) => {
      extensionEntered.resolve();
      await allowExtension.promise;
      return lockA.extendLock(input);
    },
    releaseLock: async (
      input: Parameters<OpsJobLockService['releaseLock']>[0],
    ) => {
      const released = await lockA.releaseLock(input);
      releaseResults.push(released);
      return released;
    },
  };
  const service = runner(
    pausedLock,
    matcherWithPausedFirstFill(started, finish, filled),
  );
  const pending = service.runLimitOrderMatchingJob({ lockTtlSeconds: 1 });
  await started.promise;
  await extensionEntered.promise;
  await delay(1100);
  const takeover = await lockB.acquireLock({
    jobName: OpsJobName.limit_order_matching,
    lockKey: LOCK_KEY,
    ttlSeconds: 3,
    ownerId: 'successor',
  });
  assert.equal(takeover.acquired, true);
  allowExtension.resolve();
  finish.resolve();
  const response = await pending;
  assert.equal(response.success, false);
  if (response.success) throw new Error('expired owner reported success');
  assert.equal(response.error.code, 'OPS_JOB_LOCK_LOST');
  await assertFailedRun(response.data.run.id);
  assert.deepEqual(filled, ['first'], 'expired owner started another fill');
  assert.deepEqual(releaseResults, [false]);
  const lock = await prismaB.opsJobLock.findUniqueOrThrow({
    where: { lockKey: LOCK_KEY },
  });
  assert.equal(lock.ownerId, 'successor');
  assert.equal(lock.releasedAt, null);
  console.log('expired lease takeover stops old units and protects successor');
}

async function renewalError() {
  await clean();
  const extensionEntered = deferred();
  const started = deferred();
  const finish = deferred();
  let extensionCalls = 0;
  let units = 0;
  const guard: { current?: () => boolean } = {};
  const failingLock = {
    acquireLock: (input: Parameters<OpsJobLockService['acquireLock']>[0]) =>
      lockA.acquireLock(input),
    extendLock: () => {
      extensionCalls += 1;
      extensionEntered.resolve();
      return Promise.reject(new Error('synthetic DB renewal error'));
    },
    releaseLock: (input: Parameters<OpsJobLockService['releaseLock']>[0]) =>
      lockA.releaseLock(input),
  };
  const service = runner(failingLock, {
    matchDueLimitOrders: async ({ isLockOwned }) => {
      guard.current = isLockOwned;
      units += 1;
      started.resolve();
      await finish.promise;
      if (isLockOwned?.()) units += 1;
      return { scanned: units };
    },
  });
  const pending = service.runLimitOrderMatchingJob({ lockTtlSeconds: 1 });
  await started.promise;
  await extensionEntered.promise;
  for (let tries = 0; tries < 100 && guard.current?.(); tries++) {
    await delay(1);
  }
  assert.equal(guard.current?.(), false, 'renewal failure was not observed');
  finish.resolve();
  const response = await pending;
  assert.equal(response.success, false);
  if (response.success) throw new Error('renewal error reported success');
  await assertFailedRun(response.data.run.id);
  assert.equal(units, 1);
  await delay(450);
  assert.equal(extensionCalls, 1, 'renewal timer remained active');
  console.log('renewal DB error stops next unit and closes timer');
}

async function main() {
  await Promise.all([prismaA.$connect(), prismaB.$connect()]);
  try {
    await normalRenewal();
    await takeoverAfterExpiredLease();
    await renewalError();
  } finally {
    await clean();
    await Promise.all([prismaA.$disconnect(), prismaB.$disconnect()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
