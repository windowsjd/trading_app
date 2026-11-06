/** 거래 내역 › 선물 포지션 진입/종료 on an isolated PostgreSQL + real HTTP/guard; reads only. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { AccessTokenGuard } from '../src/auth/access-token.guard';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import type { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { FuturesController } from '../src/futures/futures.controller';
import { FuturesService } from '../src/futures/futures.service';
import { FuturesLeverageService } from '../src/futures/futures-leverage.service';
import {
  readFuturesPositionHistory,
  type FuturesHistoryPhase,
  type FuturesHistoryRecord,
} from '../src/futures/futures-position-history';

if (
  process.env.FUTURES_POSITION_HISTORY_DB_INTEGRATION !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !process.env.DATABASE_URL
) {
  throw new Error(
    'Requires FUTURES_POSITION_HISTORY_DB_INTEGRATION=1 NODE_ENV=test and an isolated DATABASE_URL.',
  );
}
const db = new PrismaService();
const tag = randomUUID().slice(0, 8).toUpperCase();
const now = new Date();
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
const seconds = (at: Date, delta: number) =>
  new Date(at.getTime() + delta * 1_000);
const userIds: string[] = [];
const accountIds: string[] = [];
const seasonIds: string[] = [];
let assetId: string | undefined;
let instrumentId: string | undefined;
let closeHttp: (() => Promise<void>) | undefined;
let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
  assertions++;
}

async function account(userId: string, mode: 'season' | 'general') {
  const row = await db.tradingAccount.create({
    data: {
      userId,
      mode,
      initialCapitalKrw: mode === 'season' ? '1000000' : '10000000',
      status: 'active',
      openedAt: hoursAgo(240),
    },
  });
  accountIds.push(row.id);
  return row.id;
}

async function endedSeason(name: string, endAt: Date) {
  const row = await db.season.create({
    data: {
      name: `${name}-${tag}`,
      status: 'ended',
      startAt: hoursAgo(240),
      endAt,
      initialCapitalKrw: '1000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  seasonIds.push(row.id);
  return row;
}

async function participant(
  userId: string,
  seasonId: string,
  tradingAccountId: string,
) {
  await db.seasonParticipant.create({
    data: {
      userId,
      seasonId,
      tradingAccountId,
      participantStatus: 'finished',
      initialCapitalKrw: '1000000',
      joinedAt: hoursAgo(240),
      totalAssetKrw: '1000000',
      totalReturnRate: '0',
      maxDrawdown: '0',
    },
  });
}

/** A Spot pin the Spot-evidence branch of the guards accepts. */
function spotEvidence(price: string, at: Date) {
  return db.assetPriceSnapshot.create({
    data: {
      assetId: assetId!,
      price,
      currencyCode: 'USD',
      sourceType: 'provider_api',
      sourceName: 'binance_spot_ws_ticker',
      effectiveAt: at,
      capturedAt: at,
    },
  });
}

async function lifetime(
  tradingAccountId: string,
  direction: 'long' | 'short',
  marginMode: 'isolated' | 'cross',
  closedAt: Date | null,
) {
  const row = await db.futuresPosition.create({
    data: {
      tradingAccountId,
      instrumentId: instrumentId!,
      direction,
      marginMode,
      status: closedAt ? 'closed' : 'open',
      quantity: closedAt ? '0' : '0.5',
      averageEntryPrice: '60000',
      entryNotional: closedAt ? '0' : '29500',
      leverage: 10,
      isolatedMargin: closedAt || marginMode === 'cross' ? '0' : '2950',
      closedAt,
    },
  });
  return row;
}

async function execution(
  position: {
    id: string;
    tradingAccountId: string;
    direction: 'long' | 'short';
    marginMode: 'isolated' | 'cross';
  },
  operation: 'open' | 'increase' | 'reduce' | 'close',
  quantity: string,
  price: string,
  at: Date,
) {
  const evidence = await spotEvidence(price, seconds(at, -1));
  const row = await db.futuresExecution.create({
    data: {
      tradingAccountId: position.tradingAccountId,
      instrumentId: instrumentId!,
      positionId: position.id,
      operation,
      direction: position.direction,
      marginMode: position.marginMode,
      quantity,
      leverage: 10,
      executionPrice: price,
      assetPriceSnapshotId: evidence.id,
      priceSourceType: 'provider_api',
      priceSourceName: 'binance_spot_ws_ticker',
      priceEffectiveAt: evidence.effectiveAt,
      priceCapturedAt: evidence.capturedAt,
      notional: (Number(price) * Number(quantity)).toFixed(8),
      feeRate: '0.0005',
      feeAmount: (Number(price) * Number(quantity) * 0.0005).toFixed(8),
      realizedPnl: '0',
      // The shape check: only a close leaves nothing.
      positionQuantityAfter: operation === 'close' ? '0' : quantity,
      averageEntryPriceAfter: '60000',
      isolatedMarginAfter: '0',
      executedAt: at,
    },
  });
  return row.id;
}

