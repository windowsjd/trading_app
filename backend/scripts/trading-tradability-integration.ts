/** Real PostgreSQL proof of asset state versus account trading authority. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { TradingAccountMode } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { OrdersService } from '../src/orders/orders.service';
import { FxService } from '../src/fx/fx.service';
import { AssetsService } from '../src/assets/assets.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';

const prisma = new PrismaService();
const access = new TradingAccountAccessService(prisma);
const valuation = new PortfolioValuationService(prisma);
const performance = new GeneralAccountPerformanceService(
  prisma,
  valuation,
  new GeneralExternalFundingService(prisma),
);
const general = new GeneralAccountsService(prisma, performance);
const reservations = new OrderReservationService();
const assets = new AssetsService(prisma);
const orders = new OrdersService(
  prisma,
  undefined,
  new LimitOrderCreateService(prisma, reservations),
  new LimitOrderCancelService(prisma, reservations),
  access,
  performance,
);
const fx = new FxService(
  prisma,
  undefined,
  undefined,
  access,
  performance,
  undefined,
  valuation,
);
const FEE = '0.001000';
async function dbNow() {
  const rows = await prisma.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS now`;
  return rows[0].now;
}
function code(error: unknown) {
  assert.ok(error instanceof HttpException, String(error));
  return (error.getResponse() as { error: { code: string } }).error.code;
}
async function rejected(work: Promise<unknown>, expected: string) {
  await assert.rejects(work, (error: unknown) => {
    assert.equal(code(error), expected);
    return true;
  });
}
async function fixture(mode: TradingAccountMode) {
  const now = await dbNow();
  const user = await prisma.user.create({
    data: {
      email: `tradability-${randomUUID()}@example.com`,
      passwordHash: 'test-only',
      nickname: `tx-${randomUUID().slice(0, 8)}`,
    },
  });
  const season =
    mode === 'season'
      ? await prisma.season.create({
          data: {
            name: `tradability-${randomUUID()}`,
            status: 'active',
            startAt: new Date(now.getTime() - 3600_000),
            endAt: new Date(now.getTime() + 86400_000),
            initialCapitalKrw: '10000000',
            tradeFeeRate: FEE,
            fxFeeRate: FEE,
          },
        })
      : null;
  const accountId = season
    ? (
        await prisma.tradingAccount.create({
          data: {
            userId: user.id,
            mode,
            initialCapitalKrw: '10000000',
            openedAt: now,
          },
        })
      ).id
    : (await general.openGeneralAccount(user.id)).data.account.id;
  const participant = season
    ? await prisma.seasonParticipant.create({
        data: {
          userId: user.id,
          seasonId: season.id,
          tradingAccountId: accountId,
          participantStatus: 'active',
          joinedAt: now,
          initialCapitalKrw: '10000000',
          totalAssetKrw: '10000000',
          totalReturnRate: '0',
          maxDrawdown: '0',
        },
      })
    : null;
  if (season)
    await prisma.cashWallet.createMany({
      data: [
        {
          tradingAccountId: accountId,
          currencyCode: 'KRW',
          balanceAmount: '10000000',
          reservedAmount: '0',
        },
        {
          tradingAccountId: accountId,
          currencyCode: 'USD',
          balanceAmount: '0',
          reservedAmount: '0',
        },
      ],
    });
  const asset = await prisma.asset.create({
    data: {
      symbol: `T${randomUUID().slice(0, 20)}`,
      name: 'tradability fixture',
      isActive: true,
      assetType: 'crypto',
      market: 'BINANCE',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
  });
  const price = await prisma.assetPriceSnapshot.create({
    data: {
      assetId: asset.id,
      price: '100',
      currencyCode: asset.currencyCode,
      sourceType: 'provider_api',
      sourceName: 'binance_spot_ws_ticker',
      effectiveAt: now,
      capturedAt: now,
    },
  });
  const rate = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate: '1400',
      sourceType: 'provider_api',
      sourceName: 'korea_exim_exchange_rate',
      effectiveAt: now,
      capturedAt: now,
    },
  });
  const s = {
    userId: user.id,
    accountId,
    season,
    participant,
    asset,
    price,
    rate,
  };
  // Fund USD through the same FX engine, preserving general TWR invariants.
  const body = await fxBody(s);
  await fx.executeForTradingAccount(user.id, accountId, body);
  return s;
}
type Scenario = Awaited<ReturnType<typeof fixture>>;
async function cleanup(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  await prisma.walletTransaction.deleteMany({ where });
  await prisma.fxExecuteRequest.deleteMany({ where });
  await prisma.exchangeTransaction.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.quote.deleteMany({ where });
  await prisma.position.deleteMany({ where });
  await prisma.equitySnapshot.deleteMany({ where });
  await prisma.cashWallet.deleteMany({ where });
  await prisma.seasonParticipant.deleteMany({ where });
  await prisma.tradingAccount.delete({ where: { id: s.accountId } });
  if (s.season) await prisma.season.delete({ where: { id: s.season.id } });
  await prisma.assetPriceSnapshot.deleteMany({
    where: { assetId: s.asset.id },
  });
  await prisma.asset.delete({ where: { id: s.asset.id } });
  await prisma.fxRateSnapshot.delete({ where: { id: s.rate.id } });
  await prisma.user.delete({ where: { id: s.userId } });
}
async function fxBody(s: { userId: string; accountId: string }) {
  const quoted = await fx.quoteForTradingAccount(s.userId, s.accountId, {
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '14000',
  });
  assert.ok(quoted.data.quoteId);
  return {
    quoteId: quoted.data.quoteId,
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '14000',
    idempotencyKey: randomUUID(),
  };
}
async function financialState(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  return {
    wallets: await prisma.cashWallet.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    orders: await prisma.order.findMany({ where, orderBy: { id: 'asc' } }),
    ledger: await prisma.walletTransaction.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    snapshots: await prisma.equitySnapshot.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    positions: await prisma.position.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    exchanges: await prisma.exchangeTransaction.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    commands: await prisma.fxExecuteRequest.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
  };
}

async function assertHealthyAsset(s: Scenario) {
  const before = await financialState(s);
  const list = await assets.getAssets(s.userId, {
    search: s.asset.symbol,
    withPrice: 'true',
  });
  const detail = await assets.getAsset(s.userId, s.asset.id);
  for (const asset of [
    list.data.assets.find((row) => row.assetId === s.asset.id),
    detail.data.asset,
  ]) {
    assert.ok(asset);
    assert.equal(asset.marketStatus, 'always_open');
    assert.equal(asset.tradable, true);
    assert.equal(asset.tradeBlockedReason, null);
    assert.equal(asset.price?.state, 'available');
  }
  assert.deepEqual(await financialState(s), before);
}

function marketRequest(s: Scenario) {
  return {
    assetId: s.asset.id,
    orderType: 'market',
    side: 'buy',
    quantity: '0.01',
  };
}

async function marketBody(s: Scenario) {
  const request = marketRequest(s);
  const quote = await orders.quoteOrderForTradingAccount(
    s.userId,
    s.accountId,
    request,
  );
  assert.ok(quote.data.quoteId);
  return {
    ...request,
    quoteId: quote.data.quoteId,
    idempotencyKey: randomUUID(),
  };
}

async function generalTest(withUnjoinedSeason: boolean) {
  const s = await fixture(TradingAccountMode.general);
  let unrelatedSeasonId: string | undefined;
  try {
    if (withUnjoinedSeason) {
      const now = await dbNow();
      unrelatedSeasonId = (
        await prisma.season.create({
          data: {
            name: `unjoined-${randomUUID()}`,
            status: 'active',
            startAt: new Date(now.getTime() - 60000),
            endAt: new Date(now.getTime() + 3600000),
            initialCapitalKrw: '10000000',
            tradeFeeRate: FEE,
            fxFeeRate: FEE,
          },
        })
      ).id;
      assert.equal(
        await prisma.seasonParticipant.count({
          where: { userId: s.userId, seasonId: unrelatedSeasonId },
        }),
        0,
      );
    } else
      assert.equal(
        await prisma.season.count({ where: { status: 'active' } }),
        0,
      );
    await assertHealthyAsset(s);
    await orders.createOrderForTradingAccount(
      s.userId,
      s.accountId,
      await marketBody(s),
    );
    assert.equal(
      await prisma.order.count({
        where: { tradingAccountId: s.accountId, status: 'executed' },
      }),
      1,
    );
    await fx.executeForTradingAccount(s.userId, s.accountId, await fxBody(s));
    assert.equal(
      await prisma.exchangeTransaction.count({
        where: { tradingAccountId: s.accountId },
      }),
      2,
    );
  } finally {
    await cleanup(s);
    if (unrelatedSeasonId)
      await prisma.season.delete({ where: { id: unrelatedSeasonId } });
  }
}

async function restrictedSeasonTest(
  state: 'excluded' | 'upcoming' | 'ended' | 'settled' | 'suspended' | 'closed',
) {
  const s = await fixture(TradingAccountMode.season);
  try {
    const market = await marketBody(s);
    const exchange = await fxBody(s);
    const limitRequest = {
      ...marketRequest(s),
      orderType: 'limit',
      limitPrice: '99',
    };
    const quote = await orders.quoteOrderForTradingAccount(
      s.userId,
      s.accountId,
      limitRequest,
    );
    assert.ok(quote.data.quoteId);
    await orders.createOrderForTradingAccount(s.userId, s.accountId, {
      ...limitRequest,
      quoteId: quote.data.quoteId,
      idempotencyKey: randomUUID(),
    });
    const limit = await prisma.order.findUniqueOrThrow({
      where: { quoteId: quote.data.quoteId },
    });
    assert.ok(limit.reservedAmount?.gt(0));
    let expected = 'SEASON_NOT_ACTIVE';
    if (state === 'excluded') {
      await prisma.seasonParticipant.update({
        where: { id: s.participant!.id },
        data: { participantStatus: 'excluded' },
      });
      expected = 'PARTICIPANT_EXCLUDED';
    } else if (state === 'suspended' || state === 'closed') {
      await prisma.tradingAccount.update({
        where: { id: s.accountId },
        data: { status: state },
      });
      expected = 'TRADING_ACCOUNT_NOT_ACTIVE';
    } else
      await prisma.season.update({
        where: { id: s.season!.id },
        data: { status: state },
      });

    // A healthy BTC-like asset remains tradable regardless of this account.
    await assertHealthyAsset(s);
    const before = await financialState(s);
    await rejected(
      orders.quoteOrderForTradingAccount(
        s.userId,
        s.accountId,
        marketRequest(s),
      ),
      expected,
    );
    await rejected(
      orders.quoteOrderForTradingAccount(s.userId, s.accountId, limitRequest),
      expected,
    );
    await rejected(
      orders.createOrderForTradingAccount(s.userId, s.accountId, market),
      expected,
    );
    await rejected(
      fx.quoteForTradingAccount(s.userId, s.accountId, exchange),
      expected,
    );
    await rejected(
      fx.executeForTradingAccount(s.userId, s.accountId, exchange),
      expected,
    );
    assert.deepEqual(await financialState(s), before);
    // History remains readable and cancel releases the real reservation.
    await orders.getOrdersForTradingAccount(s.userId, s.accountId);
    await fx.getExchangesForTradingAccount(s.userId, s.accountId);
    await orders.cancelOrderForTradingAccount(s.userId, s.accountId, limit.id);
    const canceled = await prisma.order.findUniqueOrThrow({
      where: { id: limit.id },
    });
    assert.equal(canceled.status, 'canceled');
    assert.ok(canceled.reservationReleasedAt);
    const wallet = await prisma.cashWallet.findUniqueOrThrow({
      where: {
        tradingAccountId_currencyCode: {
          tradingAccountId: s.accountId,
          currencyCode: 'USD',
        },
      },
    });
    assert.equal(wallet.reservedAmount.toFixed(8), '0.00000000');
  } finally {
    await cleanup(s);
  }
}

async function main() {
  await prisma.onModuleInit();
  try {
    for (const withSeason of [false, true]) {
      await generalTest(withSeason);
      console.log(
        `PASS general ${withSeason ? 'season not joined' : 'no active season'}`,
      );
    }
    for (const state of [
      'excluded',
      'upcoming',
      'ended',
      'settled',
      'suspended',
      'closed',
    ] as const) {
      await restrictedSeasonTest(state);
      console.log(
        `PASS season ${state}: asset neutral, mutations blocked, read/cancel available`,
      );
    }
    console.log('trading tradability integration ok: 8 scenarios');
  } finally {
    await prisma.onModuleDestroy();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
