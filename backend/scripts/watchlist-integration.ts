/** Isolated PostgreSQL + real HTTP/guard integration for the user watchlist; no financial writes. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { AccessTokenGuard } from '../src/auth/access-token.guard';
import { AssetsService } from '../src/assets/assets.service';
import { GlobalHttpExceptionFilter } from '../src/common/global-http-exception.filter';
import { WatchlistController } from '../src/watchlist/watchlist.controller';
import {
  WATCHLIST_LIMIT,
  WatchlistService,
} from '../src/watchlist/watchlist.service';

const url = process.env.DATABASE_URL ?? '';
if (
  process.env.WATCHLIST_DB_INTEGRATION !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)
) {
  throw new Error(
    'Requires WATCHLIST_DB_INTEGRATION=1 NODE_ENV=test and a loopback DATABASE_URL.',
  );
}
const tag = randomUUID().slice(0, 8);
const pool = new Pool({ connectionString: url });
const userIds: string[] = [];
const assetIds: string[] = [];
let db = new PrismaService();
let http: INestApplication | undefined;
let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
  assertions++;
}

const config = new ConfigService({
  JWT_ACCESS_SECRET:
    'watchlist-integration-only-secret-with-32-plus-characters',
  JWT_ACCESS_TTL: '15m',
  REFRESH_TOKEN_TTL: '30d',
});
const jwt = new JwtService();
const token = (userId: string) =>
  jwt.sign(
    { sub: userId },
    { secret: config.get<string>('JWT_ACCESS_SECRET')! },
  );

/** The production controller/service/guard/filter over the given client. */
async function startHttp(client: PrismaService) {
  // tsx omits emitDecoratorMetadata; supply the constructor metadata tsc emits.
  Reflect.defineMetadata(
    'design:paramtypes',
    [WatchlistService],
    WatchlistController,
  );
  const module = await Test.createTestingModule({
    controllers: [WatchlistController],
    providers: [
      {
        provide: WatchlistService,
        useValue: new WatchlistService(client, new AssetsService(client)),
      },
    ],
  }).compile();
  const app = module.createNestApplication();
  app.useGlobalGuards(
    new AccessTokenGuard(jwt, client, new Reflector(), config),
  );
  app.useGlobalFilters(new GlobalHttpExceptionFilter());
  await app.init();
  return app;
}

const api = () => {
  const server = http!.getHttpServer();
  return {
    list: (userId: string, query = '') =>
      request(server)
        .get(`/api/v1/watchlist${query}`)
        .auth(token(userId), { type: 'bearer' }),
    assets: (userId: string, query = '') =>
      request(server)
        .get(`/api/v1/watchlist/assets${query}`)
        .auth(token(userId), { type: 'bearer' }),
    add: (userId: string, assetId: string, body: object = {}) =>
      request(server)
        .put(`/api/v1/watchlist/${encodeURIComponent(assetId)}`)
        .auth(token(userId), { type: 'bearer' })
        .send(body),
    remove: (userId: string, assetId: string) =>
      request(server)
        .delete(`/api/v1/watchlist/${encodeURIComponent(assetId)}`)
        .auth(token(userId), { type: 'bearer' }),
    anonymous: () => request(server).get('/api/v1/watchlist'),
  };
};

