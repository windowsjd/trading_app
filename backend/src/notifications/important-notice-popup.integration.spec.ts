import { spawnSync } from 'node:child_process';

/**
 * 공지 팝업 against PostgreSQL (2026-11-13): the popup read's NOT EXISTS
 * filter and the confirmation's ON CONFLICT DO NOTHING, which the unit tests
 * can only imitate. Opt-in (needs a disposable *_test database):
 * NOTICE_POPUP_DB_INTEGRATION=1 DATABASE_URL=postgresql://…/x_test
 */
const RUN = process.env.NOTICE_POPUP_DB_INTEGRATION === '1';

describe('Important notice popup DB integration', () => {
  it(
    RUN
      ? 'lists only unconfirmed published popup notices per member and keeps one confirmation per member and notice'
      : 'is disabled unless NOTICE_POPUP_DB_INTEGRATION=1',
    () => {
      if (!RUN) {
        expect(process.env.NOTICE_POPUP_DB_INTEGRATION).not.toBe('1');
        return;
      }
      if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? ''))
        throw new Error('Requires a local disposable *_test DATABASE_URL.');
      const result = spawnSync('pnpm', ['tsx', '-e', RUNNER], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (result.status !== 0)
        throw new Error(
          [
            'Runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      expect(result.stdout).toContain('notice popup db ok');
    },
    70_000,
  );
});

const RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { UserRole } from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { OperatorAuditService } from './src/operator/operator-audit.service';
import { ImportantNoticesService } from './src/notifications/important-notices.service';

const prisma = new PrismaService();
const notices = new ImportantNoticesService(prisma, new OperatorAuditService(prisma));
const tag = randomUUID().slice(0, 8);
const userIds: string[] = [];
const noticeIds: string[] = [];
const context = { requestId: null, ipAddress: '127.0.0.1', userAgent: 'notice-popup-db' };
const sections = [{ heading: '안내', paragraphs: ['첫 줄\\n둘째 줄'] }];

async function member(role: UserRole) {
  const row = await prisma.user.create({ data: {
    email: 'popup-' + tag + '-' + userIds.length + '@example.test', passwordHash: 'x',
    nickname: 'popup-' + tag + '-' + userIds.length, role,
  } });
  userIds.push(row.id);
  return { userId: row.id, role };
}
async function notice(admin: { userId: string; role: UserRole }, key: string, body: Record<string, unknown>, publish: boolean) {
  const created = await notices.create(admin, { title: key, summary: key + ' 요약', sections, idempotencyKey: key + '-' + tag, ...body }, context);
  noticeIds.push(created.data.notice.id);
  if (publish) await notices.publish(admin, created.data.notice.id, { confirm: true }, context);
  return created.data.notice.id;
}
const popupIds = async (who: { userId: string; role: UserRole }) =>
  (await notices.listPopupFor(who)).data.notices.map((row) => row.id);
async function code(promise: Promise<unknown>) {
  try { await promise; } catch (error) {
    if (error instanceof HttpException) return (error.getResponse() as { error: { code: string } }).error.code;
    throw error;
  }
  return null;
}

async function main() {
  await prisma.$connect();
  try {
    const admin = await member(UserRole.admin);
    const a = await member(UserRole.user);
    const b = await member(UserRole.user);
    // A notice from before popups (no field) and a non-popup one never pop up.
    const before = await notice(admin, 'before', {}, true);
    const plain = await notice(admin, 'plain', { showPopup: false }, true);
    const draft = await notice(admin, 'draft', { showPopup: true }, false);
    const first = await notice(admin, 'first', { showPopup: true }, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await notice(admin, 'second', { showPopup: true }, true);
    const stored = await prisma.importantNotice.findMany({ where: { id: { in: noticeIds } }, select: { id: true, showPopup: true } });
    assert.equal(stored.find((row) => row.id === before)?.showPopup, false);
    assert.equal(stored.find((row) => row.id === plain)?.showPopup, false);

    // Newest first, published popup notices only.
    const listed = (await popupIds(a)).filter((id) => noticeIds.includes(id));
    assert.deepEqual(listed, [second, first]);

    // Five devices confirming at once, then a retry: one row, the first time kept.
    const answers = await Promise.all(Array.from({ length: 5 }, () => notices.acknowledge(a, second)));
    const retry = await notices.acknowledge(a, second);
    assert.equal(new Set([...answers, retry].map((answer) => answer.data.acknowledgedAt)).size, 1);
    assert.equal(await prisma.importantNoticeAcknowledgement.count({ where: { userId: a.userId, noticeId: second } }), 1);
    assert.deepEqual((await popupIds(a)).filter((id) => noticeIds.includes(id)), [first]);
    // Another member keeps their own state.
    assert.deepEqual((await popupIds(b)).filter((id) => noticeIds.includes(id)), [second, first]);

    // A draft cannot be confirmed (or seen); an unknown id neither.
    assert.equal(await code(notices.acknowledge(a, draft)), 'NOTICE_NOT_FOUND');
    assert.equal(await code(notices.acknowledge(a, randomUUID())), 'NOTICE_NOT_FOUND');
    assert.equal(await prisma.importantNoticeAcknowledgement.count({ where: { noticeId: draft } }), 0);

    // Withdrawn: no longer offered; a confirmation still on its way is accepted.
    await notices.withdraw(admin, first, context);
    assert.deepEqual((await popupIds(b)).filter((id) => noticeIds.includes(id)), [second]);
    await notices.acknowledge(b, first);
    assert.equal(await prisma.importantNoticeAcknowledgement.count({ where: { userId: b.userId, noticeId: first } }), 1);

    // The member lookup is served by the (user_id, notice_id) primary key.
    const plan = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      'EXPLAIN SELECT 1 FROM important_notice_acknowledgements WHERE user_id = $1 AND notice_id = $2', a.userId, second);
    assert.ok(plan.some((row) => /important_notice_acknowledgements_pkey/.test(row['QUERY PLAN'])), JSON.stringify(plan));
    console.log('notice popup db ok');
  } finally {
    await prisma.importantNoticeAcknowledgement.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.importantNotice.deleteMany({ where: { id: { in: noticeIds } } });
    await prisma.operatorAuditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
`;
