/** 수익 공유 owner read on an isolated PostgreSQL + real HTTP/guard; no provider or financial write path. */
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
import { CompletedTradesController } from '../src/completed-trades/completed-trades.controller';
import { CompletedTradesService } from '../src/completed-trades/completed-trades.service';
import {
  readOwnCompletedTrades,
  type OwnCompletedTrade,
} from '../src/completed-trades/own-completed-trades';
import { readFriendCompletedTrades } from '../src/friends/friend-completed-trades';
import { zeroCryptoCashWalletData } from '../src/wallets/canonical-cash-wallets';

if (
  process.env.COMPLETED_TRADES_DB_INTEGRATION !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !process.env.DATABASE_URL
) {
  throw new Error(
    'Requires COMPLETED_TRADES_DB_INTEGRATION=1 NODE_ENV=test and an isolated DATABASE_URL.',
  );
}
const db = new PrismaService();
const tag = randomUUID().slice(0, 8);
const now = new Date();
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
const userIds: string[] = [];
const accountIds: string[] = [];
const assetIds: string[] = [];
let seasonId: string | undefined;
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
  await db.cashWallet.createMany({
    data: [
      { tradingAccountId: row.id, currencyCode: 'KRW', balanceAmount: '0' },
      { tradingAccountId: row.id, currencyCode: 'USD', balanceAmount: '0' },
      ...zeroCryptoCashWalletData(row.id),
    ],
  });
  return row.id;
}

async function spotOrder(
  tradingAccountId: string,
  assetId: string,
  [side, price, quantity, gross, fee, net, at]: readonly [
    'buy' | 'sell',
    string,
    string,
    string,
    string,
    string,
    Date,
  ],
) {
  const evidence = await db.assetPriceSnapshot.create({
    data: {
      assetId,
      price,
      currencyCode: 'KRW',
      sourceType: 'admin_manual',
      sourceName: 'completed-trades-fixture',
      effectiveAt: at,
      capturedAt: at,
    },
  });
  const order = await db.order.create({
    data: {
      tradingAccountId,
      assetId,
      side,
      orderType: 'market',
      status: 'executed',
      quantity,
      currencyCode: 'KRW',
      cashWalletScope: 'securities',
      executedPrice: price,
      grossAmount: gross,
      feeAmount: fee,
      netAmount: net,
      assetPriceSnapshotId: evidence.id,
      submittedAt: at,
      executedAt: at,
    },
  });
  return order.id;
}

