/** Isolated PostgreSQL + real HTTP/guard integration for support inquiries
 * and their operator answers; no financial writes. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { AccessTokenGuard } from '../src/auth/access-token.guard';
import {
  InquiriesController,
  OperatorInquiriesController,
} from '../src/inquiries/inquiries.controller';
import {
  InquiriesService,
  INQUIRY_RATE_LIMIT,
} from '../src/inquiries/inquiries.service';
import { OperatorInquiriesService } from '../src/inquiries/operator-inquiries.service';
import { OperatorAuditService } from '../src/operator/operator-audit.service';
import { OperatorGuard } from '../src/operator/operator.guard';

const url = process.env.DATABASE_URL ?? '';
if (
  process.env.INQUIRIES_DB_INTEGRATION !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)
) {
  throw new Error(
    'Requires INQUIRIES_DB_INTEGRATION=1 NODE_ENV=test and a loopback DATABASE_URL.',
  );
}
const db = new PrismaService();
const tag = randomUUID().slice(0, 8);
const userIds: string[] = [];
let closeHttp: (() => Promise<void>) | undefined;
let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
  assertions++;
}

const migration = (name: string) =>
  readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');

/** The migration SQL itself, in a throwaway schema (rolled back): an inquiry
 * filed before the answer migration survives it unchanged and unanswered. */
