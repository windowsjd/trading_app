/**
 * Event-boundary CONCURRENCY runner (real PostgreSQL).
 *
 * The bug this exists to prevent: `LimitOrderMatchBoundaryService` used to
 * share ONE `pg.Client` behind a `held` boolean. The path-A poller and the
 * path-B candle worker live in the same Nest provider instance, so both could
 * pass the `held === false` check, both would take `pg_advisory_lock` on the
 * SAME session — and PostgreSQL session advisory locks are RE-ENTRANT, so both
 * succeed. Two workers then believed they owned the boundary at once, and the
 * lock counter (2) was only ever decremented once, leaking the advisory lock
 * for the life of the connection and permanently blocking every later Create,
 * poll and sweep.
 *
 * Every ordering below is decided by a real PostgreSQL lock and observed
 * through pg_locks / pg_stat_activity. Nothing here sleeps to pick a winner.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  LIMIT_ORDER_MATCH_BOUNDARY_KEY,
  LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE,
  LimitOrderMatchBoundaryService,
  type LimitOrderBoundaryLease,
} from '../src/orders/limit-matching/limit-order-match-boundary.service';

const prisma = new PrismaService();
const boundary = new LimitOrderMatchBoundaryService();

async function main(): Promise<void> {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be configured.');
  await prisma.$connect();
  try {
    await run(
      'concurrent acquire on one service instance serializes on the database',
      testConcurrentAcquireSerializes,
    );
    await run(
      'poller and candle worker on one instance never share a session',
      testPollerAndCandleWorkerShareNothing,
    );
    await run(
      'a create transaction acquires immediately after both leases release',
      testCreateAfterWorkerLeases,
    );
    await run(
      'a killed worker session releases the boundary for the next worker',
      testKilledSessionReleasesBoundary,
    );
    await run(
      'releasing a lease twice never unlocks a lock it no longer owns',
      testIdempotentRelease,
    );
    await run(
      'the boundary leaves no residual advisory lock',
      testNoResidualLock,
    );
    await run(
      'lockInTransaction works through the real Prisma driver adapter',
      testLockInTransactionAgainstPrisma,
    );
    console.log('limit order boundary concurrency integration ok');
  } finally {
    await boundary.onModuleDestroy();
    await prisma.$disconnect();
  }
}

async function run(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  // Every test must leave the boundary completely clean; a leaked lock would
  // otherwise silently pass the responsibility to the next test.
  assert.equal(
    await advisoryHolderCount(),
    0,
    `${name} left a granted advisory lock behind`,
  );
  assert.equal(
    await advisoryWaiterCount(),
    0,
    `${name} left a waiting advisory lock behind`,
  );
  console.log(`ok ${name}`);
}

/**
 * THE regression test. Two concurrent `acquireSession()` calls on ONE service
 * instance: exactly ONE lease may be granted, the other must be WAITING IN
 * POSTGRESQL (proven from pg_locks), and it may only be granted once the
 * winner releases.
 *
 * With the old shared-client implementation this fails: both calls would take
 * the lock re-entrantly on the SAME session, so both would be granted and no
 * waiter would ever appear in pg_locks — the waiter assertion below times out
 * and the test fails.
 *
 * NOTE: which of the two calls wins is deliberately NOT asserted. `pg.Pool`
 * gives no ordering guarantee between two concurrent checkouts, and the lock
 * goes to whichever session issues `pg_advisory_lock` first — not to whichever
 * call was made first in JavaScript. Mutual exclusion is the contract; FIFO
 * fairness is not, and nothing in the matcher needs it. (Asserting the JS
 * order here deadlocks the test itself roughly one run in five, which is how
 * this note came to be written.)
 */
async function testConcurrentAcquireSerializes(): Promise<void> {
  const settled = new Set<string>();
  const track = (label: string) => (lease: LimitOrderBoundaryLease) => {
    settled.add(label);
    return { label, lease };
  };

  const a = boundary.acquireSession().then(track('a'));
  const b = boundary.acquireSession().then(track('b'));

  // Exactly one holder, exactly one waiter — the definition of mutual
  // exclusion across two distinct PostgreSQL sessions. A shared session would
  // produce one holder and ZERO waiters.
  await waitFor(
    async () => (await advisoryHolderCount()) === 1,
    'exactly one concurrent acquire holds the boundary',
  );
  await waitFor(
    async () => (await advisoryWaiterCount()) === 1,
    'the other concurrent acquire waits in pg_locks',
  );

  const winner = await Promise.race([a, b]);
  assert.equal(
    settled.size,
    1,
    'exactly one of the two concurrent acquires may be granted',
  );
  assert.equal(await advisoryHolderCount(), 1);

  // The two leases must own DIFFERENT backends. Same-session re-entrancy is
  // exactly the defect being guarded against, so it is asserted directly.
  const winnerPid = await backendPidHoldingBoundary();
  assert.ok(winnerPid !== null, 'a backend must hold the boundary');

  await winner.lease.release();

  const loser = await (winner.label === 'a' ? b : a);
  assert.equal(settled.size, 2, 'the queued acquire must be granted on release');
  const loserPid = await backendPidHoldingBoundary();
  assert.ok(loserPid !== null, 'the queued lease must hold the boundary');
  assert.notEqual(
    loserPid,
    winnerPid,
    'two concurrent leases must never share one PostgreSQL session',
  );
  assert.equal(await advisoryHolderCount(), 1);

  await loser.lease.release();
  await waitFor(
    async () => (await advisoryHolderCount()) === 0,
    'the boundary is fully released after both leases',
  );
}