/** The migration SQL itself, in a throwaway schema (rolled back). */
async function migrationShape() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schema = `watchlist_migration_${tag}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query('CREATE TABLE users (id TEXT PRIMARY KEY)');
    await client.query('CREATE TABLE assets (id TEXT PRIMARY KEY)');
    await client.query(
      readFileSync(
        'prisma/migrations/20261013120000_add_user_watchlist/migration.sql',
        'utf8',
      ),
    );
    await client.query("INSERT INTO users VALUES ('u1'), ('u2')");
    await client.query("INSERT INTO assets VALUES ('a1')");
    await client.query(
      "INSERT INTO watchlist_items (user_id, asset_id) VALUES ('u1', 'a1'), ('u2', 'a1')",
    );
    const rejects = async (sql: string) => {
      await client.query('SAVEPOINT probe');
      await assert.rejects(client.query(sql));
      await client.query('ROLLBACK TO SAVEPOINT probe');
    };
    await rejects(
      "INSERT INTO watchlist_items (user_id, asset_id) VALUES ('u1', 'a1')",
    );
    await rejects(
      "INSERT INTO watchlist_items (user_id, asset_id) VALUES ('u1', 'missing')",
    );
    await rejects("DELETE FROM assets WHERE id = 'a1'");
    await rejects("DELETE FROM users WHERE id = 'u1'");
    check(
      true,
      'migration: one row per (user, asset), referential integrity, restrict deletes',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function createUser(index: number, status: 'active' | 'suspended') {
  const user = await db.user.create({
    data: {
      email: `${tag}-${index}@example.invalid`,
      nickname: `watch-${tag}-${index}`,
      passwordHash: 'test-only',
      status,
    },
  });
  userIds.push(user.id);
  return user.id;
}

async function createAsset(
  key: string,
  patch: {
    market?: string;
    assetType?: 'domestic_stock' | 'us_stock' | 'crypto';
    symbol?: string;
    isActive?: boolean;
  } = {},
) {
  const crypto = patch.assetType === 'crypto';
  const asset = await db.asset.create({
    data: {
      symbol: patch.symbol ?? `W${tag}${key}`.toUpperCase(),
      name: `Watchlist fixture ${key}`,
      market: patch.market ?? 'KRX',
      assetType: patch.assetType ?? 'domestic_stock',
      currencyCode: crypto ? 'USD' : 'KRW',
      priceCurrency: crypto ? 'USD' : 'KRW',
      settlementCurrency: crypto ? 'USD' : 'KRW',
      isActive: patch.isActive ?? true,
    },
  });
  assetIds.push(asset.id);
  return asset.id;
}

async function financialState() {
  const counts = await Promise.all([
    db.tradingAccount.count(),
    db.cashWallet.count(),
    db.walletTransaction.count(),
    db.order.count(),
    db.position.count(),
    db.seasonParticipant.count(),
  ]);
  return counts.join(':');
}

const rowCount = (userId: string) =>
  db.watchlistItem.count({ where: { userId } });

/** Blocks until `count` sessions wait on a row lock of users.<userId>. */
async function waitForLockWaiters(count: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await pool.query<{ waiting: string }>(
      `SELECT count(*)::text AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query LIKE '%FOR NO KEY UPDATE%'`,
    );
    if (Number(rows[0].waiting) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`expected ${count} sessions waiting on the user lock`);
}

async function run() {
  await migrationShape();
  const [alice, bob, suspended] = [
    await createUser(0, 'active'),
    await createUser(1, 'active'),
    await createUser(2, 'suspended'),
  ];
  const baseline = await financialState();
  http = await startHttp(db);

  // Authentication: the token, never request input, names the owner.
  let r = await api().anonymous();
  check(r.status === 401, 'no token is rejected by the guard');
  r = await api().list(suspended);
  check(
    r.status === 403 && r.body.error.code === 'USER_NOT_ACTIVE',
    'an inactive user cannot read a watchlist',
  );

  const samsung = await createAsset('ss');
  const apple = await createAsset('aapl', {
    market: 'NASDAQ',
    assetType: 'us_stock',
  });
  r = await api().list(alice);
  check(
    r.status === 200 &&
      r.body.success === true &&
      r.body.data.items.length === 0 &&
      r.body.data.limit === WATCHLIST_LIMIT,
    'an empty list is an explicit empty success',
  );

  // First add, then idempotent re-add keeping the original time and order.
  r = await api().add(alice, samsung, { userId: bob });
  check(
    r.status === 200 && r.body.data.created === true,
    'first add creates the item',
  );
  const first = r.body.data.item;
  check(
    first.assetId === samsung &&
      first.symbol === `W${tag}SS`.toUpperCase() &&
      first.market === 'KRX' &&
      first.assetType === 'domestic_stock' &&
      first.isActive === true &&
      typeof first.addedAt === 'string',
    'item carries id, name/symbol, market, type, active state and addedAt',
  );
  check(
    (await rowCount(alice)) === 1 && (await rowCount(bob)) === 0,
    'a body userId is ignored; the token owns the row',
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  r = await api().add(alice, apple);
  check(r.body.data.created === true, 'second asset added');
  r = await api().add(alice, samsung);
  check(
    r.status === 200 &&
      r.body.data.created === false &&
      r.body.data.item.addedAt === first.addedAt,
    're-adding succeeds without a new timestamp',
  );
  check((await rowCount(alice)) === 2, 're-adding stores no duplicate');
  r = await api().list(alice, `?userId=${bob}`);
  check(
    r.body.data.items
      .map((item: { assetId: string }) => item.assetId)
      .join() === [apple, samsung].join(),
    'newest first; re-add did not move the item; a query userId is ignored',
  );

  // Concurrent duplicate taps of one asset converge on one row.
  const kakao = await createAsset('kakao');
  const burst = await Promise.all(
    [1, 2, 3, 4, 5].map(() => api().add(alice, kakao)),
  );
  check(
    burst.every((response) => response.status === 200) &&
      burst.filter((response) => response.body.data.created).length === 1 &&
      new Set(burst.map((response) => response.body.data.item.addedAt)).size ===
        1,
    'five concurrent adds of one asset: all succeed, exactly one creates',
  );
  check((await rowCount(alice)) === 3, 'one row after the burst');

  // Remove and repeated remove are both success.
  r = await api().remove(alice, kakao);
  check(
    r.status === 200 && r.body.data.removed === true,
    'remove deletes the item',
  );
  r = await api().remove(alice, kakao);
  check(
    r.status === 200 && r.body.data.removed === false,
    'removing an absent item is success',
  );
  r = await api().remove(alice, randomUUID());
  check(
    r.status === 200 && r.body.data.removed === false,
    'removing an unknown asset id is success',
  );

  // Validation and the existing error envelope; no DB text is exposed.
  r = await api().add(alice, randomUUID());
  check(
    r.status === 404 &&
      r.body.success === false &&
      r.body.error.code === 'ASSET_NOT_FOUND' &&
      r.body.error.message === 'Asset not found.',
    'an unknown asset cannot be added',
  );
  r = await api().add(alice, 'not an id');
  check(
    r.status === 400 &&
      r.body.error.code === 'INVALID_ASSET_ID' &&
      r.body.error.message === 'Invalid asset id.',
    'a malformed asset id is a validation error',
  );
  r = await api().assets(alice, '?assetType=futures');
  check(
    r.status === 400 && r.body.error.code === 'INVALID_ASSET_TYPE',
    'an unknown assetType is a validation error',
  );
  r = await api().assets(alice, '?assetType=crypto&assetType=us_stock');
  check(
    r.status === 400 && r.body.error.code === 'INVALID_ASSET_TYPE',
    'a repeated query field is rejected by the scalar pipe',
  );
  const inactive = await createAsset('off', { isActive: false });
  r = await api().add(alice, inactive);
  check(
    r.status === 409 &&
      r.body.error.code === 'ASSET_NOT_TRADABLE' &&
      r.body.error.message === 'Asset is not active.',
    'an inactive asset cannot be newly added',
  );
  const existingFuturesOnly = await db.asset.findUnique({
    where: { market_symbol: { market: 'BINANCE', symbol: 'HYPEUSDT' } },
  });
  const futuresOnly =
    existingFuturesOnly?.id ??
    (await createAsset('hype', {
      market: 'BINANCE',
      assetType: 'crypto',
      symbol: 'HYPEUSDT',
    }));
  r = await api().add(alice, futuresOnly);
  check(
    r.status === 400 &&
      r.body.error.code === 'ASSET_NOT_TRADABLE' &&
      r.body.error.message === 'Asset is not a Spot product.',
    'a Futures-only asset cannot be added',
  );
  check((await rowCount(alice)) === 2, 'rejected adds write nothing');
  check(
    !JSON.stringify(r.body).match(/prisma|SELECT|stack/iu),
    'error bodies carry no database text or stack',
  );

  // An item whose asset is deactivated later stays listed and removable.
  await db.asset.update({ where: { id: apple }, data: { isActive: false } });
  r = await api().list(alice);
  check(
    r.body.data.items.find(
      (item: { assetId: string }) => item.assetId === apple,
    )?.isActive === false,
    'a deactivated item stays listed with isActive=false',
  );
  r = await api().add(alice, apple);
  check(
    r.status === 200 && r.body.data.created === false,
    're-adding a deactivated existing item is still success',
  );
  r = await api().assets(alice, '?assetType=us_stock');
  check(
    r.status === 200 &&
      r.body.data.assets.length === 1 &&
      r.body.data.assets[0].id === apple &&
      r.body.data.assets[0].tradable === false &&
      r.body.data.assets[0].tradeBlockedReason === 'ASSET_INACTIVE',
    'the market view shows the deactivated item as not tradable',
  );
  r = await api().remove(alice, apple);
  check(r.body.data.removed === true, 'a deactivated item can be removed');

  // User isolation: B's reads and writes never see or change A's list.
  r = await api().list(bob);
  check(r.body.data.items.length === 0, "another user sees none of A's items");
  r = await api().remove(bob, samsung);
  check(
    r.body.data.removed === false && (await rowCount(alice)) === 1,
    "B removing A's asset changes nothing for A",
  );
  r = await api().add(bob, samsung);
  check(
    r.body.data.created === true && (await rowCount(alice)) === 1,
    "B adding the same asset creates B's own row only",
  );
  await api().remove(bob, samsung);
  check(
    (await rowCount(alice)) === 1 && (await rowCount(bob)) === 0,
    "B's remove leaves A's identical item intact",
  );

  // Market view: only that market's Spot items, in watchlist order, priced
  // by the market-list policy (no snapshot -> no price, never a made-up one).
  const btc = await createAsset('btc', {
    market: 'BINANCE',
    assetType: 'crypto',
  });
  const eth = await createAsset('eth', {
    market: 'BINANCE',
    assetType: 'crypto',
  });
  const now = new Date();
  const snapshot = await db.assetPriceSnapshot.create({
    data: {
      assetId: btc,
      price: '100',
      currencyCode: 'USD',
      sourceType: 'provider_api',
      sourceName: 'binance_spot_ws_ticker',
      effectiveAt: now,
      capturedAt: now,
    },
  });
  await api().add(alice, eth);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await api().add(alice, btc);
  // A Spot asset reclassified as Futures-only after it was added.
  await db.watchlistItem.create({
    data: { userId: alice, assetId: futuresOnly },
  });
  r = await api().assets(alice, '?assetType=crypto');
  const crypto = r.body.data.assets as Array<{
    id: string;
    price: { state: string; currentPrice?: string | null };
  }>;
  check(
    r.status === 200 &&
      crypto.map((asset) => asset.id).join() === [btc, eth].join(),
    'crypto view: Spot items only, newest first',
  );
  check(
    crypto[0].price.state === 'available' &&
      Number(crypto[0].price.currentPrice) === 100,
    'a watched asset with a fresh snapshot is priced by the list policy',
  );
  check(
    crypto[1].price.state === 'unavailable' && !crypto[1].price.currentPrice,
    'a watched asset without a snapshot has no price',
  );
  check(
    r.body.data.priceErrors.some(
      (error: { assetId: string }) => error.assetId === eth,
    ),
    'the missing price is reported like the market list does',
  );
  r = await api().list(alice);
  check(
    r.body.data.items.some(
      (item: { assetId: string }) => item.assetId === futuresOnly,
    ),
    'the membership list keeps a reclassified item so it stays removable',
  );
  await db.watchlistItem.delete({
    where: { userId_assetId: { userId: alice, assetId: futuresOnly } },
  });
  await db.assetPriceSnapshot.delete({ where: { id: snapshot.id } });

  // Stable order for items stored in the same millisecond.
  const tieAt = new Date('2026-01-01T00:00:00.000Z');
  const tied = [await createAsset('tie1'), await createAsset('tie2')];
  await db.watchlistItem.createMany({
    data: tied.map((assetId) => ({ userId: bob, assetId, createdAt: tieAt })),
  });
  const expectedTie = [...tied].sort().reverse().join();
  for (let read = 0; read < 3; read++) {
    r = await api().list(bob);
    check(
      r.body.data.items
        .map((item: { assetId: string }) => item.assetId)
        .join() === expectedTie,
      `same-time items keep the asset-id order (read ${read + 1})`,
    );
  }
  await db.watchlistItem.deleteMany({ where: { userId: bob } });

  // The cap: 50 accepted, the 51st rejected, inactive items counted.
  const many = await Promise.all(
    Array.from({ length: WATCHLIST_LIMIT + 1 }, (_, index) =>
      createAsset(`cap${index}`),
    ),
  );
  for (const assetId of many.slice(0, WATCHLIST_LIMIT - 1)) {
    const added = await api().add(bob, assetId);
    assert.equal(added.status, 200);
  }
  await db.asset.update({
    where: { id: many[0] },
    data: { isActive: false },
  });
  r = await api().add(bob, many[WATCHLIST_LIMIT - 1]);
  check(
    r.status === 200 && (await rowCount(bob)) === WATCHLIST_LIMIT,
    'the 50th item is accepted (one of them inactive)',
  );
  r = await api().add(bob, many[WATCHLIST_LIMIT]);
  check(
    r.status === 409 &&
      r.body.error.code === 'WATCHLIST_LIMIT_EXCEEDED' &&
      r.body.error.message === 'The watchlist is full.',
    'the 51st item is rejected',
  );
  r = await api().add(bob, many[0]);
  check(
    r.status === 200 && r.body.data.created === false,
    'at the cap, re-adding an existing (inactive) item is success',
  );
  check((await rowCount(bob)) === WATCHLIST_LIMIT, 'still exactly 50');

  // 49 + two different adds racing through the lock: exactly one wins.
  const raceAssets = [await createAsset('raceA'), await createAsset('raceB')];
  const free = await Promise.all(
    [0, 1, 2, 3, 4].map((index) => createAsset(`free${index}`)),
  );
  // Back to the first 49 cap assets: drop the 50th and any race winner.
  const resetTo49 = async () => {
    await db.watchlistItem.deleteMany({
      where: {
        userId: bob,
        assetId: { in: [many[WATCHLIST_LIMIT - 1], ...raceAssets, ...free] },
      },
    });
    assert.equal(await rowCount(bob), WATCHLIST_LIMIT - 1);
  };
  for (let round = 1; round <= 3; round++) {
    await resetTo49();
    const barrier = await pool.connect();
    let race: request.Response[];
    try {
      await barrier.query('BEGIN');
      await barrier.query(
        'SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE',
        [bob],
      );
      const pending = Promise.all(
        raceAssets.map((assetId) => api().add(bob, assetId)),
      );
      // Both requests are inside their transactions, queued on the same row.
      await waitForLockWaiters(2);
      await barrier.query('COMMIT');
      race = await pending;
    } finally {
      barrier.release();
    }
    check(
      race
        .map((response) => response.status)
        .sort()
        .join() === '200,409' &&
        race.some(
          (response) =>
            response.body.error?.code === 'WATCHLIST_LIMIT_EXCEEDED',
        ),
      `round ${round}: one add wins, the other sees the cap`,
    );
    check(
      (await rowCount(bob)) === WATCHLIST_LIMIT,
      `round ${round}: exactly 50 stored`,
    );
  }
  // Unsynchronized burst of five different adds at 49.
  await resetTo49();
  const burstAtCap = await Promise.all(
    free.map((assetId) => api().add(bob, assetId)),
  );
  check(
    burstAtCap.filter((response) => response.status === 200).length === 1 &&
      burstAtCap.filter((response) => response.status === 409).length === 4 &&
      (await rowCount(bob)) === WATCHLIST_LIMIT,
    'five concurrent different adds at 49: one stored, total 50',
  );

  // Restart: a new client and HTTP app read the same committed list.
  const beforeRestart = (await api().list(alice)).body.data.items;
  await http.close();
  await db.$disconnect();
  db = new PrismaService();
  http = await startHttp(db);
  r = await api().list(alice);
  check(
    JSON.stringify(r.body.data.items) === JSON.stringify(beforeRestart) &&
      beforeRestart.length === 3,
    'items, order and addedAt survive a server restart',
  );

  check(
    (await financialState()) === baseline,
    'watchlist changes never touch financial rows',
  );
  console.log(`watchlist PostgreSQL + HTTP ok (${assertions} assertions)`);
}

run()
  .finally(async () => {
    if (http) await http.close();
    await db.watchlistItem.deleteMany({ where: { userId: { in: userIds } } });
    await db.assetPriceSnapshot.deleteMany({
      where: { assetId: { in: assetIds } },
    });
    await db.asset.deleteMany({ where: { id: { in: assetIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
    await pool.end();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