async function run() {
  for (const name of ['owner', 'stranger', 'twin']) {
    const user = await db.user.create({
      data: {
        email: `${tag}-${name}@example.invalid`,
        nickname: `share-${tag}-${name}`,
        passwordHash: 'test-only',
      },
    });
    userIds.push(user.id);
  }
  const [owner, stranger, twin] = userIds;
  const season = await db.season.create({
    data: {
      name: `share-${tag}`,
      status: 'settled',
      startAt: hoursAgo(240),
      endAt: hoursAgo(24),
      initialCapitalKrw: '1000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  seasonId = season.id;
  const seasonAccount = await account(owner, 'season');
  await db.seasonParticipant.create({
    data: {
      userId: owner,
      seasonId,
      tradingAccountId: seasonAccount,
      participantStatus: 'finished',
      initialCapitalKrw: '1000000',
      joinedAt: season.startAt,
      totalAssetKrw: '1000000',
      totalReturnRate: '0',
      maxDrawdown: '0',
    },
  });
  const generalAccount = await account(owner, 'general');
  const strangerAccount = await account(stranger, 'general');

  // Spot: buy 10 @ 70,000 and 5 @ 72,000, sell 15 @ 75,000 (0.1% fees) on
  // the settled season account — the friend policy's own fixture.
  const krx = await db.asset.create({
    data: {
      symbol: `SH${tag.slice(0, 4)}`,
      name: 'Completed share fixture',
      market: 'KRX',
      assetType: 'domestic_stock',
      currencyCode: 'KRW',
      priceCurrency: 'KRW',
      settlementCurrency: 'KRW',
    },
  });
  assetIds.push(krx.id);
  const seasonOrders: string[] = [];
  for (const row of [
    ['buy', '70000', '10', '700000', '700', '700700', hoursAgo(30)],
    ['buy', '72000', '5', '360000', '360', '360360', hoursAgo(29)],
    ['sell', '75000', '15', '1125000', '1125', '1123875', hoursAgo(28)],
  ] as const)
    seasonOrders.push(await spotOrder(seasonAccount, krx.id, row));
  await db.position.create({
    data: {
      tradingAccountId: seasonAccount,
      assetId: krx.id,
      quantity: '0',
      averageCost: '70737.33333333',
      currencyCode: 'KRW',
      realizedPnl: '62815.00000005',
      realizedPnlKrw: '62815.00000005',
    },
  });

  // Futures: one closed long lifetime — open 0.5 @ 60,000, add 0.5 @ 62,000,
  // reduce 0.4 @ 63,000, close 0.6 @ 64,000 at 10x; one still open.
  const btc = await db.asset.create({
    data: {
      symbol: `SHBTC${tag.slice(0, 4)}`,
      name: 'Bitcoin share fixture',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
  });
  assetIds.push(btc.id);
  const instrument = await db.futuresInstrument.create({
    data: {
      underlyingAssetId: btc.id,
      markContractJson: { priceTickSize: '0.10' },
    },
  });
  instrumentId = instrument.id;
  const lifetime = await db.futuresPosition.create({
    data: {
      tradingAccountId: seasonAccount,
      instrumentId,
      direction: 'long',
      marginMode: 'isolated',
      status: 'closed',
      quantity: '0',
      averageEntryPrice: '61000',
      entryNotional: '0',
      leverage: 10,
      isolatedMargin: '0',
      realizedPnl: '2600',
      closedAt: hoursAgo(26),
    },
  });
  for (const [operation, price, quantity, fee, realized, after, at] of [
    ['open', '60000', '0.5', '30', '0', '0.5', hoursAgo(27.5)],
    ['increase', '62000', '0.5', '31', '0', '1', hoursAgo(27.4)],
    ['reduce', '63000', '0.4', '25.2', '800', '0.6', hoursAgo(26.5)],
    ['close', '64000', '0.6', '38.4', '1800', '0', hoursAgo(26)],
  ] as const) {
    const evidence = await db.assetPriceSnapshot.create({
      data: {
        assetId: btc.id,
        price,
        currencyCode: 'USD',
        sourceType: 'provider_api',
        sourceName: 'binance_spot_ws_ticker',
        effectiveAt: new Date(at.getTime() - 1_000),
        capturedAt: new Date(at.getTime() - 1_000),
      },
    });
    await db.futuresExecution.create({
      data: {
        tradingAccountId: seasonAccount,
        instrumentId,
        positionId: lifetime.id,
        operation,
        direction: 'long',
        marginMode: 'isolated',
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
        feeAmount: fee,
        realizedPnl: realized,
        positionQuantityAfter: after,
        averageEntryPriceAfter: '61000',
        isolatedMarginAfter: '0',
        executedAt: at,
      },
    });
  }
  await db.futuresPosition.create({
    data: {
      tradingAccountId: seasonAccount,
      instrumentId,
      direction: 'short',
      marginMode: 'isolated',
      quantity: '1',
      averageEntryPrice: '60000',
      entryNotional: '60000',
      leverage: 5,
      isolatedMargin: '12000',
    },
  });

  // General account: a round before its reset (re-based to 0 by the reset) and one after.
  const resetAt = hoursAgo(10);
  const generalOrders: string[] = [];
  for (const row of [
    ['buy', '100', '1', '100', '0.1', '100.1', hoursAgo(12)],
    ['sell', '110', '1', '110', '0.11', '109.89', hoursAgo(11)],
    ['buy', '200', '2', '400', '0.4', '400.4', hoursAgo(5)],
    ['sell', '190', '2', '380', '0.38', '379.62', hoursAgo(4)],
  ] as const)
    generalOrders.push(await spotOrder(generalAccount, krx.id, row));
  await db.position.create({
    data: {
      tradingAccountId: generalAccount,
      assetId: krx.id,
      quantity: '0',
      averageCost: '200.2',
      currencyCode: 'KRW',
      realizedPnl: '-20.78',
      realizedPnlKrw: '-20.78',
    },
  });
  const claim = await db.adRewardClaim.create({
    data: {
      userId: owner,
      tradingAccountId: generalAccount,
      provider: 'test-ads',
      providerEventId: `share-${tag}`,
      status: 'granted',
      rewardAmountKrw: '0',
      purpose: 'account_reset',
      requestedAt: resetAt,
      verifiedAt: resetAt,
      grantedAt: resetAt,
    },
  });
  await db.generalAccountReset.create({
    data: {
      tradingAccountId: generalAccount,
      userId: owner,
      adRewardClaimId: claim.id,
      sequence: 1,
      resetAt,
      targetKrwBalance: '10000000',
      lifetimeExternalFundingKrw: '10000000',
      closingTotalAssetKrw: '10000000',
      closingExternalFundingKrw: '10000000',
      closingInvestmentPnlKrw: '0',
      walletsBeforeJson: [],
      positionsRebasedJson: [],
    },
  });

  // Two SELLs at the same instant closed this holding: which one closed it is not known.
  const tieAccount = await account(twin, 'general');
  for (const row of [
    ['buy', '100', '2', '200', '0.2', '200.2', hoursAgo(3)],
    ['sell', '105', '1', '105', '0.105', '104.895', hoursAgo(2)],
    ['sell', '105', '1', '105', '0.105', '104.895', hoursAgo(2)],
  ] as const)
    await spotOrder(tieAccount, krx.id, row);
  await db.position.create({
    data: {
      tradingAccountId: tieAccount,
      assetId: krx.id,
      quantity: '0',
      averageCost: '100.1',
      currencyCode: 'KRW',
      realizedPnl: '9.59',
      realizedPnlKrw: '9.59',
    },
  });

  // The raw reads on PostgreSQL: Σ(price × quantity), Σ gross / Σ quantity, the epoch filter.
  const read = (accountId: string, spotSince: Date | null) =>
    db.$transaction(
      (tx) =>
        readOwnCompletedTrades(tx, accountId, {
          spotSince,
          spotDisplayDecimals: () => null,
        }),
      { isolationLevel: 'RepeatableRead' },
    );
  const seasonRead = await read(seasonAccount, null);
  check(
    seasonRead.items.map((item) => item.key).join(',') ===
      `futures:${lifetime.id},spot:${krx.id}`,
    `newest completion first, the open lifetime left out: ${seasonRead.items.map((item) => item.key).join(',')}`,
  );
  const [futures, spot] = seasonRead.items as [
    Extract<OwnCompletedTrade, { kind: 'futures' }>,
    Extract<OwnCompletedTrade, { kind: 'spot' }>,
  ];
  check(
    spot.averageBuyPrice === '70666.66666667' &&
      spot.averageSellPrice === '75000.00000000' &&
      spot.completedAt === hoursAgo(28).toISOString(),
    `spot evidence ${JSON.stringify([spot.averageBuyPrice, spot.averageSellPrice, spot.completedAt])}`,
  );
  check(
    spot.lastSellOrderId === seasonOrders[2],
    `the SELL that closed the holding ${spot.lastSellOrderId}`,
  );
  check(
    futures.averageEntryPrice === '61000.00000000' &&
      futures.averageExitPrice === '63600.00000000' &&
      futures.leverage === 10 &&
      futures.closeKind === 'closed' &&
      futures.displayPriceDecimals === 1 &&
      futures.completedAt === hoursAgo(26).toISOString(),
    `futures evidence ${JSON.stringify(futures)}`,
  );
  // The same figures as the friend policy reads for this account.
  const friend = await db.$transaction(
    (tx) => readFriendCompletedTrades(tx, seasonAccount),
    { isolationLevel: 'RepeatableRead' },
  );
  check(
    JSON.stringify(
      friend.items.map((item) => [
        item.kind,
        item.realizedPnl,
        item.returnRate,
      ]),
    ) ===
      JSON.stringify(
        seasonRead.items.map((item) => [
          item.kind,
          item.realizedPnl,
          item.returnRate,
        ]),
      ),
    'owner figures equal the 거래 완료 종목 policy',
  );
  check(
    spot.realizedPnl === '62815.00000005' &&
      spot.returnRate === '5.92002337' &&
      futures.realizedPnl === '2475.40000000' &&
      futures.returnRate === '40.58032787',
    `confirmed figures ${JSON.stringify([spot.realizedPnl, spot.returnRate, futures.realizedPnl, futures.returnRate])}`,
  );
  // Without the reset epoch the ended round would be mixed into the basis.
  const mixed = (await read(generalAccount, null)).items[0] as Extract<
    OwnCompletedTrade,
    { kind: 'spot' }
  >;
  check(
    mixed.buyAmount === '500.50000000',
    'control: all rounds without the epoch',
  );
  const epoch = (await read(generalAccount, resetAt)).items[0] as Extract<
    OwnCompletedTrade,
    { kind: 'spot' }
  >;
  check(
    epoch.buyAmount === '400.40000000' &&
      epoch.realizedPnl === '-20.78000000' &&
      epoch.averageBuyPrice === '200.00000000' &&
      epoch.averageSellPrice === '190.00000000' &&
      epoch.completedAt === hoursAgo(4).toISOString() &&
      epoch.lastSellOrderId === generalOrders[3],
    `epoch round ${JSON.stringify(epoch)}`,
  );
  const [tie] = (await read(tieAccount, null)).items as Array<
    Extract<OwnCompletedTrade, { kind: 'spot' }>
  >;
  check(
    tie?.realizedPnl === '9.59000000' && tie.lastSellOrderId === null,
    `two SELLs at the closing instant name neither ${JSON.stringify(tie)}`,
  );

  // HTTP: owner only, through the real guard and controller.
  const jwt = new JwtService();
  const config = new ConfigService({
    JWT_ACCESS_SECRET:
      'completed-trades-integration-secret-with-at-least-32-chars',
    JWT_ACCESS_TTL: '15m',
    REFRESH_TOKEN_TTL: '30d',
  });
  const service = new CompletedTradesService(
    db,
    new TradingAccountAccessService(db),
  );
  // tsx omits emitDecoratorMetadata; supply the constructor metadata tsc emits.
  Reflect.defineMetadata(
    'design:paramtypes',
    [CompletedTradesService],
    CompletedTradesController,
  );
  const app = await Test.createTestingModule({
    controllers: [CompletedTradesController],
    providers: [{ provide: CompletedTradesService, useValue: service }],
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
  const get = (accountId: string, userId?: string) => {
    const call = request(server).get(
      `/api/v1/trading-accounts/${accountId}/completed-trades`,
    );
    return userId ? call.auth(token(userId), { type: 'bearer' }) : call;
  };
  await get(seasonAccount).expect(401);
  const foreign = await get(strangerAccount, owner).expect(404);
  check(
    (foreign.body as { error: { code: string } }).error.code ===
      'TRADING_ACCOUNT_NOT_FOUND',
    'another member’s account is not found',
  );
  await get(seasonAccount, stranger).expect(404);
  const own = await get(seasonAccount, owner).expect(200);
  const body = own.body as {
    data: { tradingAccountId: string; items: OwnCompletedTrade[] };
  };
  check(
    body.data.tradingAccountId === seasonAccount &&
      JSON.stringify(body.data.items) === JSON.stringify(seasonRead.items),
    'HTTP answers the settled season account with the same items',
  );
  const general = await get(generalAccount, owner).expect(200);
  const generalItems = (
    general.body as { data: { items: OwnCompletedTrade[] } }
  ).data.items;
  check(
    generalItems.length === 1 &&
      generalItems[0].kind === 'spot' &&
      generalItems[0].buyAmount === '400.40000000',
    'the service applies the latest general reset',
  );
  const emptyAccount = await get(strangerAccount, stranger).expect(200);
  check(
    (emptyAccount.body as { data: { items: unknown[]; hasMore: boolean } }).data
      .items.length === 0,
    'an account with nothing completed lists nothing',
  );
  // Reads only: nothing financial was written by the reads above.
  const orders = await db.order.count({
    where: { tradingAccountId: { in: accountIds } },
  });
  check(orders === 10, `orders untouched (${orders})`);
  console.log(`completed trades PostgreSQL + HTTP ok (${assertions} checks)`);
}

run()
  .finally(async () => {
    await closeHttp?.();
    await db.generalAccountReset.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await db.adRewardClaim.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await db.futuresExecution.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await db.futuresPosition.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await db.order.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await db.position.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    if (instrumentId)
      await db.futuresInstrument.delete({ where: { id: instrumentId } });
    await db.assetPriceSnapshot.deleteMany({
      where: { assetId: { in: assetIds } },
    });
    await db.asset.deleteMany({ where: { id: { in: assetIds } } });
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