/**
 * The real service combination: the path-A poller and the path-B candle worker
 * both call `acquireSession()` on the SAME injected provider instance. Only
 * one may run its critical section at a time, and the critical sections must
 * not interleave.
 */
async function testPollerAndCandleWorkerShareNothing(): Promise<void> {
  const order: string[] = [];
  let pollerInside = false;
  let workerInside = false;

  const criticalSection = async (label: string): Promise<void> => {
    const lease = await boundary.acquireSession();
    order.push(`${label}:enter`);
    // Overlap is what the mutex must make impossible.
    assert.equal(
      pollerInside || workerInside,
      false,
      `${label} entered the boundary while another holder was inside`,
    );
    if (label === 'poller') pollerInside = true;
    else workerInside = true;
    assert.equal(await advisoryHolderCount(), 1);
    if (label === 'poller') pollerInside = false;
    else workerInside = false;
    order.push(`${label}:exit`);
    await lease.release();
  };

  await Promise.all([criticalSection('poller'), criticalSection('candleB')]);

  // Enter/exit must strictly alternate; any interleaving proves a shared lock.
  assert.equal(order.length, 4);
  assert.equal(order[0].endsWith(':enter'), true);
  assert.equal(order[1], order[0].replace(':enter', ':exit'));
  assert.equal(order[2].endsWith(':enter'), true);
  assert.equal(order[3], order[2].replace(':enter', ':exit'));
}

/**
 * After both worker leases release, a Create transaction's
 * `pg_advisory_xact_lock` must be granted immediately — i.e. the session lock
 * counter really reached zero rather than being left at one by an unbalanced
 * release.
 */
async function testCreateAfterWorkerLeases(): Promise<void> {
  const first = await boundary.acquireSession();
  const secondPromise = boundary.acquireSession();
  await waitFor(
    async () => (await advisoryWaiterCount()) === 1,
    'the second worker lease queues behind the first',
  );
  await first.release();
  const second = await secondPromise;
  await second.release();

  const creator = new Client({ connectionString: process.env.DATABASE_URL });
  await creator.connect();
  try {
    await creator.query('BEGIN');
    // If a leaked lock were still held this would block forever; the runner's
    // outer timeout would fail the suite.
    const granted = await creator.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1, $2) AS locked',
      [LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE, LIMIT_ORDER_MATCH_BOUNDARY_KEY],
    );
    assert.equal(
      granted.rows[0].locked,
      true,
      'Create must acquire the boundary immediately after the workers released it',
    );
    await creator.query('COMMIT');
  } finally {
    await creator.end().catch(() => undefined);
  }
}

/**
 * Failure recovery: a worker session that is terminated (crash, failover,
 * operator kill) has its advisory lock released by PostgreSQL itself. The next
 * worker AND a Create must both proceed with no lease, no TTL and no Redis.
 */
async function testKilledSessionReleasesBoundary(): Promise<void> {
  const victim = new Client({ connectionString: process.env.DATABASE_URL });
  // pg_terminate_backend makes the client emit 'error'; without a listener
  // that is an unhandled event and kills the runner.
  victim.on('error', () => undefined);
  await victim.connect();
  const pid = (
    await victim.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  ).rows[0].pid;
  await victim.query('SELECT pg_advisory_lock($1, $2)', [
    LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE,
    LIMIT_ORDER_MATCH_BOUNDARY_KEY,
  ]);
  assert.equal(await advisoryHolderCount(), 1);

  // A worker queued behind the doomed session must be granted the lock the
  // moment the backend goes away.
  const queued = boundary.acquireSession();
  await waitFor(
    async () => (await advisoryWaiterCount()) === 1,
    'a worker queues behind the session that is about to die',
  );

  const killer = new Client({ connectionString: process.env.DATABASE_URL });
  await killer.connect();
  try {
    await killer.query('SELECT pg_terminate_backend($1)', [pid]);
    const lease = await queued;
    assert.equal(await advisoryHolderCount(), 1);
    await lease.release();

    const creator = new Client({ connectionString: process.env.DATABASE_URL });
    await creator.connect();
    try {
      await creator.query('BEGIN');
      const granted = await creator.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1, $2) AS locked',
        [LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE, LIMIT_ORDER_MATCH_BOUNDARY_KEY],
      );
      assert.equal(
        granted.rows[0].locked,
        true,
        'Create must proceed after a worker session was terminated',
      );
      await creator.query('COMMIT');
    } finally {
      await creator.end().catch(() => undefined);
    }
  } finally {
    await killer.end().catch(() => undefined);
    await victim.end().catch(() => undefined);
  }
}

