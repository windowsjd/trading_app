/** Isolated PostgreSQL + real HTTP/guard integration for support inquiries; no financial writes. */
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
import { InquiriesController } from '../src/inquiries/inquiries.controller';
import {
  InquiriesService,
  INQUIRY_RATE_LIMIT,
} from '../src/inquiries/inquiries.service';

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

/** The migration SQL itself, in a throwaway schema (rolled back). */
async function migrationShape() {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schema = `inquiries_migration_${tag}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query('CREATE TABLE users (id TEXT PRIMARY KEY)');
    await client.query(
      readFileSync(
        'prisma/migrations/20261012120000_add_user_inquiries/migration.sql',
        'utf8',
      ),
    );
    await client.query("INSERT INTO users VALUES ('u1')");
    await client.query(
      "INSERT INTO inquiries (id, user_id, client_request_id, category, title, content) VALUES ('i1', 'u1', 'k1', 'bug', 'title', 'content body')",
    );
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
  for (const [index, status] of (
    ['active', 'active', 'suspended'] as const
  ).entries()) {
    const user = await db.user.create({
      data: {
        email: `${tag}-${index}@example.invalid`,
        nickname: `inquiry-${tag}-${index}`,
        passwordHash: 'test-only',
        status,
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
  const app = await Test.createTestingModule({
    controllers: [InquiriesController],
    providers: [
      { provide: InquiriesService, useValue: new InquiriesService(db) },
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

  check(
    (await financialState()) === baseline,
    'inquiries never change financial rows',
  );
  console.log(`inquiries PostgreSQL + HTTP ok (${assertions} assertions)`);
}

run()
  .finally(async () => {
    if (closeHttp) await closeHttp();
    await db.inquiry.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
