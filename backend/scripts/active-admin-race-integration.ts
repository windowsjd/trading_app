/** TC-A01. Disposable PostgreSQL only; independent Prisma pools, controlled
 * count barrier and observed pg_stat_activity lock wait (not Promise.all alone).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { HttpException } from '@nestjs/common';
import type { Prisma } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { OperatorAuditService } from '../src/operator/operator-audit.service';
import { OperatorAccountManagementService } from '../src/operator/operator-account-management.service';
import { OperatorUserStatusService } from '../src/operator/operator-user-status.service';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.ACTIVE_ADMIN_DB_INTEGRATION !== '1' ||
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  !(
    url.pathname.endsWith('_test') ||
    (process.env.GITHUB_ACTIONS === 'true' && url.pathname === '/trading_app')
  )
) {
  throw new Error('Requires test opt-in and disposable local *_test database.');
}
const db = new PrismaService();
const first = new PrismaService();
const second = new PrismaService();
type Mode = 'role' | 'suspended' | 'deleted';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
function intercept(
  root: PrismaService,
  model: string,
  operation: string,
  after: () => Promise<void>,
) {
  let fired = false;
  return new Proxy(root, {
    get(target, key) {
      if (key !== '$transaction') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (
        work: (tx: unknown) => Promise<unknown>,
        options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
      ) =>
        target.$transaction(
          (tx) =>
            work(
              new Proxy(tx, {
                get(t, k) {
                  const value = Reflect.get(t, k, t);
                  if (k !== model)
                    return typeof value === 'function' ? value.bind(t) : value;
                  return new Proxy(value as object, {
                    get(delegate, op) {
                      const fn = Reflect.get(delegate, op, delegate);
                      if (op !== operation)
                        return typeof fn === 'function'
                          ? fn.bind(delegate)
                          : fn;
                      return async (...args: unknown[]) => {
                        const result: unknown = await fn.apply(delegate, args);
                        if (!fired) {
                          fired = true;
                          await after();
                        }
                        return result;
                      };
                    },
                  });
                },
              }),
            ),
          { ...options, timeout: 15000 },
        );
    },
  });
}
function command(
  client: PrismaService,
  actorId: string,
  targetId: string,
  mode: Mode,
  requestId: string,
  failAudit = false,
) {
  const audit = new OperatorAuditService(client);
  if (failAudit)
    audit.recordSuccess = async () => {
      throw new Error('injected audit failure');
    };
  const actor = { userId: actorId, role: 'admin' as const };
  return mode === 'role'
    ? new OperatorAccountManagementService(client, audit).updateUserRole(
        actor,
        targetId,
        { role: 'user' },
        { requestId },
      )
    : new OperatorUserStatusService(client, audit).updateUserStatus(
        actor,
        targetId,
        { status: mode },
        { requestId },
      );
}
function outcome(p: Promise<unknown>) {
  return p.then(
    () => 'ok',
    (e: unknown) => {
      assert.equal(e instanceof HttpException, true);
      return ((e as HttpException).getResponse() as { error: { code: string } })
        .error.code;
    },
  );
}
async function waitLock(fragment: string) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const rows = await db.$queryRaw<Array<{ found: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND query LIKE ${`%${fragment}%`}) AS found`;
    if (rows[0].found) return;
    await sleep(10);
  }
  throw new Error('Expected real PG lock waiter');
}
let users: string[] = [];
async function fixture(admins: number) {
  assert.equal(await db.user.count(), 0, 'fresh disposable empty DB required');
  const made: Array<{ id: string }> = [];
  for (let i = 0; i < admins + 1; i++) {
    made.push(
      await db.user.create({
        data: {
          email: `${randomUUID()}@example.test`,
          nickname: `admin-${randomUUID()}`,
          passwordHash: 'test-only',
          role: i < admins ? 'admin' : 'user',
          status: 'active',
        },
      }),
    );
    users = made.map((u) => u.id);
  }
  users = made.map((u) => u.id);
  for (const userId of users)
    await db.refreshTokenSession.create({
      data: {
        userId,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
}
async function cleanup() {
  await db.operatorAuditLog.deleteMany({
    where: { actorUserId: { in: users } },
  });
  await db.user.deleteMany({ where: { id: { in: users } } });
  users = [];
}
async function verify(
  requestId: string,
  targetId: string,
  mode: Mode,
  result: string,
) {
  const user = await db.user.findUniqueOrThrow({ where: { id: targetId } });
  const session = await db.refreshTokenSession.findFirstOrThrow({
    where: { userId: targetId },
  });
  const audit = await db.operatorAuditLog.findMany({ where: { requestId } });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].result, result === 'ok' ? 'success' : 'failure');
  assert.equal(audit[0].errorCode, result === 'ok' ? null : result);
  assert.equal(audit[0].targetId, targetId);
  const metadata = audit[0].metadataJson as Record<string, unknown>;
  if (result === 'ok') {
    if (mode === 'role') {
      assert.equal(metadata.beforeRole, 'admin');
      assert.equal(metadata.afterRole, 'user');
    } else {
      assert.equal(metadata.beforeStatus, 'active');
      assert.equal(metadata.afterStatus, mode);
      assert.equal(metadata.revokedRefreshSessionCount, 1);
    }
  } else {
    assert.equal(metadata.failureCode, result);
  }
  if (result === 'ok') {
    assert.equal(
      mode === 'role' ? user.role : user.status,
      mode === 'role' ? 'user' : mode,
    );
    assert.equal(session.status, mode === 'role' ? 'active' : 'revoked');
    assert.equal(session.revokedAt !== null, mode !== 'role');
  } else {
    assert.equal(user.role, 'admin');
    assert.equal(user.status, 'active');
    assert.equal(session.status, 'active');
    assert.equal(session.revokedAt === null, true);
  }
  assert.equal(
    (await db.user.count({ where: { role: 'admin', status: 'active' } })) >= 1,
    true,
  );
}
async function race(
  a: Mode,
  b: Mode,
  admins = 2,
  duplicate = false,
  ordinary = false,
  rollback = false,
) {
  await fixture(admins);
  const reached = latch(),
    release = latch();
  const hooked = intercept(first, 'user', 'count', async () => {
    reached.release();
    await release.promise;
  });
  const targetA = users[0],
    targetB = duplicate ? users[0] : ordinary ? users[admins] : users[1];
  const idA = randomUUID(),
    idB = randomUUID();
  const one = outcome(command(hooked, users[1], targetA, a, idA, rollback));
  try {
    await reached.promise;
    const two = outcome(
      command(
        second,
        users[0] === targetB ? users[1] : users[0],
        targetB,
        b,
        idB,
      ),
    );
    if (ordinary) {
      assert.equal(await two, 'ok'); // must finish while admin guard is held
    } else
      await waitLock(duplicate ? 'FOR NO KEY UPDATE' : 'pg_advisory_xact_lock');
    release.release();
    const [ra, rb] = await Promise.all([one, two]);
    await verify(idA, targetA, a, ra);
    if (!duplicate && !ordinary) await verify(idB, targetB, b, rb);
    else {
      const audit = await db.operatorAuditLog.findMany({
        where: { requestId: idB },
      });
      assert.equal(audit.length, 1);
      assert.equal(audit[0].result, rb === 'ok' ? 'success' : 'failure');
      if (ordinary) {
        assert.equal(
          (await db.user.findUniqueOrThrow({ where: { id: targetB } })).status,
          'suspended',
        );
        assert.equal(
          (
            await db.refreshTokenSession.findFirstOrThrow({
              where: { userId: targetB },
            })
          ).status,
          'revoked',
        );
      } else
        assert.equal(
          rb,
          a === 'role'
            ? 'ROLE_ALREADY_ASSIGNED'
            : 'USER_STATUS_ALREADY_ASSIGNED',
        );
    }
    if (rollback)
      assert.equal(
        ra,
        a === 'role'
          ? 'OPERATOR_ROLE_CHANGE_FAILED'
          : 'USER_STATUS_CHANGE_FAILED',
      );
    else assert.equal(ra, 'ok');
    if (!ordinary && !duplicate)
      assert.equal(
        rb,
        admins === 2 && !rollback
          ? b === 'role'
            ? 'LAST_ADMIN_ROLE_CHANGE_FORBIDDEN'
            : 'LAST_ADMIN_STATUS_CHANGE_FORBIDDEN'
          : 'ok',
      );
    console.log(
      JSON.stringify({
        race: `${a}/${b}`,
        admins,
        duplicate,
        ordinary,
        rollback,
        outcomes: [ra, rb],
        activeAdmins: await db.user.count({
          where: { role: 'admin', status: 'active' },
        }),
      }),
    );
  } finally {
    release.release();
    await one;
    await cleanup();
  }
}
async function main() {
  await Promise.all([db, first, second].map((p) => p.$connect()));
  for (const mode of ['role', 'suspended', 'deleted'] as const) {
    await fixture(1);
    const id = randomUUID();
    const result = await outcome(command(first, users[1], users[0], mode, id));
    assert.equal(
      result,
      mode === 'role'
        ? 'LAST_ADMIN_ROLE_CHANGE_FORBIDDEN'
        : 'LAST_ADMIN_STATUS_CHANGE_FORBIDDEN',
    );
    await verify(id, users[0], mode, result);
    await cleanup();
  }
  for (let i = 0; i < 3; i++) {
    await race('role', 'role');
    await race('suspended', 'suspended');
    await race('role', 'suspended');
  }
  await race('role', 'deleted');
  await race('role', 'role', 4);
  await race('role', 'suspended', 3);
  await race('role', 'role', 3, true);
  await race('suspended', 'suspended', 3, true);
  await race('role', 'suspended', 2, false, true);
  await race('role', 'suspended', 2, false, false, true);
  await race('suspended', 'role', 2, false, false, true);
  // Fail after actual session UPDATE: user and session changes must roll back.
  await fixture(2);
  const id = randomUUID();
  const broken = intercept(
    first,
    'refreshTokenSession',
    'updateMany',
    async () => {
      throw new Error('injected session failure');
    },
  );
  const result = await outcome(
    command(broken, users[1], users[0], 'deleted', id),
  );
  assert.equal(result, 'USER_STATUS_CHANGE_FAILED');
  await verify(id, users[0], 'deleted', result);
  await cleanup();
  console.log('active admin race PostgreSQL ok');
}
main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : 'admin regression failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    if (users.length) await cleanup();
    await Promise.all([db, first, second].map((p) => p.$disconnect()));
  });
