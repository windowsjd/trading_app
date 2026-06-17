import { spawnSync } from 'node:child_process';

const RUN_OPS_JOB_LOCK_DB_SMOKE = process.env.OPS_JOB_LOCK_DB_SMOKE === '1';

describe('OpsJobLockService DB smoke', () => {
  it(
    RUN_OPS_JOB_LOCK_DB_SMOKE
      ? 'verifies concurrent acquire, active blocking, expired takeover, release, and reacquire against PostgreSQL'
      : 'is disabled unless OPS_JOB_LOCK_DB_SMOKE=1 because it needs an explicit test PostgreSQL database',
    () => {
      if (!RUN_OPS_JOB_LOCK_DB_SMOKE) {
        expect(process.env.OPS_JOB_LOCK_DB_SMOKE).not.toBe('1');
        return;
      }

      const result = spawnSync(
        'pnpm',
        ['tsx', '-e', OPS_JOB_LOCK_DB_SMOKE_RUNNER],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Ops job lock DB smoke runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('ops job lock db smoke ok');
    },
    70_000,
  );
});

const OPS_JOB_LOCK_DB_SMOKE_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { OpsJobName } from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { OpsJobLockService } from './src/ops/ops-job-lock.service';

const TEST_PREFIX = 'ops-job-lock-db-smoke-' + Date.now() + '-' + Math.random().toString(36).slice(2);
const prisma = new PrismaService();
const service = new OpsJobLockService(prisma);

async function main() {
  await prisma.$connect();

  try {
    await cleanup();
    await runConcurrentAcquire();
    await runActiveBlockExpiredTakeoverAndRelease();
    console.log('ops job lock db smoke ok');
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

async function runConcurrentAcquire() {
  const lockKey = TEST_PREFIX + ':concurrent';
  const now = new Date('2026-06-09T00:00:00.000Z');
  const attempts = Array.from({ length: 5 }, (_, index) =>
    service.acquireLock({
      jobName: OpsJobName.daily_portfolio_snapshot,
      lockKey,
      ttlSeconds: 600,
      now,
      ownerId: 'concurrent-owner-' + index,
    }),
  );

  const results = await Promise.all(attempts);
  const acquired = results.filter((result) => result.acquired);
  const rejected = results.filter((result) => !result.acquired);

  assert.equal(acquired.length, 1);
  assert.equal(rejected.length, 4);
  assert.equal(rejected.every((result) => result.lockKey === lockKey), true);
}

async function runActiveBlockExpiredTakeoverAndRelease() {
  const lockKey = TEST_PREFIX + ':takeover-release';
  const firstNow = new Date('2026-06-09T00:00:00.000Z');
  const activeSecondNow = new Date('2026-06-09T00:00:00.500Z');
  const expiredNow = new Date('2026-06-09T00:00:02.000Z');

  const first = await service.acquireLock({
    jobName: OpsJobName.provider_fx_ingest,
    lockKey,
    ttlSeconds: 1,
    now: firstNow,
    ownerId: 'owner-1',
  });
  assert.equal(first.acquired, true);

  const activeSecond = await service.acquireLock({
    jobName: OpsJobName.provider_fx_ingest,
    lockKey,
    ttlSeconds: 1,
    now: activeSecondNow,
    ownerId: 'owner-2',
  });
  assert.equal(activeSecond.acquired, false);
  assert.equal(activeSecond.activeOwnerId, 'owner-1');

  const takeover = await service.acquireLock({
    jobName: OpsJobName.provider_fx_ingest,
    lockKey,
    ttlSeconds: 1,
    now: expiredNow,
    ownerId: 'owner-2',
  });
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.ownerId, 'owner-2');

  const released = await service.releaseLock({
    lockKey,
    ownerId: 'owner-2',
    releasedAt: new Date('2026-06-09T00:00:02.500Z'),
  });
  assert.equal(released, true);

  const reacquired = await service.acquireLock({
    jobName: OpsJobName.provider_fx_ingest,
    lockKey,
    ttlSeconds: 1,
    now: new Date('2026-06-09T00:00:03.000Z'),
    ownerId: 'owner-3',
  });
  assert.equal(reacquired.acquired, true);
  assert.equal(reacquired.ownerId, 'owner-3');
}

async function cleanup() {
  await prisma.opsJobLock.deleteMany({
    where: {
      lockKey: {
        startsWith: TEST_PREFIX,
      },
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
