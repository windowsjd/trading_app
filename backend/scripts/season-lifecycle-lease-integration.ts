import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BatchService } from '../src/batch/batch.service';
import { SeasonLifecycleTransitionJobService } from '../src/batch/season-lifecycle-transition-job.service';
import { Prisma } from '../src/generated/prisma/client';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { OpsJobRunnerService } from '../src/ops/ops-job-runner.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { PrismaService } from '../src/prisma/prisma.service';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real lifecycle + cleanup + Ops audit, with a barrier inside the first DB tx. */
export async function runSeasonLifecycleLeaseIntegration(
  prisma: PrismaService,
  successorPrisma: PrismaService,
) {
  const prefix = `lifecycle-lease-${randomUUID()}`;
  const lockKey = 'season_lifecycle_transition:current';
  const userId = randomUUID();
  const seasonId = randomUUID();
  const accountId = randomUUID();
  const assetId = randomUUID();
  const now = new Date();
  const entered = deferred();
  const finish = deferred();
  let selections = 0;
  let transactions = 0;
  let isOwned: (() => boolean) | undefined;
  let pending:
    | ReturnType<OpsJobRunnerService['runSeasonLifecycleTransitionJob']>
    | undefined;
  const lock = new OpsJobLockService(prisma);
  const successorLock = new OpsJobLockService(successorPrisma);
  const runService = new OpsJobRunService(prisma);

  const cleanupPrisma = {
    order: {
      findMany: (args: Prisma.OrderFindManyArgs) => {
        selections += 1;
        return prisma.order.findMany(args);
      },
    },
    $transaction: (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) =>
      prisma.$transaction(
        async (tx) => {
          transactions += 1;
          const result = await callback(tx);
          if (transactions === 1) {
            entered.resolve();
            await finish.promise;
          }
          return result;
        },
        { timeout: 15_000 },
      ),
  } as unknown as PrismaService;
  const lifecycle = new SeasonLifecycleTransitionJobService(
    new BatchService(prisma),
    prisma,
    new LimitOrderCancelService(cleanupPrisma, new OrderReservationService()),
  );
  const realRun = lifecycle.run.bind(lifecycle);
  lifecycle.run = (input) => {
    isOwned = input.isLockOwned;
    return realRun(input);
  };
  function runner(
    lockService: Pick<
      OpsJobLockService,
      'acquireLock' | 'extendLock' | 'releaseLock'
    >,
  ) {
    // Only collaborators reached by this job; the production runner is unchanged.
    const args: unknown[] = Array.from({ length: 18 }, () => ({}));
    args[1] = lifecycle;
    args[12] = prisma;
    args[13] = lockService;
    args[14] = runService;
    return new OpsJobRunnerService(
      ...(args as ConstructorParameters<typeof OpsJobRunnerService>),
    );
  }
  async function seedOrders() {
    await prisma.order.createMany({
      data: Array.from({ length: 102 }, (_, index) => ({
        tradingAccountId: accountId,
        assetId,
        side: index % 2 === 0 ? ('buy' as const) : ('sell' as const),
        orderType: 'limit' as const,
        quantity: '1',
        limitPrice: '10',
        currencyCode: 'KRW' as const,
        reservedAmount: index % 2 === 0 ? '10' : null,
        reservedQuantity: index % 2 === 1 ? '1' : null,
        reservationFeeRate: '0',
        submittedAt: new Date(now.getTime() - 60_000 + index),
      })),
    });
    await prisma.cashWallet.updateMany({
      where: { tradingAccountId: accountId },
      data: { reservedAmount: '510' },
    });
    await prisma.position.updateMany({
      where: { tradingAccountId: accountId },
      data: { reservedQuantity: '51' },
    });
  }
  async function reservations(cash: string, quantity: string) {
    const wallet = await successorPrisma.cashWallet.findFirstOrThrow({
      where: { tradingAccountId: accountId },
    });
    const position = await successorPrisma.position.findFirstOrThrow({
      where: { tradingAccountId: accountId },
    });
    assert.equal(wallet.balanceAmount.toString(), '1000');
    assert.equal(wallet.reservedAmount.toString(), cash);
    assert.equal(position.quantity.toString(), '100');
    assert.equal(position.reservedQuantity.toString(), quantity);
  }
  try {
    await prisma.user.create({
      data: {
        id: userId,
        email: `${prefix}@example.com`,
        nickname: 'lease fixture',
        passwordHash: 'fixture-only',
      },
    });
    await prisma.season.create({
      data: {
        id: seasonId,
        name: prefix,
        status: 'active',
        startAt: new Date(now.getTime() - 120_000),
        endAt: new Date(now.getTime() - 1000),
        initialCapitalKrw: '1000',
        tradeFeeRate: '0',
        fxFeeRate: '0',
      },
    });
    await prisma.tradingAccount.create({
      data: {
        id: accountId,
        userId,
        mode: 'season',
        initialCapitalKrw: '1000',
        openedAt: now,
      },
    });
    await prisma.seasonParticipant.create({
      data: {
        seasonId,
        userId,
        tradingAccountId: accountId,
        joinedAt: now,
        participantStatus: 'active',
        initialCapitalKrw: '1000',
        totalAssetKrw: '1000',
        totalReturnRate: '0',
        maxDrawdown: '0',
      },
    });
    await prisma.asset.create({
      data: {
        id: assetId,
        symbol: 'LEASE',
        name: prefix,
        market: prefix,
        assetType: 'crypto',
        currencyCode: 'KRW',
      },
    });
    await prisma.cashWallet.create({
      data: {
        tradingAccountId: accountId,
        currencyCode: 'KRW',
        balanceAmount: '1000',
      },
    });
    await prisma.position.create({
      data: {
        tradingAccountId: accountId,
        assetId,
        currencyCode: 'KRW',
        quantity: '100',
        averageCost: '10',
      },
    });
    await seedOrders();
    const failingLock = {
      acquireLock: lock.acquireLock.bind(lock),
      extendLock: async () => {
        throw new Error('synthetic lifecycle renewal DB error');
      },
      releaseLock: lock.releaseLock.bind(lock),
    };
    pending = runner(failingLock).runSeasonLifecycleTransitionJob({
      now: now.toISOString(),
      idempotencyKey: `${prefix}:lost`,
      lockTtlSeconds: 3,
    });
    // If setup/transition fails, do not hang waiting for a transaction barrier.
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error('run ended before cleanup barrier');
      }),
    ]);
    const deadline = Date.now() + 5000;
    while (isOwned?.() && Date.now() < deadline) await delay(1);
    assert.equal(isOwned?.(), false);
    // The in-flight transaction is still invisible to the other DB client.
    await reservations('510', '51');
    finish.resolve();
    const lost = await pending;
    assert.equal(lost.success, false);
    if (lost.success) throw new Error('old lifecycle worker reported success');
    assert.equal(lost.error.code, 'OPS_JOB_LOCK_LOST');
    const run = await prisma.opsJobRun.findUniqueOrThrow({
      where: { id: lost.data.run.id },
    });
    assert.equal(run.status, 'failed');
    assert.equal(run.errorCode, 'OPS_JOB_LOCK_LOST');
    assert.equal(selections, 1, 'old worker queried batch 2');
    assert.equal(transactions, 1, 'old worker started batch 2');
    const orders = await prisma.order.findMany({
      where: { tradingAccountId: accountId },
      orderBy: { submittedAt: 'asc' },
    });
    for (const order of orders.slice(0, 100)) {
      assert.equal(order.status, 'canceled');
      assert.equal(order.cancelReason, 'season_ended');
      assert.equal(
        order.reservationReleasedAt?.toISOString(),
        now.toISOString(),
      );
    }
    for (const order of orders.slice(100)) {
      assert.equal(order.status, 'submitted');
      assert.equal(order.reservationReleasedAt, null);
      assert.equal(order.cancelReason, null);
      assert.equal(
        order.side === 'buy'
          ? order.reservedAmount?.toString()
          : order.reservedQuantity?.toString(),
        order.side === 'buy' ? '10' : '1',
      );
    }
    await reservations('10', '1');
    const committed = orders.slice(0, 100);
    const successor = await runner(
      successorLock,
    ).runSeasonLifecycleTransitionJob({
      now: now.toISOString(),
      idempotencyKey: `${prefix}:successor`,
      lockTtlSeconds: 3,
    });
    assert.equal(successor.success, true);
    assert.equal(transactions, 2);
    await reservations('0', '0');
    assert.deepEqual(
      await prisma.order.findMany({
        where: { id: { in: committed.map((o) => o.id) } },
        orderBy: { submittedAt: 'asc' },
      }),
      committed,
    );
    assert.equal(
      await prisma.order.count({
        where: { tradingAccountId: accountId, status: 'canceled' },
      }),
      102,
    );

    // Healthy lease drains multiple batches, including a self-healing tick with no transition.
    await prisma.order.deleteMany({ where: { tradingAccountId: accountId } });
    await seedOrders();
    const normal = await runner(successorLock).runSeasonLifecycleTransitionJob({
      now: now.toISOString(),
      idempotencyKey: `${prefix}:normal`,
      lockTtlSeconds: 3,
    });
    assert.equal(normal.success, true);
    assert.equal(transactions, 4);
    assert.equal(selections, 4);
    await reservations('0', '0');
    assert.equal(
      await prisma.order.count({
        where: { tradingAccountId: accountId, status: 'submitted' },
      }),
      0,
    );
    console.log(
      'lifecycle lease loss preserves batch 1, stops batch 2, records failed Ops run; successor and healthy lease drain all reservations',
    );
  } finally {
    finish.resolve();
    if (pending) await pending;
    await prisma.order.deleteMany({ where: { tradingAccountId: accountId } });
    await prisma.position.deleteMany({
      where: { tradingAccountId: accountId },
    });
    await prisma.cashWallet.deleteMany({
      where: { tradingAccountId: accountId },
    });
    await prisma.seasonParticipant.deleteMany({ where: { seasonId } });
    await prisma.tradingAccount.deleteMany({ where: { id: accountId } });
    await prisma.season.deleteMany({ where: { id: seasonId } });
    await prisma.asset.deleteMany({ where: { id: assetId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.batchJobRun.deleteMany({
      where: { idempotencyKey: { startsWith: prefix } },
    });
    await prisma.opsJobRun.deleteMany({
      where: { idempotencyKey: { startsWith: prefix } },
    });
    await prisma.opsJobLock.deleteMany({ where: { lockKey } });
  }
}
