import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import {
  db,
  fixture,
  spotPrice,
  cleanup,
  type Scenario,
} from './futures-integration';
import { ConditionalBuyService } from '../src/conditional/conditional-buy.service';
import { ConditionalSellService } from '../src/conditional/conditional-sell.service';
import { ConditionalBuyWorker } from '../src/conditional/conditional-buy-worker.service';
import { ConditionalSellWorker } from '../src/conditional/conditional-sell-worker.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { OrdersService } from '../src/orders/orders.service';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';

// Deliberately narrow: never infer a disposable database from NODE_ENV alone.
const target = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.CONDITIONAL_WORKER_SCAN_DB_INTEGRATION, '1');
assert.equal(
  ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname),
  true,
);
assert.equal(target.pathname.startsWith('/safety_migration_worker_'), true);
Logger.overrideLogger(false);

const access = new TradingAccountAccessService(db);
// No order is triggered in this runner. Financial execution uses the separate
// existing BUY/SELL runners, with their real OrdersService dependencies.
const unusedOrders = {} as OrdersService;
const buy = new ConditionalBuyService(db, access, unusedOrders);
const sell = new ConditionalSellService(db, access, unusedOrders);
const locks = new OpsJobLockService(db);
const runs = new OpsJobRunService(db);
const results: unknown[] = [];

