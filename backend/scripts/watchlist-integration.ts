/** Real, disposable PostgreSQL + HTTP authentication. Never reads env files. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { Server } from 'node:http';

type Item = {
  assetId: string;
  name: string;
  isActive: boolean;
  createdAt: string;
};
type Reply = {
  success: boolean;
  error: { code: string };
  data: { items: Item[]; item: Item };
};
const body = (response: request.Response): Reply => response.body as Reply;
import { PrismaService } from '../src/prisma/prisma.service';
import { AccessTokenGuard } from '../src/auth/access-token.guard';
import { GlobalHttpExceptionFilter } from '../src/common/global-http-exception.filter';
import { WatchlistController } from '../src/watchlist/watchlist.controller';
import { WatchlistService } from '../src/watchlist/watchlist.service';

const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  process.env.WATCHLIST_DB_INTEGRATION !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/watchlist_test' ||
  target.username !== 'watchlist_test'
) {
  throw new Error(
    'Requires WATCHLIST_DB_INTEGRATION=1 NODE_ENV=test and loopback watchlist_test user/database.',
  );
}
const db = new PrismaService();
const secondDb = new PrismaService();
const tag = randomUUID();
const users: string[] = [];
const assets: string[] = [];
const apps: Array<{ close: () => Promise<void> }> = [];
let checks = 0;
const check = (condition: boolean, label: string) => {
  assert.equal(condition, true, label);
  checks++;
};
const secret = 'watchlist-isolated-integration-only-secret';
const jwt = new JwtService();
const config = new ConfigService({ JWT_ACCESS_SECRET: secret });

async function server(
  prisma: PrismaService,
  service = new WatchlistService(prisma),
): Promise<Server> {
  Reflect.defineMetadata(
    'design:paramtypes',
    [WatchlistService],
    WatchlistController,
  );
  const module = await Test.createTestingModule({
    controllers: [WatchlistController],
    providers: [{ provide: WatchlistService, useValue: service }],
  }).compile();
  const app = module.createNestApplication();
  app.useGlobalGuards(
    new AccessTokenGuard(jwt, prisma, new Reflector(), config),
  );
  app.useGlobalFilters(new GlobalHttpExceptionFilter());
  app.useLogger(false);
  await app.init();
  apps.push(app);
  return app.getHttpServer() as Server;
}

async function financeCounts() {
  return (
    await Promise.all([
      db.tradingAccount.count(),
      db.cashWallet.count(),
      db.walletTransaction.count(),
      db.order.count(),
      db.position.count(),
      db.seasonRanking.count(),
    ])
  ).join(':');
}

async function run() {
  for (const [index, status] of (
    ['active', 'active', 'suspended'] as const
  ).entries()) {
    users.push(
      (
        await db.user.create({
          data: {
            email: `watchlist-${tag}-${index}@example.invalid`,
            nickname: `wl-${tag}-${index}`,
            passwordHash: 'test-only',
            status,
          },
        })
      ).id,
    );
  }
  for (let index = 0; index < 54; index++) {
    const assetType =
      index % 3 === 0
        ? 'domestic_stock'
        : index % 3 === 1
          ? 'us_stock'
          : 'crypto';
    assets.push(
      (
        await db.asset.create({
          data: {
            symbol: `WL_${tag}_${index}`,
            name: `관심종목 테스트 ${index}`,
            market:
              assetType === 'domestic_stock'
                ? 'KRX'
                : assetType === 'us_stock'
                  ? 'NASDAQ'
                  : 'BINANCE',
            assetType,
            currencyCode: assetType === 'domestic_stock' ? 'KRW' : 'USD',
          },
        })
      ).id,
    );
  }
  const inactive = (
    await db.asset.create({
      data: {
        symbol: `INACTIVE_${tag}`,
        name: 'inactive',
        market: 'KRX',
        assetType: 'domestic_stock',
        currencyCode: 'KRW',
        isActive: false,
      },
    })
  ).id;
  const futures = (
    await db.asset.create({
      data: {
        symbol: 'HYPEUSDT',
        name: 'Futures only',
        market: 'BINANCE',
        assetType: 'crypto',
        currencyCode: 'USD',
      },
    })
  ).id;
  assets.push(inactive, futures);
  const before = await financeCounts();
  const http = await server(db);
  const otherHttp = await server(secondDb);
  const token = (index = 0) => jwt.sign({ sub: users[index] }, { secret });
  const api = (
    method: 'get' | 'put' | 'delete',
    asset = '',
    index = 0,
    host = http,
  ) =>
    request(host)
      [method](`/api/v1/watchlist${asset ? `/${asset}` : ''}`)
      .auth(token(index), { type: 'bearer' });
  const count = (index = 0) =>
    db.watchlistEntry.count({ where: { userId: users[index] } });

  for (const method of ['get', 'put', 'delete'] as const) {
    const path =
      method === 'get' ? '/api/v1/watchlist' : `/api/v1/watchlist/${assets[0]}`;
    check(
      (await request(http)[method](path)).status === 401,
      `${method} requires authentication`,
    );
    check(
      (await request(http)[method](path).auth('invalid', { type: 'bearer' }))
        .status === 401,
      `${method} rejects invalid token`,
    );
    check(
      (await api(method, method === 'get' ? '' : assets[0], 2)).status === 403,
      `${method} rejects suspended user`,
    );
  }
  check(body(await api('get')).data.items.length === 0, 'initial empty list');
  let response = await api('put', assets[0]).send({
    userId: users[1],
    accountId: 'fake',
  });
  check(
    response.status === 200 && body(response).success === true,
    'first registration succeeds',
  );
  const createdAt: string = body(response).data.item.createdAt;
  check(
    body(response).data.item.name === '관심종목 테스트 0' &&
      body(response).data.item.assetId === assets[0],
    'metadata comes from Asset',
  );
  response = await api('put', assets[0]);
  check(
    response.status === 200 &&
      body(response).data.item.createdAt === createdAt &&
      (await count()) === 1,
    'replay preserves count and timestamp',
  );
  check((await count(1)) === 0, 'body user ID cannot redirect ownership');
  check(
    body(await api('get', '', 1)).data.items.length === 0,
    'other user cannot read first user data',
  );
  check(
    body(await api('get').query({ userId: users[1] })).data.items.length === 1,
    'query user ID cannot select another owner',
  );
  check(
    (await api('delete', assets[0], 1)).status === 200 && (await count()) === 1,
    'other user removal is harmless',
  );
  check(
    (await api('put', assets[0], 1)).status === 200 &&
      (await count()) === 1 &&
      (await count(1)) === 1,
    'same asset has isolated ownership',
  );
  check(
    (await api('delete', assets[0])).status === 200 &&
      (await count()) === 0 &&
      (await count(1)) === 1,
    'remove only the caller record',
  );
  check(
    (await api('delete', assets[0])).status === 200,
    'duplicate removal succeeds',
  );
  check(
    (await api('delete', randomUUID())).status === 200,
    'absent unknown asset removal succeeds',
  );
  for (const [id, status, code] of [
    [randomUUID(), 404, 'ASSET_NOT_FOUND'],
    [inactive, 409, 'ASSET_INACTIVE'],
    [futures, 400, 'WATCHLIST_SPOT_ONLY'],
    ['bad%20id', 400, 'INVALID_ASSET_ID'],
  ] as const) {
    response = await api('put', id);
    check(
      response.status === status && body(response).error.code === code,
      `rejects ${code}`,
    );
  }
  check((await count()) === 0, 'rejections leave no rows');
  for (let index = 0; index < 49; index++)
    check(
      (await api('put', assets[index])).status === 200,
      `registration ${index + 1} allowed`,
    );
  await db.asset.update({
    where: { id: assets[0] },
    data: { isActive: false, name: '비활성 이름 변경' },
  });
  response = await api('get');
  const historical = body(response).data.items.find(
    (item: { assetId: string }) => item.assetId === assets[0],
  );
  check(
    historical?.isActive === false && historical?.name === '비활성 이름 변경',
    'inactive record retained and metadata stays current',
  );
  response = await api('put', assets[0]);
  check(response.status === 200, 'inactive existing item replay succeeds');
  // Distinct HTTP applications + Prisma pools stand in for two server instances.
  for (let attempt = 0; attempt < 10; attempt++) {
    const race = await Promise.all([
      api('put', assets[49]),
      api('put', assets[50], 0, otherHttp),
    ]);
    const statuses = race.map((r) => r.status).sort();
    check(
      statuses.join(',') === '200,409' && (await count()) === 50,
      `49 + two registrations: attempt ${attempt + 1}`,
    );
    const winner = race[0].status === 200 ? assets[49] : assets[50];
    check(
      (await api('put', winner)).status === 200,
      'full list replay succeeds',
    );
    response = await api('put', assets[51]);
    check(
      response.status === 409 &&
        body(response).error.code === 'WATCHLIST_LIMIT_REACHED',
      '51st item rejected, inactive included',
    );
    check(
      (await api('delete', winner)).status === 200 && (await count()) === 49,
      'capacity restored on removal',
    );
  }
  const duplicates = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      api('put', assets[49], 0, index % 2 ? http : otherHttp),
    ),
  );
  check(
    duplicates.every((r) => r.status === 200) && (await count()) === 50,
    'concurrent duplicate registrations create one row',
  );
  check(
    new Set(duplicates.map((r) => body(r).data.item.createdAt)).size === 1,
    'concurrent replay timestamps stay identical',
  );

  const sameTime = new Date('2026-10-13T00:00:00Z');
  await db.watchlistEntry.updateMany({
    where: { userId: users[0] },
    data: { createdAt: sameTime },
  });
  const sorted = body(await api('get')).data.items.map(
    (item: { assetId: string }) => item.assetId,
  );
  check(
    sorted.join(',') === [...sorted].sort().join(','),
    'equal timestamp uses stable asset ID ordering',
  );
  await db.watchlistEntry.update({
    where: { userId_assetId: { userId: users[0], assetId: assets[49] } },
    data: { createdAt: new Date('2026-10-13T01:00:00Z') },
  });
  check(
    body(await api('get')).data.items[0].assetId === assets[49],
    'newest registration sorts first',
  );

  await assert.rejects(
    db.watchlistEntry.create({
      data: { userId: users[0], assetId: assets[49] },
    }),
  );
  checks++;
  await assert.rejects(
    db.watchlistEntry.create({
      data: { userId: randomUUID(), assetId: assets[49] },
    }),
  );
  checks++;
  await assert.rejects(
    db.watchlistEntry.create({
      data: { userId: users[1], assetId: randomUUID() },
    }),
  );
  checks++;
  check(
    (await api('delete', assets[0])).status === 200,
    'inactive entry can be removed',
  );
  check(
    body(await api('put', assets[0])).error.code === 'ASSET_INACTIVE',
    'inactive removed entry cannot be re-added',
  );

  await Promise.all(apps.splice(0).map((app) => app.close()));
  await db.$disconnect();
  await secondDb.$disconnect();
  const restartedHttp = await server(db);
  const persisted = await api('get', '', 0, restartedHttp);
  check(
    persisted.status === 200 &&
      body(persisted).data.items.length === 49 &&
      body(persisted).data.items[0].assetId === assets[49],
    'HTTP server/pools restarted: stored state survives',
  );

  // The production exception filter, including an unexpected DB failure.
  const broken = new WatchlistService(db);
  broken.list = () =>
    Promise.reject(new Error('SECRET database password stack trace'));
  const failedHttp = await server(db, broken);
  response = await api('get', '', 0, failedHttp);
  check(
    response.status === 500 &&
      body(response).error.code === 'INTERNAL_SERVER_ERROR',
    'unexpected DB error uses public envelope',
  );
  check(
    !JSON.stringify(body(response)).includes('SECRET') &&
      !JSON.stringify(body(response)).includes('stack trace'),
    'DB error internals never reach caller',
  );
  check(
    (await financeCounts()) === before,
    'watchlist leaves all financial counts unchanged',
  );
  console.log(
    `watchlist PostgreSQL + HTTP PASS (${checks} assertions; 10 two-instance 49+2 races)`,
  );
}

run()
  .finally(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await db.watchlistEntry.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.asset.deleteMany({ where: { id: { in: assets } } });
    await Promise.all([db.$disconnect(), secondDb.$disconnect()]);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
