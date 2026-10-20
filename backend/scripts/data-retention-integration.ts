/** Data retention on an isolated PostgreSQL (docs/data-retention.md): each
 * retention boundary, valid sessions kept, answers deleted before their
 * inquiries, the batch bound, the advisory lock, locked rows and the
 * emergency stop. The service deletes by retention criteria across the whole
 * database, so this runs only against a disposable loopback *_test database. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  DATA_RETENTION_BATCH,
  DataRetentionCleanupService,
} from '../src/auth/data-retention-cleanup.service';
import { dataRetentionConfig } from '../src/auth/data-retention.config';

function disposableDatabase(value: string | undefined) {
  try {
    const url = new URL(value ?? '');
    return (
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      /_test$/.test(decodeURIComponent(url.pathname.slice(1)))
    );
  } catch {
    return false;
  }
}
if (
  process.env.DATA_RETENTION_DB_INTEGRATION !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !disposableDatabase(process.env.DATABASE_URL)
) {
  throw new Error(
    'Requires DATA_RETENTION_DB_INTEGRATION=1 NODE_ENV=test and a loopback *_test DATABASE_URL.',
  );
}
for (const name of [
  'DATA_RETENTION_CLEANUP_ENABLED',
  'AUTH_SESSION_RETENTION_DAYS',
  'OPERATOR_AUDIT_LOG_RETENTION_DAYS',
  'INQUIRY_RETENTION_DAYS',
])
  delete process.env[name];
// The service's own diagnostics are asserted in unit tests; keep stdout clean.
Logger.overrideLogger(false);

const db = new PrismaService();
const tag = randomUUID().slice(0, 8);
const DAY = 86_400_000;
const config = dataRetentionConfig({});
const users: string[] = [];
let checks = 0;
function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
  checks++;
}

async function dbNow(): Promise<Date> {
  const [row] = await db.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  return row.now;
}

async function user(name: string, role: 'user' | 'operator' = 'user') {
  const row = await db.user.create({
    data: {
      email: `retention-${tag}-${name}@example.invalid`,
      nickname: `retention-${tag}-${name}`,
      passwordHash: 'test-only',
      role,
    },
  });
  users.push(row.id);
  return row;
}

async function run() {
  const service = new DataRetentionCleanupService(db);
  // Rows already past retention elsewhere in this database would blur counts.
  for (;;) {
    const drained = await service.deleteBatch(config);
    if (
      !drained ||
      Object.values(drained).every((count) => count < DATA_RETENTION_BATCH)
    )
      break;
  }
  const now = await dbNow();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const ahead = (days: number) => new Date(now.getTime() + days * DAY);
  const member = await user('member');
  const operator = await user('operator', 'operator');

  // Refresh sessions: a session ends at expiry, or at revocation if earlier.
  const session = (
    name: string,
    data: {
      status?: 'active' | 'revoked';
      expiresAt: Date;
      revokedAt?: Date;
      replacedBySessionId?: string;
    },
  ) =>
    db.refreshTokenSession.create({
      data: {
        id: `${tag}-${name}`,
        userId: member.id,
        tokenHash: `${tag}-${name}`,
        status: data.status ?? 'active',
        expiresAt: data.expiresAt,
        revokedAt: data.revokedAt ?? null,
        replacedBySessionId: data.replacedBySessionId ?? null,
        ipAddress: '192.0.2.10',
        userAgent: 'retention-integration',
      },
    });
  await session('valid', { expiresAt: ahead(7) });
  await session('expired-89', { expiresAt: ago(89) });
  await session('expired-91', { expiresAt: ago(91) });
  await session('revoked-early-91', {
    status: 'revoked',
    revokedAt: ago(91),
    expiresAt: ahead(30),
  });
  await session('revoked-89', {
    status: 'revoked',
    revokedAt: ago(89),
    expiresAt: ago(60),
  });
  await session('revoked-after-expiry', {
    status: 'revoked',
    revokedAt: ago(10),
    expiresAt: ago(91),
  });
  await session('revoked-untimed-91', {
    status: 'revoked',
    expiresAt: ago(91),
  });
  await session('revoked-untimed-89', {
    status: 'revoked',
    expiresAt: ago(89),
  });
  // Deleting a replacement keeps the session it replaced (FK SET NULL).
  await session('replacement-95', {
    status: 'revoked',
    revokedAt: ago(95),
    expiresAt: ago(70),
  });
  await session('replaced-30', {
    status: 'revoked',
    revokedAt: ago(30),
    expiresAt: ahead(5),
    replacedBySessionId: `${tag}-replacement-95`,
  });

  // Operator audit logs: one year from creation.
  const audit = (name: string, createdAt: Date) =>
    db.operatorAuditLog.create({
      data: {
        id: `${tag}-${name}`,
        actorUserId: operator.id,
        actorRole: 'operator',
        action: 'retention.integration',
        targetType: 'user',
        targetId: member.id,
        ipAddress: '192.0.2.11',
        result: 'success',
        createdAt,
      },
    });
  await audit('audit-364', ago(364));
  await audit('audit-366', ago(366));

  // Inquiries: three years from the answer, or from filing if unanswered.
  const inquiry = async (name: string, createdAt: Date, answeredAt?: Date) => {
    const row = await db.inquiry.create({
      data: {
        id: `${tag}-${name}`,
        userId: member.id,
        clientRequestId: `${tag}-${name}`,
        category: 'account',
        title: name,
        content: 'retention integration',
        createdAt,
      },
    });
    if (answeredAt)
      await db.inquiryAnswer.create({
        data: {
          id: `${tag}-${name}-answer`,
          inquiryId: row.id,
          answeredByUserId: operator.id,
          idempotencyKey: `${tag}-${name}`,
          content: 'answer',
          answeredAt,
        },
      });
  };
  await inquiry('open-1094', ago(1094));
  await inquiry('open-1096', ago(1096));
  await inquiry('answered-1094', ago(2000), ago(1094));
  await inquiry('answered-1096', ago(2000), ago(1096));

  const result = await service.deleteBatch(config);
  assert.deepEqual(result, { sessions: 5, auditLogs: 1, inquiries: 2 });
  checks++;
  const sessions = await db.refreshTokenSession.findMany({
    where: { userId: member.id },
    select: { id: true, replacedBySessionId: true },
  });
  assert.deepEqual(sessions.map((row) => row.id.slice(tag.length + 1)).sort(), [
    'expired-89',
    'replaced-30',
    'revoked-89',
    'revoked-untimed-89',
    'valid',
  ]);
  checks++;
  check(
    sessions.find((row) => row.id === `${tag}-replaced-30`)
      ?.replacedBySessionId === null,
    'a session whose replacement was deleted stays, without the link',
  );
  check(
    (await db.operatorAuditLog.count({ where: { id: `${tag}-audit-364` } })) ===
      1 &&
      (await db.operatorAuditLog.count({
        where: { id: `${tag}-audit-366` },
      })) === 0,
    'audit logs are kept 365 days',
  );
  const inquiries = await db.inquiry.findMany({
    where: { userId: member.id },
    select: { id: true, answer: { select: { id: true } } },
  });
  assert.deepEqual(
    inquiries
      .map((row) => [row.id.slice(tag.length + 1), row.answer !== null])
      .sort(),
    [
      ['answered-1094', true],
      ['open-1094', false],
    ],
  );
  checks++;
  check(
    (await db.inquiryAnswer.count({
      where: { id: `${tag}-answered-1096-answer` },
    })) === 0,
    'an answer goes with its inquiry',
  );
  check(
    (await db.user.count({ where: { id: { in: users } } })) === 2,
    'members and operators are never deleted by retention',
  );

  // A competing instance holding the advisory lock skips the whole pass.
  await audit('audit-locked-pass', ago(400));
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('data-retention', 0))::text`;
    check(
      (await service.deleteBatch(config)) === null,
      'no pass while another instance holds the lock',
    );
  });
  check(
    (await db.operatorAuditLog.count({
      where: { id: `${tag}-audit-locked-pass` },
    })) === 1,
    'nothing is deleted without the lock',
  );

  // A locked old row is skipped, not waited for.
  await audit('audit-row-locked', ago(400));
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM operator_audit_logs WHERE id = ${`${tag}-audit-row-locked`} FOR UPDATE`;
    const skipped = await service.deleteBatch(config);
    check(skipped?.auditLogs === 1, 'the unlocked old row is deleted');
    check(
      (await tx.operatorAuditLog.count({
        where: { id: `${tag}-audit-row-locked` },
      })) === 1,
      'the locked row is skipped',
    );
  });

  // One batch deletes at most 500 rows per table.
  await db.operatorAuditLog.createMany({
    data: Array.from({ length: DATA_RETENTION_BATCH + 1 }, (_, i) => ({
      id: `${tag}-bulk-${i}`,
      actorUserId: operator.id,
      actorRole: 'operator' as const,
      action: 'retention.integration',
      result: 'success' as const,
      createdAt: ago(400),
    })),
  });
  const bounded = await service.deleteBatch(config);
  check(
    bounded?.auditLogs === DATA_RETENTION_BATCH,
    'a batch is bounded to 500 rows',
  );
  check(
    (await db.operatorAuditLog.count({
      where: { actorUserId: operator.id, createdAt: { lt: ago(365) } },
    })) === 2,
    'the rest waits for the next batch',
  );

  // The emergency stop keeps everything; the scheduled run drains a backlog.
  await db.operatorAuditLog.createMany({
    data: Array.from({ length: DATA_RETENTION_BATCH }, (_, i) => ({
      id: `${tag}-backlog-${i}`,
      actorUserId: operator.id,
      actorRole: 'operator' as const,
      action: 'retention.integration',
      result: 'success' as const,
      createdAt: ago(400),
    })),
  });
  process.env.DATA_RETENTION_CLEANUP_ENABLED = 'false';
  await new DataRetentionCleanupService(db).runIfDue();
  check(
    (await db.operatorAuditLog.count({
      where: { actorUserId: operator.id, createdAt: { lt: ago(365) } },
    })) ===
      DATA_RETENTION_BATCH + 2,
    'DATA_RETENTION_CLEANUP_ENABLED=false deletes nothing',
  );
  delete process.env.DATA_RETENTION_CLEANUP_ENABLED;
  await new DataRetentionCleanupService(db).runIfDue();
  check(
    (await db.operatorAuditLog.count({
      where: { actorUserId: operator.id, createdAt: { lt: ago(365) } },
    })) === 0,
    'one scheduled run continues past a full batch',
  );
  check(
    (await db.operatorAuditLog.count({ where: { id: `${tag}-audit-364` } })) ===
      1,
    'a row inside its period survives every run',
  );
}

async function cleanup() {
  if (!users.length) return;
  await db.refreshTokenSession.deleteMany({ where: { userId: { in: users } } });
  await db.operatorAuditLog.deleteMany({
    where: { actorUserId: { in: users } },
  });
  await db.inquiryAnswer.deleteMany({
    where: { answeredByUserId: { in: users } },
  });
  await db.inquiry.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
}

run()
  .then(() => {
    console.log(`data retention PostgreSQL ok (${checks} checks)`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanup();
    } finally {
      await db.$disconnect();
    }
  });
