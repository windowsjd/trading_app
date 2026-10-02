/** Actual market create/execute and limit fill transactions with closed KRX holdings. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Prisma } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { OrdersService } from '../src/orders/orders.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { LimitOrderExecutionService } from '../src/orders/limit-order-execution.service';
import { LimitOrderCandleEvidenceService } from '../src/orders/limit-order-candle-evidence.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { resolveStockMarketSessionState } from '../src/orders/market-calendar.policy';
import {
  applyMarketSessionOverrideSnapshot,
  markMarketSessionOverrideStoreRequired,
  resetMarketSessionOverrideStoreForTest,
} from '../src/orders/market-calendar/market-session-override.store';

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
  'Use a disposable local PostgreSQL database.',
);
process.env.LIMIT_ORDER_ENABLED = 'true';
const prisma = new PrismaService();
const valuation = new PortfolioValuationService(prisma);
const orders = new OrdersService(
  prisma,
  undefined,
  new LimitOrderCreateService(prisma, new OrderReservationService()),
  undefined,
  new TradingAccountAccessService(prisma),
);
const execution = new LimitOrderExecutionService(
  prisma,
  new LimitOrderCandleEvidenceService(prisma),
  orders,
);
const users: string[] = [];
const seasons: string[] = [];
const assets: string[] = [];
const fxIds: string[] = [];

async function dbNow() {
  const rows = await prisma.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS now`;
  return rows[0].now;
}

async function fixture() {
  resetMarketSessionOverrideStoreForTest();
  const now = await dbNow();
  // Close today's KRX through the existing calendar override, retaining the
  // real latest completed session and real post-lock DB execution clock.
  applyMarketSessionOverrideSnapshot(
    [
      {
        market: 'KRX',
        localDate: new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Seoul',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(now),
        overrideType: 'closed',
        openTime: null,
        closeTime: null,
        reason: 'closed holding fixture',
      },
    ],
    now,
  );
  const state = resolveStockMarketSessionState(
    { assetType: 'domestic_stock', market: 'KRX' },
    now,
  );
  assert.equal(state?.state, 'closed');
  assert.ok(
    state?.latestCompletedSession,
    'Fixture requires audited calendar coverage.',
  );
  const session = state.latestCompletedSession;
  const user = await prisma.user.create({
    data: {
      email: `order-parity-${randomUUID()}@example.com`,
      nickname: `parity-${randomUUID().slice(0, 8)}`,
      passwordHash: 'test-only',
    },
  });
  users.push(user.id);
  const season = await prisma.season.create({
    data: {
      name: `order-parity-${randomUUID()}`,
      status: 'active',
      startAt: new Date(now.getTime() - 3600000),
      endAt: new Date(now.getTime() + 86400000),
      initialCapitalKrw: '2000000',
      tradeFeeRate: '0.001000',
      fxFeeRate: '0.001000',
    },
  });
  seasons.push(season.id);
  const account = await prisma.tradingAccount.create({
    data: {
      userId: user.id,
      mode: 'season',
      initialCapitalKrw: '2000000',
      openedAt: now,
    },
  });
  const participant = await prisma.seasonParticipant.create({
    data: {
      userId: user.id,
      seasonId: season.id,
      tradingAccountId: account.id,
      participantStatus: 'active',
      joinedAt: now,
      initialCapitalKrw: '2000000',
      totalAssetKrw: '2000000',
      totalReturnRate: '0',
      maxDrawdown: '0',
    },
  });
  await prisma.cashWallet.createMany({
    data: [
      {
        tradingAccountId: account.id,
        currencyCode: 'KRW',
        balanceAmount: '917000',
      },
      {
        tradingAccountId: account.id,
        currencyCode: 'USD',
        balanceAmount: '1000',
      },
    ],
  });
  const stock = await prisma.asset.create({
    data: {
      symbol: `KRX-${randomUUID()}`,
      name: 'Closed stock A',
      assetType: 'domestic_stock',
      market: 'KRX',
      currencyCode: 'KRW',
      priceCurrency: 'KRW',
      settlementCurrency: 'KRW',
    },
  });
  assets.push(stock.id);
  const crypto = await prisma.asset.create({
    data: {
      symbol: `B-${randomUUID()}`,
      name: 'Crypto B',
      assetType: 'crypto',
      market: 'BINANCE',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
  });
  assets.push(crypto.id);
  await prisma.position.create({
    data: {
      tradingAccountId: account.id,
      assetId: stock.id,
      quantity: '2',
      averageCost: '100000',
      currencyCode: 'KRW',
      currentPriceLocal: '191500',
      currentPriceKrw: '191500',
      marketValueLocal: '383000',
      marketValueKrw: '383000',
    },
  });
  const rate = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate: '1000',
      sourceType: 'provider_api',
      sourceName: 'korea_exim_exchange_rate',
      effectiveAt: now,
      capturedAt: now,
    },
  });
  fxIds.push(rate.id);
  await prisma.assetPriceSnapshot.create({
    data: {
      assetId: crypto.id,
      price: '100',
      currencyCode: 'USD',
      sourceType: 'provider_api',
      sourceName: 'binance_spot_ws_ticker',
      effectiveAt: now,
      capturedAt: now,
    },
  });
  return {
    userId: user.id,
    accountId: account.id,
    participantId: participant.id,
    stockId: stock.id,
    cryptoId: crypto.id,
    session,
    now,
  };
}
type Scenario = Awaited<ReturnType<typeof fixture>>;

async function stockPrice(
  s: Scenario,
  price: string,
  effectiveAt: Date,
  sourceType: 'provider_api' | 'admin_manual',
  sourceName = 'kis_krx_realtime_trade',
) {
  return prisma.assetPriceSnapshot.create({
    data: {
      assetId: s.stockId,
      price,
      currencyCode: 'KRW',
      sourceType,
      sourceName,
      effectiveAt,
      // Late receipt of a closing observation remains eligible by effectiveAt.
      capturedAt: new Date(effectiveAt.getTime() + 2000),
    },
  });
}

async function financialState(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  return JSON.stringify({
    wallets: await prisma.cashWallet.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    positions: await prisma.position.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    ledger: await prisma.walletTransaction.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    orders: await prisma.order.findMany({ where, orderBy: { id: 'asc' } }),
    quotes: await prisma.quote.findMany({ where, orderBy: { id: 'asc' } }),
    snapshots: await prisma.equitySnapshot.findMany({
      where,
      orderBy: { id: 'asc' },
    }),
    participant: await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: s.participantId },
    }),
  });
}

async function runScenario(
  kind: 'market' | 'limit',
  policy: 'provider' | 'noise' | 'admin' | 'outside' | 'calendar',
) {
  const s = await fixture();
  let selectedId: string | undefined;
  if (['provider', 'noise', 'calendar'].includes(policy)) {
    selectedId = (
      await stockPrice(s, '248500', s.session.closeTime, 'provider_api')
    ).id;
  }
  if (policy === 'admin' || policy === 'calendar') {
    const manual = await stockPrice(
      s,
      '248500',
      s.session.closeTime,
      'admin_manual',
      'operator',
    );
    if (policy === 'admin') selectedId = manual.id;
  }
  await stockPrice(
    s,
    '191500',
    new Date(s.session.openTime.getTime() - 86400000),
    'admin_manual',
    'operator',
  );
  await stockPrice(
    s,
    '999999',
    new Date(s.session.closeTime.getTime() + 3600000),
    'admin_manual',
    'operator',
  );
  await stockPrice(s, '0', s.session.closeTime, 'provider_api');
  await stockPrice(
    s,
    '999999',
    s.session.closeTime,
    'provider_api',
    'wrong_source',
  );
  if (policy !== 'provider') {
    for (let i = 1; i <= 25; i++) {
      await stockPrice(
        s,
        '999999',
        new Date(s.session.closeTime.getTime() + i * 60000),
        'provider_api',
      );
    }
  }
  const body = {
    assetId: s.cryptoId,
    side: 'buy',
    orderType: kind,
    amount: '200',
    ...(kind === 'limit' ? { limitPrice: '100' } : {}),
  };
  const quote = await orders.quoteOrderForTradingAccount(
    s.userId,
    s.accountId,
    body,
  );
  assert.ok(quote.data.quoteId);
  const request = {
    ...body,
    quoteId: quote.data.quoteId,
    idempotencyKey: randomUUID(),
  };
  let orderId: string | undefined;
  let fillPriceId: string | undefined;
  if (kind === 'limit') {
    const created = await orders.createOrderForTradingAccount(
      s.userId,
      s.accountId,
      request,
    );
    orderId = created.data.order.orderId;
    const now = await dbNow();
    fillPriceId = (
      await prisma.assetPriceSnapshot.create({
        data: {
          assetId: s.cryptoId,
          price: '100',
          currencyCode: 'USD',
          sourceType: 'provider_api',
          sourceName: 'binance_spot_ws_ticker',
          effectiveAt: now,
          capturedAt: now,
        },
      })
    ).id;
  }
  if (policy === 'calendar') {
    resetMarketSessionOverrideStoreForTest();
    markMarketSessionOverrideStoreRequired();
  }
  const before = await financialState(s);
  const perform = () =>
    kind === 'market'
      ? orders.createOrderForTradingAccount(s.userId, s.accountId, request)
      : execution.fillLimitOrder({
          orderId: orderId!,
          plan: {
            path: 'snapshot',
            executedPrice: new Prisma.Decimal('100'),
            assetPriceSnapshotId: fillPriceId!,
          },
        });

  if (policy === 'outside' || policy === 'calendar') {
    await assert.rejects(perform(), (error: unknown) => {
      assert.ok(error instanceof HttpException);
      assert.equal(
        (error.getResponse() as { error: { code: string } }).error.code,
        'ASSET_PRICE_UNAVAILABLE',
      );
      return true;
    });
    assert.equal(
      await financialState(s),
      before,
      `${kind}/${policy}: every financial write and reservation release must roll back`,
    );
    await assert.rejects(
      valuation.calculateTradingAccountValuation(
        s.accountId,
        await dbNow(),
        'live_portfolio_valuation',
      ),
      { code: 'ASSET_PRICE_UNAVAILABLE' },
    );
    if (kind === 'limit') {
      const wallet = await prisma.cashWallet.findUniqueOrThrow({
        where: {
          tradingAccountId_currencyCode: {
            tradingAccountId: s.accountId,
            currencyCode: 'USD',
          },
        },
      });
      assert.equal(wallet.reservedAmount.toFixed(8), '200.20000000');
      assert.equal(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } }))
          .reservationReleasedAt,
        null,
      );
    }
  } else {
    const result = await perform();
    if ('state' in result) assert.equal(result.state, 'filled');
    const order = await prisma.order.findUniqueOrThrow({
      where: {
        tradingAccountId_idempotencyKey: {
          tradingAccountId: s.accountId,
          idempotencyKey: request.idempotencyKey,
        },
      },
    });
    assert.equal(order.status, 'executed');
    assert.equal(order.executedPrice?.toFixed(8), '100.00000000');
    assert.equal(order.quantity.toFixed(8), '2.00000000');
    assert.equal(order.netAmount?.toFixed(8), '200.20000000');
    assert.ok(order.executedAt);
    if (kind === 'limit') assert.ok(order.reservationReleasedAt);
    const common = await valuation.calculateTradingAccountValuation(
      s.accountId,
      order.executedAt,
      'live_portfolio_valuation',
    );
    const stockDecision = common.assetPriceSourceDecisions.find(
      (row) => row.assetId === s.stockId,
    )?.sourceDecision;
    assert.equal(stockDecision?.selectedSnapshotId, selectedId);
    assert.equal(
      stockDecision?.selectedSourceType,
      policy === 'admin' ? 'admin_manual' : 'provider_api',
    );
    assert.equal(common.totalAssetKrw, '2413800.00000000');
    const snapshot = await prisma.equitySnapshot.findFirstOrThrow({
      where: {
        tradingAccountId: s.accountId,
        snapshotReason: 'order_executed',
      },
    });
    assert.equal(snapshot.totalAssetKrw.toFixed(8), common.totalAssetKrw);
    assert.equal(snapshot.returnRate.toFixed(8), common.returnRate);
    assert.equal(snapshot.domesticStockValueKrw.toFixed(8), '497000.00000000');
    assert.equal(snapshot.cryptoValueKrw.toFixed(8), '200000.00000000');
    assert.equal(
      snapshot.capturedAt.toISOString(),
      order.executedAt.toISOString(),
    );
    const participant = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: s.participantId },
    });
    assert.equal(participant.totalAssetKrw.toFixed(8), common.totalAssetKrw);
    assert.equal(participant.totalReturnRate.toFixed(8), common.returnRate);
    assert.equal(participant.totalFillCount, 1);
    const stock = await prisma.position.findUniqueOrThrow({
      where: {
        tradingAccountId_assetId: {
          tradingAccountId: s.accountId,
          assetId: s.stockId,
        },
      },
    });
    assert.equal(stock.currentPriceLocal?.toFixed(8), '248500.00000000');
    assert.equal(stock.marketValueKrw?.toFixed(8), '497000.00000000');
    const crypto = await prisma.position.findUniqueOrThrow({
      where: {
        tradingAccountId_assetId: {
          tradingAccountId: s.accountId,
          assetId: s.cryptoId,
        },
      },
    });
    assert.equal(crypto.quantity.toFixed(8), '2.00000000');
    assert.equal(crypto.averageCost.toFixed(8), '100.10000000');
    const wallet = await prisma.cashWallet.findUniqueOrThrow({
      where: {
        tradingAccountId_currencyCode: {
          tradingAccountId: s.accountId,
          currencyCode: 'USD',
        },
      },
    });
    assert.equal(wallet.balanceAmount.toFixed(8), '799.80000000');
    assert.equal(wallet.reservedAmount.toFixed(8), '0.00000000');
    const ledger = await prisma.walletTransaction.findMany({
      where: { tradingAccountId: s.accountId, referenceId: order.id },
    });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amount.toFixed(8), '200.20000000');
    assert.equal(ledger[0].balanceAfter.toFixed(8), '799.80000000');
    assert.equal(
      await prisma.equitySnapshot.count({
        where: { tradingAccountId: s.accountId },
      }),
      1,
    );
  }
  console.log(`passed ${kind}/${policy}`);
}

async function cleanup() {
  const accounts = await prisma.tradingAccount.findMany({
    where: { userId: { in: users } },
    select: { id: true },
  });
  const where = { tradingAccountId: { in: accounts.map((row) => row.id) } };
  await prisma.walletTransaction.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.quote.deleteMany({ where });
  await prisma.position.deleteMany({ where });
  await prisma.equitySnapshot.deleteMany({ where });
  await prisma.cashWallet.deleteMany({ where });
  await prisma.seasonParticipant.deleteMany({
    where: { userId: { in: users } },
  });
  await prisma.tradingAccount.deleteMany({ where: { userId: { in: users } } });
  await prisma.season.deleteMany({ where: { id: { in: seasons } } });
  await prisma.assetPriceSnapshot.deleteMany({
    where: { assetId: { in: assets } },
  });
  await prisma.asset.deleteMany({ where: { id: { in: assets } } });
  await prisma.fxRateSnapshot.deleteMany({ where: { id: { in: fxIds } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
}

async function main() {
  try {
    await prisma.$connect();
    for (const kind of ['market', 'limit'] as const) {
      for (const policy of [
        'provider',
        'noise',
        'admin',
        'outside',
        'calendar',
      ] as const) {
        await runScenario(kind, policy);
      }
    }
    console.log('order closed price parity integration ok: 10 scenarios');
  } finally {
    resetMarketSessionOverrideStoreForTest();
    await cleanup();
    await prisma.$disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