async function migrationShape() {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schema = `inquiries_migration_${tag}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query('CREATE TABLE users (id TEXT PRIMARY KEY)');
    await client.query(migration('20261012120000_add_user_inquiries'));
    await client.query("INSERT INTO users VALUES ('u1'), ('op1')");
    await client.query(
      "INSERT INTO inquiries (id, user_id, client_request_id, category, title, content) VALUES ('i1', 'u1', 'k1', 'bug', 'title', 'content body')",
    );
    const before = await client.query('SELECT * FROM inquiries ORDER BY id');
    await client.query(migration('20261017180000_add_inquiry_answers'));
    const after = await client.query('SELECT * FROM inquiries ORDER BY id');
    check(
      JSON.stringify(after.rows) === JSON.stringify(before.rows),
      'answer migration: existing inquiries unchanged',
    );
    const unanswered = await client.query(
      'SELECT count(*)::int AS n FROM inquiries i LEFT JOIN inquiry_answers a ON a.inquiry_id = i.id WHERE a.id IS NULL',
    );
    check(unanswered.rows[0].n === 1, 'answer migration: old inquiry pending');
    await client.query(
      "INSERT INTO inquiry_answers (id, inquiry_id, answered_by_user_id, idempotency_key, content) VALUES ('a1', 'i1', 'op1', 'key-1', '답변입니다')",
    );
    for (const [label, sql] of [
      [
        'a second answer',
        "INSERT INTO inquiry_answers (id, inquiry_id, answered_by_user_id, idempotency_key, content) VALUES ('a2', 'i1', 'op1', 'key-2', '두 번째')",
      ],
      [
        'a blank answer',
        "INSERT INTO inquiry_answers (id, inquiry_id, answered_by_user_id, idempotency_key, content) VALUES ('a3', 'i1', 'op1', 'key-3', '   ')",
      ],
      [
        'an unknown inquiry',
        "INSERT INTO inquiry_answers (id, inquiry_id, answered_by_user_id, idempotency_key, content) VALUES ('a4', 'nope', 'op1', 'key-4', '답변')",
      ],
      ['deleting an answered inquiry', "DELETE FROM inquiries WHERE id = 'i1'"],
    ]) {
      await client.query('SAVEPOINT answer_check');
      await assert.rejects(client.query(sql), label);
      await client.query('ROLLBACK TO SAVEPOINT answer_check');
    }
    check(true, 'answer migration: one non-blank answer per existing inquiry');
    await client.query('SAVEPOINT duplicate');
    await assert.rejects(
      client.query(
        "INSERT INTO inquiries (id, user_id, client_request_id, category, title, content) VALUES ('i2', 'u1', 'k1', 'bug', 't', 'c')",
      ),
    );
    await client.query('ROLLBACK TO SAVEPOINT duplicate');
    await assert.rejects(
      client.query(
        "INSERT INTO inquiries (id, user_id, client_request_id, category, title, content) VALUES ('i3', 'u1', 'k3', 'refund', 't', 'c')",
      ),
    );
    check(
      true,
      'migration: unique (user, request id) and closed category enum',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

async function financialState() {
  const counts = await Promise.all([
    db.cashWallet.count(),
    db.walletTransaction.count(),
    db.order.count(),
    db.position.count(),
  ]);
  return counts.join(':');
}

async function run() {
  await migrationShape();
  // 0, 1: users; 2: suspended user; 3, 4: operator, admin; 5: suspended operator.
  for (const [index, [status, role]] of (
    [
      ['active', 'user'],
      ['active', 'user'],
      ['suspended', 'user'],
      ['active', 'operator'],
      ['active', 'admin'],
      ['suspended', 'operator'],
    ] as const
  ).entries()) {
    const user = await db.user.create({
      data: {
        email: `${tag}-${index}@example.invalid`,
        nickname: `inquiry-${tag}-${index}`,
        passwordHash: 'test-only',
        status,
        role,
      },
    });
    userIds.push(user.id);
  }
  const baseline = await financialState();
  const jwt = new JwtService();
  const config = new ConfigService({
    JWT_ACCESS_SECRET:
      'inquiries-integration-only-secret-with-32-plus-characters',
    JWT_ACCESS_TTL: '15m',
    REFRESH_TOKEN_TTL: '30d',
  });
  // tsx omits emitDecoratorMetadata; supply the constructor metadata tsc emits.
  Reflect.defineMetadata(
    'design:paramtypes',
    [InquiriesService],
    InquiriesController,
  );
  Reflect.defineMetadata(
    'design:paramtypes',
    [OperatorInquiriesService],
    OperatorInquiriesController,
  );
  const audit = new OperatorAuditService(db);
  const app = await Test.createTestingModule({
    controllers: [InquiriesController, OperatorInquiriesController],
    providers: [
      { provide: InquiriesService, useValue: new InquiriesService(db) },
      {
        provide: OperatorInquiriesService,
        useValue: new OperatorInquiriesService(db, audit),
      },
      OperatorGuard,
    ],
  }).compile();
  const http = app.createNestApplication();
  http.useGlobalGuards(new AccessTokenGuard(jwt, db, new Reflector(), config));
  await http.init();
  closeHttp = () => http.close();
  const server = http.getHttpServer();
  const token = (index: number) =>
    jwt.sign(
      { sub: userIds[index] },
      { secret: config.get<string>('JWT_ACCESS_SECRET')! },
    );
  const post = (body: object, index = 0) =>
    request(server)
      .post('/api/v1/inquiries')
      .auth(token(index), { type: 'bearer' })
      .send(body);
  const mine = (index = 0, query = '') =>
    request(server)
      .get(`/api/v1/inquiries/me${query}`)
      .auth(token(index), { type: 'bearer' });
  const body = (key: string, patch: object = {}) => ({
    clientRequestId: `inquiry_${tag}_${key}`,
    category: 'wallet',
    title: '  환전 문의  ',
    content: '환전 후 지갑 잔액이 바로 보이지 않습니다.',
    ...patch,
  });
  const rows = () => db.inquiry.count({ where: { userId: { in: userIds } } });

  let r = await request(server).post('/api/v1/inquiries').send(body('anon'));
  check(r.status === 401, 'no token is rejected by the guard');
  r = await post(body('suspended'), 2);
  check(r.status === 403, 'an inactive user cannot file');
  r = await post(body('bad', { category: 'refund' }));
  check(
    r.status === 400 && r.body.error.code === 'INVALID_INQUIRY',
    'invalid category rejected',
  );
  r = await post(body('bad2', { content: 'short' }));
  check(
    r.status === 400 && (await rows()) === 0,
    'invalid content writes nothing',
  );

  r = await post(body('one'));
  check(
    r.status === 201 &&
      r.body.success === true &&
      r.body.data.replayed === false,
    'created',
  );
  const first = r.body.data.inquiry;
  check(
    first.title === '환전 문의' && first.category === 'wallet',
    'stored trimmed',
  );
  const stored = await db.inquiry.findUniqueOrThrow({
    where: { id: first.id },
  });
  check(
    stored.userId === userIds[0],
    'owned by the authenticated user, not a body field',
  );

  r = await post(body('one', { userId: userIds[1] }));
  check(
    r.status === 201 &&
      r.body.data.replayed === true &&
      r.body.data.inquiry.id === first.id,
    'resubmit returns the same inquiry',
  );
  check((await rows()) === 1, 'resubmit never files twice');
  r = await post(body('one', { content: '같은 키로 다른 내용을 보냅니다.' }));
  check(
    r.status === 409 && r.body.error.code === 'INQUIRY_IDEMPOTENCY_CONFLICT',
    'different body under a used key conflicts',
  );

  const burst = await Promise.all([1, 2, 3].map(() => post(body('burst'))));
  const ids = new Set(burst.map((response) => response.body.data?.inquiry?.id));
  check(
    burst.every((response) => response.status === 201) && ids.size === 1,
    'concurrent duplicate taps resolve to one inquiry',
  );
  check((await rows()) === 2, 'one row per request id under concurrency');

  r = await mine(1);
  check(
    r.status === 200 && r.body.data.items.length === 0,
    'another user sees none of these',
  );
  r = await mine(0, '?limit=1');
  check(
    r.body.data.items.length === 1 && r.body.data.pagination.total === 2,
    'own list is paginated',
  );
  r = await mine(0, '?limit=0');
  check(r.status === 400, 'invalid pagination rejected');

  for (let index = 2; index < INQUIRY_RATE_LIMIT.count; index++) {
    r = await post(body(`rate-${index}`));
    check(r.status === 201, `within the rate window (${index + 1})`);
  }
  r = await post(body('rate-over'));
  check(
    r.status === 429 && r.body.error.code === 'INQUIRY_RATE_LIMITED',
    'rate limited after the window count',
  );
  r = await post(body('one'));
  check(
    r.status === 201 && r.body.data.replayed === true,
    'a replay is still answered when limited',
  );

  await operatorAnswers(server, token, mine, first.id);

  check(
    (await financialState()) === baseline,
    'inquiries never change financial rows',
  );
  console.log(`inquiries PostgreSQL + HTTP ok (${assertions} assertions)`);
}

type Server = Parameters<typeof request>[0];

/** Operator answers over real HTTP + guards against the same database. */
async function operatorAnswers(
  server: Server,
  token: (index: number) => string,
  mine: (index?: number, query?: string) => request.Test,
  inquiryId: string,
) {
  const operatorGet = (index: number, path = '') =>
    request(server)
      .get(`/api/v1/operator/inquiries${path}`)
      .auth(token(index), { type: 'bearer' });
  const answer = (index: number, body: object, id = inquiryId) =>
    request(server)
      .post(`/api/v1/operator/inquiries/${id}/answer`)
      .auth(token(index), { type: 'bearer' })
      .set('x-request-id', `req-${tag}`)
      .send(body);
  const answers = () =>
    db.inquiryAnswer.count({ where: { inquiry: { userId: userIds[0] } } });
  const original = await db.inquiry.findUniqueOrThrow({
    where: { id: inquiryId },
  });

  let r = await request(server).get('/api/v1/operator/inquiries');
  check(r.status === 401, 'operator list needs a token');
  r = await operatorGet(0);
  check(
    r.status === 403 && r.body.error.code === 'OPERATOR_FORBIDDEN',
    'a user cannot list inquiries',
  );
  r = await answer(0, { content: '셀프 답변입니다', idempotencyKey: 'self-1' });
  check(
    r.status === 403 && (await answers()) === 0,
    'a user cannot answer, even their own inquiry',
  );
  r = await answer(5, { content: '정지된 운영자', idempotencyKey: 'sus-1' });
  check(
    r.status === 403 && r.body.error.code === 'USER_NOT_ACTIVE',
    'a suspended operator cannot answer',
  );

  r = await mine(0);
  check(
    r.body.data.items.every(
      (item: { status: string; answer: unknown }) =>
        item.status === 'pending' && item.answer === null,
    ),
    'before any answer every inquiry reads 답변 대기',
  );
  r = await operatorGet(3, '?status=pending&limit=50');
  check(
    r.status === 200 &&
      r.body.data.inquiries.some(
        (item: { id: string }) => item.id === inquiryId,
      ),
    'operator sees the pending inquiry',
  );
  r = await operatorGet(3, `/${inquiryId}`);
  check(
    r.status === 200 &&
      r.body.data.inquiry.content === original.content &&
      r.body.data.inquiry.user.id === userIds[0],
    'operator reads the original inquiry',
  );
  r = await operatorGet(3, '/missing-inquiry');
  check(r.status === 404, 'unknown inquiry 404');
  r = await answer(3, { content: ' ', idempotencyKey: 'blank-1' });
  check(
    r.status === 400 && r.body.error.code === 'INVALID_INQUIRY_ANSWER',
    'blank answer rejected',
  );
  r = await answer(3, { content: '답변', idempotencyKey: 'x' }, 'missing');
  check(r.status === 404, 'answer to a missing inquiry 404');

  // Operator and admin race to answer the same inquiry.
  const race = await Promise.all([
    answer(3, { content: '운영자 답변입니다.', idempotencyKey: `op-${tag}` }),
    answer(4, { content: '관리자 답변입니다.', idempotencyKey: `ad-${tag}` }),
  ]);
  const statuses = race.map((response) => response.status).sort();
  check(
    statuses[0] === 201 && statuses[1] === 409,
    'concurrent answers: exactly one wins',
  );
  check((await answers()) === 1, 'concurrent answers: one stored answer');
  const winner = race.find((response) => response.status === 201)!;
  const loser = race.find((response) => response.status === 409)!;
  check(
    loser.body.error.code === 'INQUIRY_ALREADY_ANSWERED',
    'the loser is told it was already answered',
  );
  const winnerIndex = winner === race[0] ? 3 : 4;
  const winnerBody =
    winnerIndex === 3
      ? { content: '운영자 답변입니다.', idempotencyKey: `op-${tag}` }
      : { content: '관리자 답변입니다.', idempotencyKey: `ad-${tag}` };

  // A lost response retried (several times at once) replays, never adds.
  const retries = await Promise.all(
    [1, 2, 3].map(() => answer(winnerIndex, winnerBody)),
  );
  check(
    retries.every(
      (response) => response.status === 201 && response.body.data.replayed,
    ) && (await answers()) === 1,
    'retried answer replays the stored one',
  );
  r = await answer(winnerIndex, { ...winnerBody, content: '고친 답변입니다.' });
  check(
    r.status === 409 &&
      r.body.error.code === 'INQUIRY_ANSWER_IDEMPOTENCY_CONFLICT',
    'same key, different text: conflict, no overwrite',
  );
  const stored = await db.inquiryAnswer.findUniqueOrThrow({
    where: { inquiryId },
  });
  check(
    stored.content === winnerBody.content &&
      stored.answeredByUserId === userIds[winnerIndex],
    'the first committed answer is kept with its operator',
  );
  const unchanged = await db.inquiry.findUniqueOrThrow({
    where: { id: inquiryId },
  });
  check(
    JSON.stringify(unchanged) === JSON.stringify(original),
    'answering never changes the inquiry row',
  );

  r = await mine(0);
  const shown = r.body.data.items.find(
    (item: { id: string }) => item.id === inquiryId,
  );
  check(
    shown.status === 'answered' &&
      shown.answer.content === winnerBody.content &&
      shown.answer.answeredAt === stored.answeredAt.toISOString() &&
      !JSON.stringify(shown).includes(userIds[winnerIndex]),
    'author sees the answer and time, not the operator',
  );
  r = await mine(0);
  check(
    JSON.stringify(
      r.body.data.items.find((item: { id: string }) => item.id === inquiryId),
    ) === JSON.stringify(shown),
    're-reading shows the same answer',
  );
  r = await mine(1);
  check(
    r.body.data.items.length === 0,
    'another user still sees none of these',
  );

  // An answer whose success audit fails is rolled back.
  const second = await db.inquiry.findFirstOrThrow({
    where: { userId: userIds[0], id: { not: inquiryId } },
  });
  const failingAudit = new OperatorAuditService(db);
  const realRecordSuccess = failingAudit.recordSuccess.bind(failingAudit);
  failingAudit.recordSuccess = ((input, client) =>
    client
      ? Promise.reject(new Error('audit insert failed'))
      : realRecordSuccess(input, client)) as typeof failingAudit.recordSuccess;
  const failing = new OperatorInquiriesService(db, failingAudit);
  await assert.rejects(
    failing.answer({ userId: userIds[3], role: 'operator' }, second.id, {
      content: '롤백될 답변입니다.',
      idempotencyKey: `rb-${tag}`,
    }),
    /audit insert failed/,
  );
  check(
    (await db.inquiryAnswer.count({ where: { inquiryId: second.id } })) === 0,
    'a failed audit leaves no answer',
  );
  r = await mine(0);
  check(
    r.body.data.items.find((item: { id: string }) => item.id === second.id)
      .status === 'pending',
    'and the inquiry still reads 답변 대기',
  );

  const audits = await db.operatorAuditLog.findMany({
    where: { actorUserId: { in: userIds } },
    orderBy: { createdAt: 'asc' },
  });
  const count = (action: string, result: string, code?: string) =>
    audits.filter(
      (row) =>
        row.action === action &&
        row.result === result &&
        (code === undefined || row.errorCode === code),
    ).length;
  check(
    count('operator.inquiry.answer', 'success') === 1,
    'one success audit for the one answer',
  );
  check(
    count('operator.inquiry.answer.replay', 'success') === 3,
    'replays are audited separately',
  );
  check(
    count(
      'operator.inquiry.answer.failed',
      'failure',
      'INQUIRY_ALREADY_ANSWERED',
    ) === 1 &&
      count(
        'operator.inquiry.answer.failed',
        'failure',
        'INQUIRY_ANSWER_IDEMPOTENCY_CONFLICT',
      ) === 1 &&
      count(
        'operator.inquiry.answer.failed',
        'failure',
        'INVALID_INQUIRY_ANSWER',
      ) === 1 &&
      count(
        'operator.inquiry.answer.failed',
        'failure',
        'INQUIRY_NOT_FOUND',
      ) === 1 &&
      count(
        'operator.inquiry.answer.failed',
        'failure',
        'INQUIRY_ANSWER_FAILED',
      ) === 1,
    'conflict, invalid, not-found and failed attempts are told apart',
  );
  check(
    count('operator.inquiries.list', 'success') >= 1 &&
      count('operator.inquiry.get', 'success') === 1,
    'operator reads are audited',
  );
  check(
    audits.every((row) => {
      const text = JSON.stringify(row);
      return !text.includes(original.content) && !text.includes('답변입니다');
    }),
    'audits hold no inquiry or answer text',
  );

  // Paging reaches the oldest inquiry across the 20-row boundary.
  const base = Date.now() - 86_400_000;
  await db.inquiry.createMany({
    data: Array.from({ length: 23 }, (_, index) => ({
      userId: userIds[1],
      clientRequestId: `inquiry_${tag}_page_${index}`,
      category: 'other' as const,
      title: `페이지 문의 ${index}`,
      content: '페이지 경계 확인용 문의입니다.',
      createdAt: new Date(base + index * 1000),
    })),
  });
  const page1 = await mine(1, '?limit=20&offset=0');
  const page2 = await mine(
    1,
    `?limit=20&offset=${page1.body.data.pagination.nextOffset}`,
  );
  const ids = new Set(
    [...page1.body.data.items, ...page2.body.data.items].map(
      (item: { id: string }) => item.id,
    ),
  );
  check(
    page1.body.data.pagination.total === 23 &&
      page2.body.data.pagination.nextOffset === null &&
      ids.size === 23 &&
      page2.body.data.items.some(
        (item: { title: string }) => item.title === '페이지 문의 0',
      ),
    'two pages hold every inquiry once, the oldest included',
  );
}

run()
  .finally(async () => {
    if (closeHttp) await closeHttp();
    await db.operatorAuditLog.deleteMany({
      where: { actorUserId: { in: userIds } },
    });
    await db.inquiryAnswer.deleteMany({
      where: { inquiry: { userId: { in: userIds } } },
    });
    await db.inquiry.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