async function scan(kind: 'BUY' | 'SELL', count: number) {
  const scenarios: Scenario[] = [];
  const ids: string[] = [];
  const seen: string[] = [];
  const states: string[] = [];
  let errors = 0;
  const jobName =
    kind === 'BUY' ? 'conditional_buy_orders' : 'conditional_sell_orders';
  const lockKey = `${jobName}:current`;
  process.env.CONDITIONAL_BUY_ORDERS_ENABLED = 'true';
  process.env.CONDITIONAL_SELL_ORDERS_ENABLED = 'true';
  const realService = kind === 'BUY' ? buy : sell;
  const observer = {
    async evaluate(id: string) {
      seen.push(id);
      try {
        const result = await realService.evaluate(id);
        states.push(result.state);
        return result;
      } catch (error) {
        errors++;
        throw error;
      }
    },
  };
  const make = () =>
    kind === 'BUY'
      ? new ConditionalBuyWorker(
          db,
          locks,
          runs,
          observer as ConditionalBuyService,
        )
      : new ConditionalSellWorker(
          db,
          locks,
          runs,
          observer as ConditionalSellService,
        );
  try {
    // 20 watches/account respects both real per-account caps (BUY 20, SELL 30).
    for (let offset = 0; offset < count; offset += 20)
      scenarios.push(await fixture('general'));
    const assetId = scenarios[0].instruments[0].asset.id;
    const registration = await spotPrice(scenarios[0], '100', 0, 0);
    for (let account = 0; account < scenarios.length; account++) {
      const s = scenarios[account];
      const position =
        kind === 'SELL'
          ? await db.position.create({
              data: {
                tradingAccountId: s.accountId,
                assetId,
                quantity: '100',
                averageCost: '100',
                currencyCode: 'USD',
              },
            })
          : undefined;
      for (let i = 0; i < Math.min(20, count - account * 20); i++) {
        const id = `${kind.toLowerCase()}-scan-${String(account * 20 + i).padStart(4, '0')}`;
        ids.push(id);
        const data = {
          id,
          tradingAccountId: s.accountId,
          assetId,
          triggerCondition: 'at_or_above' as const,
          triggerPrice: '10000000',
          executionType: 'market' as const,
          currencyCode: 'USD' as const,
          registrationSnapshotId: registration.id,
          idempotencyKey: id,
          requestHash: id,
        };
        if (kind === 'BUY')
          await db.conditionalBuyOrder.create({
            data: { ...data, amount: '1' },
          });
        else
          await db.conditionalSellOrder.create({
            data: {
              ...data,
              kind: 'condition',
              positionId: position!.id,
              quantity: '1',
            },
          });
      }
    }
    const worker = make();
    const batchMs: number[] = [];
    const batchEvaluations: number[] = [];
    const started = performance.now();
    for (let batch = 0; batch < Math.ceil(count / 100); batch++) {
      await spotPrice(scenarios[0], '100', 0, 0);
      const before = seen.length,
        at = performance.now();
      await worker.tick();
      batchMs.push(performance.now() - at);
      batchEvaluations.push(seen.length - before);
      assert.equal(seen.length - before, Math.min(100, count - batch * 100));
      if (batch + 1 < Math.ceil(count / 100))
        await delay(Math.max(0, 1000 - (performance.now() - at)));
    }
    const traversalMs = performance.now() - started;
    const unique = new Set(seen),
      missing = ids.filter((id) => !unique.has(id)).length;
    assert.equal(unique.size, count);
    assert.equal(missing, 0);
    assert.equal(seen.length - unique.size, 0);
    assert.equal(states.filter((state) => state !== 'watching').length, 0);
    assert.equal(errors, 0);
    results.push({
      worker: kind,
      count,
      evaluated: unique.size,
      traversalMs: +traversalMs.toFixed(2),
      batchMs: batchMs.map((ms) => +ms.toFixed(2)),
      batchEvaluations,
      errors,
      missing,
      duplicateEvaluations: seen.length - unique.size,
      financialExecutions: 0,
    });

    await spotPrice(scenarios[0], '100', 0, 0);
    let before = seen.length;
    await worker.tick();
    assert.equal(seen[before], ids[0]); // wrap
    before = seen.length;
    await make().tick();
    assert.equal(seen[before], ids[0]); // restart

    // Real PostgreSQL lease contention and ownership loss, with no sleeps/TTL races.
    const held = await locks.acquireLock({ jobName, lockKey, ttlSeconds: 30 });
    assert.equal(held.acquired, true);
    if (!held.acquired) throw new Error('test lease unavailable');
    before = seen.length;
    const contender = make();
    await contender.tick();
    assert.equal(seen.length, before);
    await locks.releaseLock({ lockKey, ownerId: held.ownerId });
    await contender.tick();
    assert.equal(seen[before], ids[0]);
    const lost = await locks.acquireLock({ jobName, lockKey, ttlSeconds: 30 });
    assert.equal(lost.acquired, true);
    if (!lost.acquired) throw new Error('test lease unavailable');
    await db.opsJobLock.update({
      where: { lockKey },
      data: { ownerId: 'replacement-test-owner' },
    });
    assert.equal(
      await locks.extendLock({
        lockKey,
        ownerId: lost.ownerId,
        ttlSeconds: 30,
      }),
      false,
    );
    assert.equal(
      await locks.releaseLock({ lockKey, ownerId: lost.ownerId }),
      false,
    );
    await locks.releaseLock({ lockKey, ownerId: 'replacement-test-owner' });

    // Disabled monitoring still performs lifecycle cleanup, through actual services.
    process.env.CONDITIONAL_BUY_ORDERS_ENABLED = 'false';
    process.env.CONDITIONAL_SELL_ORDERS_ENABLED = 'false';
    await db.tradingAccount.update({
      where: { id: scenarios[0].accountId },
      data: { status: 'suspended' },
    });
    states.length = 0;
    const disabled = make();
    for (let batch = 0; batch < Math.ceil(count / 100); batch++)
      await disabled.tick();
    assert.equal(
      states.filter((state) => state === 'lifecycle_canceled').length,
      20,
    );
    assert.equal(
      states.filter((state) => state === 'disabled').length,
      count - 20,
    );
    before = seen.length;
    const afterCleanup = make();
    for (let batch = 0; batch < Math.ceil((count - 20) / 100); batch++)
      await afterCleanup.tick();
    assert.equal(
      seen.slice(before).some((id) => ids.slice(0, 20).includes(id)),
      false,
    );
    assert.equal(errors, 0);
    console.log(
      `PASS ${kind} ${count}: wrap/restart/contention/ownership/disabled cleanup/terminal exclusion`,
    );
  } finally {
    // Delete all cross-account references before releasing shared fixture assets.
    const where = {
      tradingAccountId: { in: scenarios.map((s) => s.accountId) },
    };
    await db.conditionalBuyOrder.deleteMany({ where });
    await db.conditionalSellOrder.deleteMany({ where });
    await db.position.deleteMany({ where });
    for (const s of scenarios) await cleanup(s);
    await db.opsJobRun.deleteMany({ where: { jobName } });
    await db.opsJobLock.deleteMany({ where: { lockKey } });
  }
}

async function main() {
  await db.$connect();
  const [{ timezone }] = await db.$queryRaw<
    Array<{ timezone: string }>
  >`SELECT current_setting('TimeZone') AS timezone`;
  assert.equal(timezone, 'UTC');
  assert.equal(
    (
      await db.$queryRaw<
        Array<{ version: string }>
      >`SELECT current_setting('server_version') AS version`
    )[0].version.startsWith('16.'),
    true,
  );
  assert.equal(await db.conditionalBuyOrder.count(), 0);
  assert.equal(await db.conditionalSellOrder.count(), 0);
  for (const kind of ['BUY', 'SELL'] as const)
    for (const count of [100, 101, 500]) await scan(kind, count);
  assert.equal(await db.user.count(), 0);
  console.log(`WORKER_SCAN_METRICS ${JSON.stringify(results)}`);
}
main()
  .catch(() => {
    console.error('CONDITIONAL_WORKER_SCAN_FAILED');
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