/**
 * `release()` must be idempotent. A second call must NOT issue another
 * `pg_advisory_unlock`, because by then the session has been returned to the
 * pool and the next caller may already hold the lock on it — unlocking there
 * would hand the boundary to two workers at once.
 */
async function testIdempotentRelease(): Promise<void> {
  const lease: LimitOrderBoundaryLease = await boundary.acquireSession();
  await lease.release();
  await lease.release();
  await lease.release();
  assert.equal(await advisoryHolderCount(), 0);

  // The pooled session must be reusable and must grant the lock exactly once.
  const next = await boundary.acquireSession();
  assert.equal(await advisoryHolderCount(), 1);
  await next.release();
  assert.equal(await advisoryHolderCount(), 0);
}

/**
 * Steady-state check across a burst of acquisitions: no granted or waiting
 * advisory lock may survive, and the service must report no live lease.
 *
 * The acquisitions are SEQUENTIAL on purpose. The boundary is a mutex, so only
 * one lease can ever be granted at a time; a `Promise.all` of more acquires
 * than the pool's session ceiling would simply queue for a connection that
 * cannot be returned until the leases it is waiting on are released. Cycling
 * many times through the same small pool is also the stronger check: it proves
 * a RECYCLED session carries no residual lock count from its previous lease.
 */
async function testNoResidualLock(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    const lease = await boundary.acquireSession();
    assert.equal(
      await advisoryHolderCount(),
      1,
      `iteration ${index} must hold exactly one advisory lock`,
    );
    assert.equal(boundary.activeSessionCount(), 1);
    await lease.release();
    assert.equal(
      await advisoryHolderCount(),
      0,
      `iteration ${index} must leave no advisory lock behind`,
    );
  }

  assert.equal(boundary.activeSessionCount(), 0);
  assert.equal(boundary.isHeld(), false);
  await waitFor(
    async () =>
      (await advisoryHolderCount()) === 0 &&
      (await advisoryWaiterCount()) === 0,
    'no residual advisory lock remains',
  );
}

/**
 * The Create side of the boundary, exercised through the REAL Prisma client
 * rather than a mocked template-tag.
 *
 * `pg_advisory_xact_lock` returns `void`, and the Prisma 7 pg driver adapter
 * cannot decode a `void` result column: reading it with `$queryRaw` raises
 * P2010 / UnsupportedNativeDataType. Because it is the FIRST statement of the
 * create transaction, that failure would make every single limit-order create
 * fail the moment automatic matching is enabled — while every unit test that
 * mocks `$queryRaw` still passes. Only a real driver can catch this.
 */
async function testLockInTransactionAgainstPrisma(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await boundary.lockInTransaction(tx);
    // Still inside the transaction: the lock must be held right now.
    assert.equal(
      await advisoryHolderCount(),
      1,
      'the create transaction must hold the boundary',
    );
  });
  // Transaction-scoped: commit releases it, with no explicit unlock anywhere.
  await waitFor(
    async () => (await advisoryHolderCount()) === 0,
    'the transaction-scoped boundary lock is released at commit',
  );

  // And a worker lease can be taken immediately afterwards.
  const lease = await boundary.acquireSession();
  await lease.release();
}

// ---------------------------------------------------------------------------
// pg_locks / pg_stat_activity observation
// ---------------------------------------------------------------------------

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

async function advisoryWaiterCount(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM pg_locks
    WHERE "locktype" = 'advisory'
      AND "classid" = ${LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE}
      AND "objid" = ${LIMIT_ORDER_MATCH_BOUNDARY_KEY}
      AND "granted" = false
  `;
  return Number(rows[0]?.count ?? 0);
}

/** Backend PID currently holding the boundary, joined to pg_stat_activity. */
async function backendPidHoldingBoundary(): Promise<number | null> {
  const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
    SELECT a."pid"
    FROM pg_locks l
    JOIN pg_stat_activity a ON a."pid" = l."pid"
    WHERE l."locktype" = 'advisory'
      AND l."classid" = ${LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE}
      AND l."objid" = ${LIMIT_ORDER_MATCH_BOUNDARY_KEY}
      AND l."granted" = true
    LIMIT 1
  `;
  return rows[0]?.pid ?? null;
}

/**
 * Polls a CONDITION, never a duration. The ordering is already decided by
 * PostgreSQL; this only bounds how long we wait for it to become visible in
 * the catalog views.
 */
async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
