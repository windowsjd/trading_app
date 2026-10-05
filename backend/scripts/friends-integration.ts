/** Isolated PostgreSQL + real HTTP/guard integration; no provider or financial writes. */
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
import { FriendsService } from '../src/friends/friends.service';
import { FriendsController } from '../src/friends/friends.controller';
import { RankingService } from '../src/ranking/ranking.service';
import { RankingController } from '../src/ranking/ranking.controller';
import { RecordsService } from '../src/records/records.service';
import { RecordsController } from '../src/records/records.controller';
import { AuthService } from '../src/auth/auth.service';
import { AuthController } from '../src/auth/auth.controller';
import { AccessTokenGuard } from '../src/auth/access-token.guard';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';

if (
  process.env.FRIENDS_DB_INTEGRATION !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !process.env.DATABASE_URL
) {
  throw new Error(
    'Requires FRIENDS_DB_INTEGRATION=1 NODE_ENV=test and an isolated DATABASE_URL.',
  );
}
const db = new PrismaService();
const tag = randomUUID().slice(0, 8);
const userIds: string[] = [];
const accountIds: string[] = [];
let seasonId: string | undefined;
let assetId: string | undefined;
let app: import('@nestjs/testing').TestingModule | undefined;
let closeHttp: (() => Promise<void>) | undefined;
const now = new Date();
const day = new Date(now.toISOString().slice(0, 10));
let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
  assertions++;
}
async function migrationDefaults() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schema = `friends_migration_${tag}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query('CREATE TABLE users (id TEXT PRIMARY KEY)');
    await client.query("INSERT INTO users VALUES ('legacy')");
    await client.query(
      readFileSync(
        'prisma/migrations/20260929120000_friends_portfolio_privacy/migration.sql',
        'utf8',
      ),
    );
    await client.query("INSERT INTO users (id) VALUES ('new')");
    const result = await client.query('SELECT portfolio_public FROM users');
    check(
      result.rows.length === 2 &&
        result.rows.every((row) => row.portfolio_public === true),
      'existing AND new migration defaults true',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}
async function financialState() {
  return JSON.stringify(
    await Promise.all([
      db.cashWallet.findMany({
        where: { tradingAccountId: { in: accountIds } },
        orderBy: { id: 'asc' },
      }),
      db.position.findMany({
        where: { tradingAccountId: { in: accountIds } },
        orderBy: { id: 'asc' },
      }),
      db.dailyPortfolioSnapshot.findMany({
        where: { tradingAccountId: { in: accountIds } },
        orderBy: { id: 'asc' },
      }),
      db.seasonRanking.findMany({
        where: { seasonId },
        orderBy: { id: 'asc' },
      }),
      db.order.count({ where: { tradingAccountId: { in: accountIds } } }),
      db.walletTransaction.count({
        where: { tradingAccountId: { in: accountIds } },
      }),
      db.exchangeTransaction.count({
        where: { tradingAccountId: { in: accountIds } },
      }),
    ]),
  );
}
async function run() {
  await migrationDefaults();
  for (let i = 0; i < 42; i++) {
    const user = await db.user.create({
      data: {
        email: `${tag}-${i}@example.invalid`,
        nickname: `friends-${tag}-${String(i).padStart(2, '0')}`,
        passwordHash: 'test-only',
      },
    });
    userIds.push(user.id);
    check(user.portfolioPublic === true, 'new Prisma user defaults public');
  }
  const season = await db.season.create({
    data: {
      name: `friends-${tag}`,
      status: 'active',
      startAt: new Date(now.getTime() - 86400000 * 10),
      endAt: new Date(now.getTime() + 86400000 * 10),
      initialCapitalKrw: '1000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  seasonId = season.id;
  for (let i = 0; i < 40; i++) {
    const account = await db.tradingAccount.create({
      data: {
        userId: userIds[i],
        mode: 'season',
        initialCapitalKrw: '1000000',
        status: 'active',
        openedAt: season.startAt,
      },
    });
    accountIds.push(account.id);
    const participant = await db.seasonParticipant.create({
      data: {
        userId: userIds[i],
        seasonId,
        tradingAccountId: account.id,
        participantStatus: i === 38 ? 'excluded' : 'active',
        rankingHiddenAt: i === 37 ? now : null,
        initialCapitalKrw: '1000000',
        joinedAt: season.startAt,
        totalAssetKrw: '1000000',
        totalReturnRate: '0',
        maxDrawdown: '0',
        finalTier: 'gold',
      },
    });
    await db.cashWallet.createMany({
      data: [
        {
          tradingAccountId: account.id,
          currencyCode: 'KRW',
          balanceAmount: '1000000',
        },
        {
          tradingAccountId: account.id,
          currencyCode: 'USD',
          balanceAmount: '0',
        },
      ],
    });
    for (const rankType of ['daily', 'final'] as const)
      await db.seasonRanking.create({
        data: {
          seasonId,
          tradingAccountId: account.id,
          seasonParticipantId: participant.id,
          rankType,
          rank: i + 1,
          rankingDate: day,
          capturedAt: now,
          totalAssetKrw: '1000000',
          returnRate: '0',
        },
      });
  }
  await db.dailyPortfolioSnapshot.create({
    data: {
      tradingAccountId: accountIds[7],
      snapshotDate: day,
      capturedAt: now,
      totalAssetKrw: '1000000',
      returnRate: '0',
      krwCash: '1000000',
      usdCashKrw: '0',
      assetValueKrw: '0',
      realizedPnlKrw: '0',
      unrealizedPnlKrw: '0',
    },
  });
  const asset = await db.asset.create({
    data: {
      symbol: `FRIEND${tag}`,
      name: 'Unavailable fixture holding',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
  });
  assetId = asset.id;
  await db.position.create({
    data: {
      tradingAccountId: accountIds[36],
      assetId,
      quantity: '1',
      averageCost: '10',
      currencyCode: 'USD',
    },
  });
  const baseline = await financialState();
  const jwt = new JwtService();
  const config = new ConfigService({
    JWT_ACCESS_SECRET:
      'friends-integration-only-secret-with-at-least-32-characters',
    JWT_ACCESS_TTL: '15m',
    REFRESH_TOKEN_TTL: '30d',
  });
  const friends = new FriendsService(db);
  const records = new RecordsService(db, new PortfolioValuationService(db));
  const ranking = new RankingService(db);
  const auth = new AuthService(db, jwt, config);
  // tsx omits emitDecoratorMetadata; supply the same constructor metadata tsc emits.
  for (const [controller, service] of [
    [FriendsController, FriendsService],
    [RecordsController, RecordsService],
    [RankingController, RankingService],
    [AuthController, AuthService],
  ])
    Reflect.defineMetadata('design:paramtypes', [service], controller);
  app = await Test.createTestingModule({
    controllers: [
      FriendsController,
      RecordsController,
      RankingController,
      AuthController,
    ],
    providers: [
      { provide: FriendsService, useValue: friends },
      { provide: RecordsService, useValue: records },
      { provide: RankingService, useValue: ranking },
      { provide: AuthService, useValue: auth },
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
  const get = (url: string, index = 0) =>
      request(server)
        .get(`/api/v1${url}`)
        .auth(token(index), { type: 'bearer' }),
    post = (url: string, index = 0, body = {}) =>
      request(server)
        .post(`/api/v1${url}`)
        .auth(token(index), { type: 'bearer' })
        .send(body),
    patch = (url: string, body: object, index = 0) =>
      request(server)
        .patch(`/api/v1${url}`)
        .auth(token(index), { type: 'bearer' })
        .send(body),
    del = (url: string, index = 0) =>
      request(server)
        .delete(`/api/v1${url}`)
        .auth(token(index), { type: 'bearer' });
  const summary = () => get(`/users/${userIds[7]}/season-summary`);
  await request(server)
    .get(`/api/v1/users/${userIds[7]}/season-summary`)
    .expect(401);
  await get('/friends/search?nickname[x]=bad').expect(400);
  await get('/friends?limit=0').expect(400);
  await post('/friends/requests', 0, { userId: userIds[0] }).expect(400);
  let r = await summary();
  check(
    r.body.data.portfolioAccess === 'not_friend' &&
      r.body.data.portfolio === null,
    'public true does not allow strangers',
  );
  r = await post('/friends/requests', 0, { userId: userIds[7] }).expect(201);
  const id = r.body.data.requestId;
  await post('/friends/requests', 7, { userId: userIds[0] }).expect(409);
  await post(`/friends/requests/${id}/accept`, 0).expect(404);
  await post(`/friends/requests/${id}/reject`, 41).expect(404);
  r = await summary();
  check(r.body.data.portfolio === null, 'pending cannot read portfolio');
  r = await get('/friends/requests', 7).expect(200);
  check(
    r.body.data.users[0].requestId === id,
    'incoming request visible to recipient',
  );
  await post(`/friends/requests/${id}/accept`, 7).expect(201);
  r = await summary();
  check(r.body.data.portfolioAccess === 'available', 'accepted may read');
  check(
    r.body.data.portfolio.allocation.cashKrwValue === '1000000.00000000',
    'canonical wallet valuation',
  );
  check(
    r.body.data.portfolio.history.length === 1 &&
      r.body.data.portfolio.history[0].date === day.toISOString().slice(0, 10),
    'only persisted daily history',
  );
  for (const field of [
    'tradingAccountId',
    'email',
    'averageCost',
    'quantity',
    'walletId',
    'orderId',
    'idempotency',
    'balanceAmount',
    'requesterUserId',
  ])
    check(!JSON.stringify(r.body).includes(field), `no private field ${field}`);
  await patch('/me', { portfolioPublic: false }, 7).expect(200);
  r = await get('/me', 7);
  check(r.body.data.portfolioPublic === false, 'false persisted');
  await patch('/me', { portfolioPublic: 'false' }, 7).expect(400);
  r = await summary();
  check(
    r.body.data.portfolioAccess === 'private' &&
      r.body.data.portfolio === null &&
      r.body.data.season.rank === 8,
    'private removes payload, keeps global rank',
  );
  r = await get(`/users/${userIds[7]}/records/${seasonId}`);
  check(
    r.body.data.portfolio === null &&
      !JSON.stringify(r.body).includes('allocation'),
    'records cannot bypass privacy',
  );
  await patch(
    '/me',
    {
      portfolioPublic: true,
      nickname: `friends-${tag}-renamed`,
    },
    7,
  ).expect(200);
  const race = await Promise.all([
    post('/friends/requests', 0, { userId: userIds[36] }),
    post('/friends/requests', 36, { userId: userIds[0] }),
  ]);
  check(
    race
      .map((item) => item.status)
      .sort()
      .join() === '201,409',
    'opposite request race stores one pair',
  );
  const winner = race.findIndex((item) => item.status === 201);
  await post(
    `/friends/requests/${race[winner].body.data.requestId}/accept`,
    winner === 0 ? 36 : 0,
  ).expect(201);
  const duplicate = await Promise.all([
    post('/friends/requests', 0, { userId: userIds[40] }),
    post('/friends/requests', 0, { userId: userIds[40] }),
  ]);
  check(
    duplicate
      .map((item) => item.status)
      .sort()
      .join() === '201,409',
    'same request race stores one pair',
  );
  await post(
    `/friends/requests/${duplicate.find((item) => item.status === 201)!.body.data.requestId}/accept`,
    40,
  ).expect(201);
  for (const index of [37, 38]) {
    const sent = await post('/friends/requests', 0, { userId: userIds[index] });
    await post(
      `/friends/requests/${sent.body.data.requestId}/accept`,
      index,
    ).expect(201);
  }
  const pending = await post('/friends/requests', 0, { userId: userIds[39] });
  for (const rankType of ['daily', 'final']) {
    const global = (
      await get(`/ranking?scope=all&seasonId=${seasonId}&rankType=${rankType}`)
    ).body.data;
    const top = (
      await get(
        `/ranking?scope=top10&seasonId=${seasonId}&rankType=${rankType}`,
      )
    ).body.data;
    const filtered = (
      await get(
        `/ranking?scope=friends&seasonId=${seasonId}&rankType=${rankType}&limit=1`,
      )
    ).body.data;
    check(
      global.rankings.length === 38 && top.rankings.length === 10,
      'all/top10 and hidden/excluded preserved',
    );
    check(
      filtered.rankings[0].rank === 8 &&
        filtered.pagination.total === 2 &&
        filtered.myRanking.rank === 1,
      'friends retain global rank, exclude self/pending/unjoined/hidden',
    );
    const next = (
      await get(
        `/ranking?scope=friends&seasonId=${seasonId}&rankType=${rankType}&limit=1&offset=${filtered.pagination.nextOffset}&capturedAt=${filtered.capturedAt}`,
      )
    ).body.data;
    check(next.rankings[0].rank === 37, 'pagination preserves global rank');
    assert.deepEqual(
      filtered.rankings[0],
      global.rankings.find((row: { rank: number }) => row.rank === 8),
    );
    assertions++;
    await get(
      `/ranking?scope=friends&seasonId=${seasonId}&capturedAt=2000-01-01T00:00:00.000Z`,
    ).expect(409);
  }
  await get('/ranking?scope=near_me').expect(400);
  await post(
    `/friends/requests/${pending.body.data.requestId}/reject`,
    39,
  ).expect(201);
  r = await get(`/users/${userIds[40]}/season-summary`);
  check(
    r.body.data.state === 'not_joined' && r.body.data.portfolio === null,
    'unjoined friend empty state',
  );
  r = await get(`/users/${userIds[36]}/season-summary`);
  check(r.body.data.portfolio.history.length === 0, 'no fabricated history');
  check(
    r.body.data.portfolio.valuationState === 'unavailable' &&
      r.body.data.portfolio.allocation === null &&
      r.body.data.portfolio.holdings[0].weight === null,
    'missing valuation never fabricates allocation or weights',
  );
  r = await get(`/friends/search?nickname=friends-${tag}&limit=100`);
  check(!JSON.stringify(r.body).includes('email'), 'search no email');
  check(
    r.body.data.users.every(
      (user: { userId: string }) => user.userId !== userIds[0],
    ),
    'self excluded from search',
  );
  check(
    r.body.data.users.some(
      (user: { relationship: string }) => user.relationship === 'friend',
    ),
    'batch relationship state',
  );
  await db.user.update({
    where: { id: userIds[7] },
    data: { status: 'suspended' },
  });
  r = await summary();
  check(
    r.body.data.portfolio === null &&
      r.body.data.portfolioAccess === 'unavailable',
    'inactive target denied',
  );
  await get('/friends', 7).expect(403);
  r = await get(`/friends/search?nickname=friends-${tag}-renamed`);
  check(r.body.data.users.length === 0, 'inactive target excluded');
  await post('/friends/requests', 41, { userId: userIds[7] }).expect(404);
  r = await get(`/ranking?scope=friends&seasonId=${seasonId}`);
  check(
    r.body.data.rankings.length === 1,
    'inactive friends excluded from ranking',
  );
  await db.user.update({
    where: { id: userIds[7] },
    data: { status: 'active' },
  });
  await del(`/friends/${id}`, 41).expect(404);
  await del(`/friends/${id}`, 7).expect(200);
  r = await summary();
  check(
    r.body.data.portfolioAccess === 'not_friend' &&
      r.body.data.portfolio === null,
    'delete immediately revokes access',
  );
  await get(`/users/${randomUUID()}/season-summary`).expect(404);
  await assert.rejects(
    db.friendship.create({
      data: {
        lowUserId: userIds[0],
        highUserId: userIds[0],
        requesterUserId: userIds[0],
      },
    }),
  );
  assertions++;
  const pair = [userIds[0], userIds[41]].sort();
  await assert.rejects(
    db.friendship.create({
      data: {
        lowUserId: pair[1],
        highUserId: pair[0],
        requesterUserId: pair[0],
      },
    }),
  );
  assertions++;
  await assert.rejects(
    db.friendship.create({
      data: {
        lowUserId: pair[0],
        highUserId: pair[1],
        requesterUserId: userIds[7],
      },
    }),
  );
  assertions++;
  check(
    (await financialState()) === baseline,
    'social and portfolio read APIs never change financial rows',
  );
  await db.season.update({
    where: { id: seasonId },
    data: { status: 'settled' },
  });
  r = await get(`/users/${userIds[36]}/season-summary`);
  check(
    r.body.data.portfolio === null && r.body.data.season.rank === 37,
    'past season retains final public competition only',
  );
  console.log(
    `friends PostgreSQL + HTTP ok (${assertions} assertions plus HTTP status checks)`,
  );
}
run()
  .finally(async () => {
    if (closeHttp) await closeHttp();
    else if (app) await app.close();
    await db.friendship.deleteMany({
      where: {
        OR: [{ lowUserId: { in: userIds } }, { highUserId: { in: userIds } }],
      },
    });
    await db.seasonRanking.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await db.dailyPortfolioSnapshot.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await db.position.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    if (assetId) await db.asset.delete({ where: { id: assetId } });
    await db.cashWallet.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await db.seasonParticipant.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await db.tradingAccount.deleteMany({ where: { id: { in: accountIds } } });
    if (seasonId) await db.season.delete({ where: { id: seasonId } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