async function run() {
  for (const name of ['owner', 'stranger']) {
    const user = await db.user.create({
      data: {
        email: `${tag.toLowerCase()}-${name}@example.invalid`,
        nickname: `hist-${tag.toLowerCase()}-${name}`,
        passwordHash: 'test-only',
      },
    });
    userIds.push(user.id);
  }
  const [owner, stranger] = userIds;
  const season = await endedSeason('history', hoursAgo(1));
  const seasonAccount = await account(owner, 'season');
  await participant(owner, season.id, seasonAccount);
  // Another ended season whose final exit closed nothing.
  const quietSeason = await endedSeason('history-quiet', hoursAgo(2));
  const quietAccount = await account(owner, 'season');
  await participant(owner, quietSeason.id, quietAccount);
  const strangerAccount = await account(stranger, 'general');

  const asset = await db.asset.create({
    data: {
      symbol: `PH${tag}USDT`,
      name: 'Position history fixture',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
  });
  assetId = asset.id;
  const instrument = await db.futuresInstrument.create({
    data: {
      underlyingAssetId: asset.id,
      markContractJson: { priceTickSize: '0.10' },
    },
  });
  instrumentId = instrument.id;

  // The season account: a long that opened, added, reduced and closed; a short
  // closed by the Season exit; a long and a short closed together by one Cross
  // liquidation; and an open long reduced at the liquidation's own instant.
  const liquidatedAt = hoursAgo(3);
  const settledAt = seconds(season.endAt, 120);
  const long1 = await lifetime(seasonAccount, 'long', 'isolated', hoursAgo(7));
  const short1 = await lifetime(seasonAccount, 'short', 'isolated', settledAt);
  const long2 = await lifetime(seasonAccount, 'long', 'cross', liquidatedAt);
  const short2 = await lifetime(seasonAccount, 'short', 'cross', liquidatedAt);
  const long3 = await lifetime(seasonAccount, 'long', 'isolated', null);
  const ids = {
    long1Open: await execution(long1, 'open', '0.5', '60000', hoursAgo(10)),
    long1Increase: await execution(
      long1,
      'increase',
      '0.5',
      '62000',
      hoursAgo(9),
    ),
    long1Reduce: await execution(long1, 'reduce', '0.4', '63000', hoursAgo(8)),
    long1Close: await execution(long1, 'close', '0.6', '64000', hoursAgo(7)),
    short1Open: await execution(short1, 'open', '0.2', '61000', hoursAgo(6.5)),
    long2Open: await execution(long2, 'open', '0.3', '60500', hoursAgo(6)),
    short2Open: await execution(short2, 'open', '0.1', '60800', hoursAgo(5.5)),
    long3Open: await execution(long3, 'open', '1', '59000', hoursAgo(5)),
    long3Reduce: await execution(long3, 'reduce', '0.5', '58000', liquidatedAt),
  };
  const mark = await db.futuresMarkSnapshot.create({
    data: {
      instrumentId: instrument.id,
      symbol: asset.symbol,
      source: 'binance_usdm_mark_rest',
      price: '57000',
      effectiveAt: seconds(liquidatedAt, -1),
      capturedAt: seconds(liquidatedAt, -1),
    },
  });
  const liquidation = await db.futuresLiquidation.create({
    data: {
      tradingAccountId: seasonAccount,
      marginMode: 'cross',
      evaluationAt: liquidatedAt,
      collateralAvailable: '100',
      preEquity: '5',
      maintenanceMargin: '10',
      estimatedCloseFee: '1',
      liquidationRequirement: '11',
      realizedPnl: '-50',
      feeAmount: '1',
      settledPnl: '-50',
      settledFee: '1',
      settledCash: '-51',
      bankruptcyShortfall: '0',
      walletBalanceBefore: '100',
      walletBalanceAfter: '49',
      executedAt: liquidatedAt,
    },
  });
  for (const [position, quantity] of [
    [long2, '0.3'],
    [short2, '0.1'],
  ] as const)
    await db.futuresLiquidationClose.create({
      data: {
        liquidationId: liquidation.id,
        tradingAccountId: seasonAccount,
        positionId: position.id,
        instrumentId: instrument.id,
        markSnapshotId: mark.id,
        direction: position.direction,
        quantity,
        executionPrice: '57000',
        maintenanceMargin: '5',
        estimatedCloseFee: '0.5',
        realizedPnl: '-25',
        feeRate: '0.0005',
        feeAmount: '0.5',
      },
    });
  const finalPin = await spotEvidence('62000', seconds(season.endAt, -2));
  const price = await db.futuresSeasonPrice.create({
    data: {
      seasonId: season.id,
      instrumentId: instrument.id,
      assetPriceSnapshotId: finalPin.id,
      endAt: season.endAt,
      feeRate: '0.001',
    },
  });
  const settlement = await db.futuresSeasonSettlement.create({
    data: {
      seasonId: season.id,
      tradingAccountId: seasonAccount,
      endAt: season.endAt,
      feeRate: '0.001',
      realizedPnl: '-200',
      feeAmount: '12.4',
      settledPnl: '-200',
      settledFee: '12.4',
      settledCash: '-212.4',
      bankruptcyShortfall: '0',
      walletBalanceBefore: '1000',
      walletBalanceAfter: '787.6',
      scopesJson: [],
      executedAt: settledAt,
    },
  });
  await db.futuresSeasonClose.create({
    data: {
      settlementId: settlement.id,
      tradingAccountId: seasonAccount,
      positionId: short1.id,
      instrumentId: instrument.id,
      priceId: price.id,
      direction: 'short',
      marginMode: 'isolated',
      quantity: '0.2',
      executionPrice: '62000',
      realizedPnl: '-200',
      feeRate: '0.001',
      feeAmount: '12.4',
    },
  });
  await db.futuresSeasonSettlement.create({
    data: {
      seasonId: quietSeason.id,
      tradingAccountId: quietAccount,
      endAt: quietSeason.endAt,
      feeRate: '0.001',
      realizedPnl: '0',
      feeAmount: '0',
      settledPnl: '0',
      settledFee: '0',
      settledCash: '0',
      bankruptcyShortfall: '0',
      walletBalanceBefore: '0',
      walletBalanceAfter: '0',
      scopesJson: [],
      executedAt: seconds(quietSeason.endAt, 60),
    },
  });
  // Another member's records at the same times: never part of the owner's history.
  const foreign = await lifetime(
    strangerAccount,
    'long',
    'isolated',
    hoursAgo(7),
  );
  const foreignOpen = await execution(
    foreign,
    'open',
    '1',
    '60000',
    hoursAgo(10),
  );
  const foreignClose = await execution(
    foreign,
    'close',
    '1',
    '64000',
    hoursAgo(7),
  );

  const read = (
    accountId: string,
    phase: FuturesHistoryPhase,
    limit = 20,
    offset = 0,
  ) =>
    db.$transaction(
      (tx) =>
        readFuturesPositionHistory(tx, accountId, phase, { limit, offset }),
      { isolationLevel: 'RepeatableRead' },
    );
  const keys = (records: FuturesHistoryRecord[]) =>
    records.map((record) => `${record.kind}:${record.id}`);

  const entry = await read(seasonAccount, 'entry');
  check(
    JSON.stringify(keys(entry.records)) ===
      JSON.stringify(
        [
          ids.long3Open,
          ids.short2Open,
          ids.long2Open,
          ids.short1Open,
          ids.long1Increase,
          ids.long1Open,
        ].map((id) => `execution:${id}`),
      ),
    `entry: open/increase only, long and short, newest first ${JSON.stringify(keys(entry.records))}`,
  );
  check(
    entry.pagination.total === 6 && entry.pagination.nextOffset === null,
    `entry pagination ${JSON.stringify(entry.pagination)}`,
  );
  check(
    entry.records.every(
      (record) =>
        record.kind === 'execution' &&
        ['open', 'increase'].includes(record.execution.operation) &&
        record.execution.instrument.underlying.symbol === asset.symbol,
    ),
    'entry records are the executions route’s own shape',
  );

  const exitKeys = [
    `season_settlement:${settlement.id}`,
    `liquidation:${liquidation.id}`,
    `execution:${ids.long3Reduce}`,
    `execution:${ids.long1Close}`,
    `execution:${ids.long1Reduce}`,
  ];
  const exit = await read(seasonAccount, 'exit');
  check(
    JSON.stringify(keys(exit.records)) === JSON.stringify(exitKeys),
    `exit: Season exit, liquidation (before a reduce at its own instant), reduce/close, newest first ${JSON.stringify(keys(exit.records))}`,
  );
  check(exit.pagination.total === 5, `exit total ${exit.pagination.total}`);
  const [seasonExit, liquidated] = exit.records as [
    Extract<FuturesHistoryRecord, { kind: 'season_settlement' }>,
    Extract<FuturesHistoryRecord, { kind: 'liquidation' }>,
  ];
  check(
    seasonExit.settlement.closes.length === 1 &&
      seasonExit.settlement.closes[0].positionId === short1.id &&
      seasonExit.settlement.closes[0].direction === 'short' &&
      seasonExit.settlement.closes[0].priceBasis === 'spot_last' &&
      seasonExit.settlement.closes[0].executionPrice === '62000.00000000' &&
      seasonExit.settlement.closes[0].instrument.underlying
        .displayPriceDecimals === 1 &&
      seasonExit.settlement.settledCash === '-212.40000000' &&
      seasonExit.executedAt === settledAt.toISOString(),
    `season exit ${JSON.stringify(seasonExit)}`,
  );
  const liquidationCloses = (
    liquidated.liquidation as {
      closes: Array<{ positionId: string; direction: string }>;
    }
  ).closes;
  check(
    liquidationCloses.length === 2 &&
      JSON.stringify(liquidationCloses.map((close) => close.positionId)) ===
        JSON.stringify([long2.id, short2.id].sort()) &&
      new Set(liquidationCloses.map((close) => close.direction)).size === 2,
    `one liquidation event keeps both of its closes ${JSON.stringify(liquidationCloses)}`,
  );
  // Small pages cover the same union once each: nothing repeated, nothing skipped.
  const paged: string[] = [];
  const offsets: Array<number | null> = [];
  for (let offset: number | null = 0; offset !== null; ) {
    const page = await read(seasonAccount, 'exit', 2, offset);
    paged.push(...keys(page.records));
    offsets.push(page.pagination.nextOffset);
    offset = page.pagination.nextOffset;
  }
  check(
    JSON.stringify(paged) === JSON.stringify(exitKeys) &&
      JSON.stringify(offsets) === JSON.stringify([2, 4, null]),
    `exit pages of 2 ${JSON.stringify({ paged, offsets })}`,
  );
  const quiet = await Promise.all([
    read(quietAccount, 'exit'),
    read(quietAccount, 'entry'),
  ]);
  check(
    quiet.every(
      (page) => page.records.length === 0 && page.pagination.total === 0,
    ),
    'a Season exit that closed nothing is not a position record',
  );
  const foreignExit = await read(strangerAccount, 'exit');
  const foreignEntry = await read(strangerAccount, 'entry');
  check(
    JSON.stringify(keys(foreignExit.records)) ===
      JSON.stringify([`execution:${foreignClose}`]) &&
      JSON.stringify(keys(foreignEntry.records)) ===
        JSON.stringify([`execution:${foreignOpen}`]) &&
      ![...keys(entry.records), ...keys(exit.records)].some(
        (key) => key.endsWith(foreignOpen) || key.endsWith(foreignClose),
      ),
    'each account reads only its own records',
  );

  // HTTP: owner only, through the real guard, pipe and controller.
  const jwt = new JwtService();
  const config = new ConfigService({
    JWT_ACCESS_SECRET: 'futures-position-history-integration-secret-32-chars',
    JWT_ACCESS_TTL: '15m',
    REFRESH_TOKEN_TTL: '30d',
  });
  // The history read uses only the database and the ownership check.
  const service = new FuturesService(
    db,
    new TradingAccountAccessService(db),
    {} as GeneralAccountPerformanceService,
  );
  // tsx omits emitDecoratorMetadata; supply the constructor metadata tsc emits.
  Reflect.defineMetadata(
    'design:paramtypes',
    [FuturesService, FuturesLeverageService],
    FuturesController,
  );
  const app = await Test.createTestingModule({
    controllers: [FuturesController],
    providers: [
      { provide: FuturesService, useValue: service },
      { provide: FuturesLeverageService, useValue: {} },
    ],
  }).compile();
  const http = app.createNestApplication();
  http.useGlobalGuards(new AccessTokenGuard(jwt, db, new Reflector(), config));
  await http.init();
  closeHttp = () => http.close();
  const server = http.getHttpServer() as Server;
  const token = (userId: string) =>
    jwt.sign(
      { sub: userId },
      { secret: config.get<string>('JWT_ACCESS_SECRET')! },
    );
  const get = (accountId: string, query: string, userId?: string) => {
    const call = request(server).get(
      `/api/v1/trading-accounts/${accountId}/futures/position-history?${query}`,
    );
    return userId ? call.auth(token(userId), { type: 'bearer' }) : call;
  };
  await get(seasonAccount, 'phase=exit').expect(401);
  const strangerRead = await get(seasonAccount, 'phase=exit', stranger).expect(
    404,
  );
  check(
    (strangerRead.body as { error: { code: string } }).error.code ===
      'TRADING_ACCOUNT_NOT_FOUND',
    'another member’s account is not found',
  );
  await get(strangerAccount, 'phase=entry', owner).expect(404);
  for (const query of ['phase=closed', '', 'phase[]=exit'])
    check(
      (
        (await get(seasonAccount, query, owner).expect(400)).body as {
          error: { code: string };
        }
      ).error.code === 'INVALID_FUTURES_HISTORY_PHASE',
      `phase is required and checked (${query || 'none'})`,
    );
  check(
    (
      (await get(seasonAccount, 'phase=exit&limit=0', owner).expect(400))
        .body as { error: { code: string } }
    ).error.code === 'INVALID_PAGINATION',
    'pagination bounds are the executions route’s',
  );
  const own = await get(
    seasonAccount,
    'phase=exit&limit=20&offset=0',
    owner,
  ).expect(200);
  const body = own.body as {
    data: {
      tradingAccountId: string;
      phase: string;
      records: FuturesHistoryRecord[];
    };
  };
  check(
    body.data.tradingAccountId === seasonAccount &&
      body.data.phase === 'exit' &&
      JSON.stringify(body.data.records) === JSON.stringify(exit.records),
    'HTTP answers the ended season account with the same records',
  );
  const second = await get(
    seasonAccount,
    'phase=entry&limit=4&offset=4',
    owner,
  ).expect(200);
  const secondPage = (
    second.body as {
      data: {
        records: FuturesHistoryRecord[];
        pagination: { nextOffset: number | null };
      };
    }
  ).data;
  check(
    JSON.stringify(keys(secondPage.records)) ===
      JSON.stringify([
        `execution:${ids.long1Increase}`,
        `execution:${ids.long1Open}`,
      ]) && secondPage.pagination.nextOffset === null,
    'HTTP pages entries by offset',
  );
  // Reads only: nothing financial was written by the reads above.
  const counts = await Promise.all([
    db.futuresExecution.count({
      where: { tradingAccountId: { in: accountIds } },
    }),
    db.futuresLiquidationClose.count({
      where: { tradingAccountId: { in: accountIds } },
    }),
    db.futuresSeasonClose.count({
      where: { tradingAccountId: { in: accountIds } },
    }),
    db.futuresPosition.count({
      where: { tradingAccountId: { in: accountIds }, status: 'open' },
    }),
  ]);
  check(
    JSON.stringify(counts) === JSON.stringify([11, 2, 1, 1]),
    `records untouched ${JSON.stringify(counts)}`,
  );
  console.log(
    `futures position history PostgreSQL + HTTP ok (${assertions} checks)`,
  );
}

run()
  .finally(async () => {
    await closeHttp?.();
    const where = { tradingAccountId: { in: accountIds } };
    await db.futuresSeasonClose.deleteMany({ where });
    await db.futuresSeasonSettlement.deleteMany({ where });
    await db.futuresSeasonPrice.deleteMany({
      where: { seasonId: { in: seasonIds } },
    });
    await db.futuresLiquidationClose.deleteMany({ where });
    await db.futuresLiquidation.deleteMany({ where });
    await db.futuresExecution.deleteMany({ where });
    await db.futuresPosition.deleteMany({ where });
    if (instrumentId) {
      await db.futuresMarkSnapshot.deleteMany({ where: { instrumentId } });
      await db.futuresInstrument.delete({ where: { id: instrumentId } });
    }
    if (assetId) {
      await db.assetPriceSnapshot.deleteMany({ where: { assetId } });
      await db.asset.delete({ where: { id: assetId } });
    }
    await db.seasonParticipant.deleteMany({ where });
    await db.tradingAccount.deleteMany({ where: { id: { in: accountIds } } });
    await db.season.deleteMany({ where: { id: { in: seasonIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
