import { TradingAccountWalletTransferService } from '../src/wallets/trading-account-wallet-transfer.service';
import { zeroCryptoCashWalletData } from '../src/wallets/canonical-cash-wallets';
import { tradingSessions } from '../test/support/trading-session-fixture';
/** Order input policy against an isolated PostgreSQL DB; real services and money writes. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, TradingAccountMode } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { OrdersService } from '../src/orders/orders.service';
import { FxService } from '../src/fx/fx.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { LimitOrderExecutionService } from '../src/orders/limit-order-execution.service';
import { LimitOrderCandleEvidenceService } from '../src/orders/limit-order-candle-evidence.service';
import { LimitOrderCandidateRepository } from '../src/orders/limit-order-candidate.repository';
import { LimitOrderMatchingService } from '../src/orders/limit-order-matching.service';
import {
  resetMarketSessionOverrideStoreForTest,
  markMarketSessionOverrideStoreRequired,
} from '../src/orders/market-calendar/market-session-override.store';

const prisma = new PrismaService();
const access = new TradingAccountAccessService(prisma);
const valuation = new PortfolioValuationService(prisma);
const performance = new GeneralAccountPerformanceService(
  prisma,
  valuation,
  new GeneralExternalFundingService(prisma),
);
const general = new GeneralAccountsService(prisma, performance);
const reservation = new OrderReservationService();
const cancel = new LimitOrderCancelService(prisma, reservation);
const orders = new OrdersService(
  prisma,
  undefined,
  new LimitOrderCreateService(prisma, reservation),
  cancel,
  access,
  performance,
);
const fx = new FxService(
  prisma,
  undefined,
  undefined,
  access,
  performance,
  valuation,
);
const candles = new LimitOrderCandleEvidenceService(prisma);
const execution = new LimitOrderExecutionService(
  prisma,
  candles,
  orders,
  performance,
);
const matcher = new LimitOrderMatchingService(
  prisma,
  new LimitOrderCandidateRepository(prisma),
  candles,
  execution,
);
const FEE = '0.001000';
const modes = [
  TradingAccountMode.season,
  TradingAccountMode.general,
  TradingAccountMode.beginner,
] as const;

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
function setSession(now: Date) {
  tradingSessions.set(now, undefined, ['KRX', 'US']);
}

async function fixture(
  mode: TradingAccountMode,
  assetType: 'crypto' | 'domestic_stock' | 'us_stock' = 'crypto',
) {
  const now = await dbNow();
  setSession(now);
  const user = await prisma.user.create({
    data: {
      email: `order-input-${randomUUID()}@example.com`,
      passwordHash: 'test-only',
      nickname: `input-${randomUUID().slice(0, 8)}`,
    },
  });
  const season =
    mode === 'season'
      ? await prisma.season.create({
          data: {
            name: `order-input-${randomUUID()}`,
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
    : (
        await (mode === 'beginner'
          ? general.openBeginnerAccount(user.id)
          : general.openGeneralAccount(user.id))
      ).data.account.id;
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
        ...zeroCryptoCashWalletData(accountId),
      ],
    });
  const asset = await prisma.asset.create({
    data: {
      symbol: `T${randomUUID().slice(0, 20)}`,
      name: 'transaction time fixture',
      isActive: true,
      assetType,
      market:
        assetType === 'domestic_stock'
          ? 'KRX'
          : assetType === 'us_stock'
            ? 'NAS'
            : 'BINANCE',
      currencyCode: assetType === 'domestic_stock' ? 'KRW' : 'USD',
      priceCurrency: assetType === 'domestic_stock' ? 'KRW' : 'USD',
      settlementCurrency: assetType === 'domestic_stock' ? 'KRW' : 'USD',
    },
  });
  const price = await prisma.assetPriceSnapshot.create({
    data: {
      assetId: asset.id,
      price: '100',
      currencyCode: asset.currencyCode,
      sourceType: 'provider_api',
      sourceName:
        assetType === 'domestic_stock'
          ? 'koscom_krx_realtime_price'
          : assetType === 'us_stock'
            ? 'kis_us_delayed_trade'
            : 'binance_spot_ws_ticker',
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
  if (asset.assetType === 'crypto') {
    const usd = await prisma.cashWallet.findUniqueOrThrow({
      where: {
        tradingAccountId_walletScope_currencyCode: {
          tradingAccountId: accountId,
          walletScope: 'securities',
          currencyCode: 'USD',
        },
      },
    });
    const spot = await prisma.cashWallet.findUniqueOrThrow({
      where: {
        tradingAccountId_walletScope_currencyCode: {
          tradingAccountId: accountId,
          walletScope: 'crypto_spot',
          currencyCode: 'USD',
        },
      },
    });
    await new TradingAccountWalletTransferService(
      prisma,
      access,
      performance,
    ).transfer(user.id, accountId, {
      sourceWalletId: usd.id,
      destinationWalletId: spot.id,
      amount: usd.balanceAmount.toFixed(8),
      idempotencyKey: randomUUID(),
    });
  }
  return s;
}
type Scenario = Awaited<ReturnType<typeof fixture>>;
async function cleanup(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  await prisma.walletTransaction.deleteMany({ where });
  await prisma.walletTransfer.deleteMany({ where });
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
  await prisma.limitOrderCandleEvidence.deleteMany({
    where: { assetId: s.asset.id },
  });
  await prisma.marketCandle.deleteMany({ where: { assetId: s.asset.id } });
  await prisma.assetPriceSnapshot.deleteMany({
    where: { assetId: s.asset.id },
  });
  await prisma.asset.delete({ where: { id: s.asset.id } });
  await prisma.fxRateSnapshot.delete({ where: { id: s.rate.id } });
  await prisma.user.delete({ where: { id: s.userId } });
  resetMarketSessionOverrideStoreForTest();
}
async function fxBody(s: { userId: string; accountId: string }) {
  const quoted = await fx.quoteForTradingAccount(s.userId, s.accountId, {
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '1400000',
  });
  assert.ok(quoted.data.quoteId);
  return {
    quoteId: quoted.data.quoteId,
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '1400000',
    idempotencyKey: randomUUID(),
  };
}

process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.GENERAL_TRADE_FEE_RATE = FEE;
const d = (v: string | number) => new Prisma.Decimal(v);
async function request(s: Scenario, payload: Record<string, unknown>) {
  const body = { assetId: s.asset.id, ...payload };
  const quote = await orders.quoteOrderForTradingAccount(
    s.userId,
    s.accountId,
    body,
  );
  return {
    quote: quote.data,
    body: {
      ...body,
      quoteId: quote.data.quoteId,
      idempotencyKey: randomUUID(),
    },
  };
}
const create = (s: Scenario, body: Record<string, unknown>) =>
  orders.createOrderForTradingAccount(s.userId, s.accountId, body);
const wallet = (s: Scenario) =>
  prisma.cashWallet.findUniqueOrThrow({
    where: {
      tradingAccountId_walletScope_currencyCode: {
        walletScope:
          s.asset.assetType === 'crypto' ? 'crypto_spot' : 'securities',
        tradingAccountId: s.accountId,
        currencyCode: s.asset.currencyCode,
      },
    },
  });
const position = (s: Scenario) =>
  prisma.position.findUniqueOrThrow({
    where: {
      tradingAccountId_assetId: {
        tradingAccountId: s.accountId,
        assetId: s.asset.id,
      },
    },
  });
async function refresh(s: Scenario, price = '100', effectiveAt?: Date) {
  const now = await dbNow();
  await prisma.fxRateSnapshot.update({
    where: { id: s.rate.id },
    data: { effectiveAt: now, capturedAt: now },
  });
  return prisma.assetPriceSnapshot.update({
    where: { id: s.price.id },
    data: { price, effectiveAt: effectiveAt ?? now, capturedAt: now },
  });
}
function closed(s: Scenario) {
  const now = new Date();
  tradingSessions.set(now, now, [
    s.asset.assetType === 'us_stock' ? 'US' : 'KRX',
  ]);
}

async function assertMarketAccounting(
  s: Scenario,
  result: Awaited<ReturnType<typeof create>>,
  before: Prisma.Decimal,
  amount: string,
) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: result.data.order.orderId },
  });
  assert.equal(order.status, 'executed');
  assert.ok(order.grossAmount!.lte(amount));
  assert.ok(
    d(amount).sub(order.grossAmount!).lt(order.executedPrice!.mul('0.000001')),
  );
  assert.ok(
    order.grossAmount!.eq(
      order.quantity.mul(order.executedPrice!).toDecimalPlaces(8),
    ),
  );
  assert.ok(before.sub((await wallet(s)).balanceAmount).eq(order.netAmount!));
  assert.ok((await position(s)).quantity.eq(order.quantity));
  const ledger = await prisma.walletTransaction.findFirstOrThrow({
    where: { referenceId: order.id },
  });
  assert.ok(ledger.amount.eq(order.netAmount!));
  assert.ok(order.netAmount!.eq(order.grossAmount!.add(order.feeAmount!)));
}
async function cryptoAmount(mode: TradingAccountMode) {
  const s = await fixture(mode);
  try {
    const before = await wallet(s);
    const q = await request(s, { side: 'buy', amount: '100' });
    assert.equal(q.quote.amount, '100.00000000');
    assert.equal(q.quote.quantity, '1.000000');
    assert.equal(q.quote.feeAmount, '0.10000000');
    const stored = await prisma.quote.findUniqueOrThrow({
      where: { id: q.quote.quoteId! },
    });
    assert.ok(stored.sourceAmount!.eq(100));
    await rejected(create(s, { ...q.body, amount: '101' }), 'QUOTE_MISMATCH');
    await rejected(
      create(s, { ...q.body, quantity: '1' }),
      'INVALID_ORDER_INPUT',
    );
    assert.ok((await wallet(s)).balanceAmount.eq(before.balanceAmount));
    await refresh(s, '100.2');
    const result = await create(s, q.body);
    assert.equal(result.data.order.quantity, '0.998003');
    await assertMarketAccounting(s, result, before.balanceAmount, '100');
    const frozen = await wallet(s);
    await prisma.tradingAccount.update({
      where: { id: s.accountId },
      data: { status: 'suspended' },
    });
    const replay = await create(s, { ...q.body, amount: '100.00000000' });
    assert.equal(replay.data.order.orderId, result.data.order.orderId);
    await rejected(
      create(s, { ...q.body, amount: '101' }),
      'ORDER_IDEMPOTENCY_CONFLICT',
    );
    assert.ok((await wallet(s)).balanceAmount.eq(frozen.balanceAmount));
    assert.equal(
      await prisma.walletTransaction.count({
        where: { referenceId: result.data.order.orderId },
      }),
      1,
    );
    await prisma.tradingAccount.update({
      where: { id: s.accountId },
      data: { status: 'active' },
    });
    const reprice = await request(s, { side: 'buy', amount: '100' });
    await refresh(s, '101');
    await rejected(create(s, reprice.body), 'RATE_CHANGED_REQUOTE_REQUIRED');
    assert.ok((await wallet(s)).balanceAmount.eq(frozen.balanceAmount));

    const limit = await request(s, {
      side: 'buy',
      orderType: 'limit',
      amount: '100',
      limitPrice: '700',
    });
    assert.equal(limit.quote.quantity, '0.142857');
    assert.ok(d(limit.quote.grossAmount).lte(100));
    const beforeLimit = await wallet(s);
    const registered = await create(s, limit.body);
    const afterLimit = await wallet(s);
    assert.equal(registered.data.order.status, 'submitted');
    assert.ok(afterLimit.balanceAmount.eq(beforeLimit.balanceAmount));
    assert.ok(
      afterLimit.reservedAmount
        .sub(beforeLimit.reservedAmount)
        .eq(limit.quote.reservedAmount!),
    );
    // Existing snapshot is cheap enough but predates this order.
    const old = await execution.fillLimitOrder({
      orderId: registered.data.order.orderId,
      plan: {
        path: 'snapshot',
        executedPrice: d('101'),
        assetPriceSnapshotId: s.price.id,
      },
    });
    assert.equal(old.state, 'skipped');
    const posBefore = await position(s);
    await refresh(s, '600');
    const filled = await execution.fillLimitOrder({
      orderId: registered.data.order.orderId,
      plan: {
        path: 'snapshot',
        executedPrice: d('600'),
        assetPriceSnapshotId: s.price.id,
      },
    });
    assert.equal(filled.state, 'filled');
    const actual = await prisma.order.findUniqueOrThrow({
      where: { id: registered.data.order.orderId },
    });
    assert.ok(actual.quantity.eq('0.142857'));
    assert.ok(actual.grossAmount!.eq('85.7142'));
    assert.ok(
      (await position(s)).quantity.sub(posBefore.quantity).eq(actual.quantity),
    );
    assert.ok((await wallet(s)).reservedAmount.eq(beforeLimit.reservedAmount));
    assert.ok(
      beforeLimit.balanceAmount
        .sub((await wallet(s)).balanceAmount)
        .eq(actual.netAmount!),
    );

    // Sell remains quantity based; reserve/cancel never reduces owned quantity.
    await refresh(s, '600');
    const sell = await request(s, {
      side: 'sell',
      orderType: 'limit',
      quantity: '0.01',
      limitPrice: '600',
    });
    const owned = await position(s);
    const submitted = await create(s, sell.body);
    const reserved = await position(s);
    assert.ok(reserved.quantity.eq(owned.quantity));
    assert.ok(reserved.reservedQuantity.sub(owned.reservedQuantity).eq('0.01'));
    await orders.cancelOrderForTradingAccount(
      s.userId,
      s.accountId,
      submitted.data.order.orderId,
    );
    assert.ok((await position(s)).reservedQuantity.eq(owned.reservedQuantity));
    const marketSell = await request(s, { side: 'sell', quantity: '0.01' });
    await create(s, marketSell.body);
    assert.ok((await position(s)).quantity.eq(owned.quantity.sub('0.01')));
    console.log(
      `PASS ${mode}: amount intent, repricing, replay, accounting, limit improvement, fractional sell`,
    );
  } finally {
    await cleanup(s);
  }
}
async function stockPolicy(
  mode: TradingAccountMode,
  assetType: 'domestic_stock' | 'us_stock',
) {
  const s = await fixture(mode, assetType);
  try {
    await refresh(s);
    for (const quantity of ['1', '0.5']) {
      for (const side of ['buy', 'sell']) {
        const q = await request(s, { side, quantity });
        const r = await create(s, q.body);
        assert.equal(r.data.order.quantity, d(quantity).toFixed(6));
      }
    }
    const seed = await request(s, { side: 'buy', quantity: '5' });
    await create(s, seed.body);
    for (const side of ['buy', 'sell']) {
      await rejected(
        request(s, {
          side,
          orderType: 'limit',
          quantity: '0.5',
          limitPrice: '100',
        }),
        'FRACTIONAL_LIMIT_ORDER_NOT_SUPPORTED',
      );
      closed(s);
      await rejected(request(s, { side, quantity: '1' }), 'MARKET_CLOSED');
      const q = await request(s, {
        side,
        orderType: 'limit',
        quantity: '1.000000',
        limitPrice: '100',
      });
      await rejected(
        create(s, { ...q.body, quantity: '0.5' }),
        'FRACTIONAL_LIMIT_ORDER_NOT_SUPPORTED',
      );
      const before = await wallet(s);
      const held = await position(s);
      // CLOSED -> OPEN create succeeds, then cancel releases exactly once.
      setSession(await dbNow());
      const r = await create(s, q.body);
      assert.equal(r.data.order.status, 'submitted');
      assert.ok((await wallet(s)).balanceAmount.eq(before.balanceAmount));
      assert.ok((await position(s)).quantity.eq(held.quantity));
      await orders.cancelOrderForTradingAccount(
        s.userId,
        s.accountId,
        r.data.order.orderId,
      );
      assert.ok((await wallet(s)).reservedAmount.eq(before.reservedAmount));
      assert.ok((await position(s)).reservedQuantity.eq(held.reservedQuantity));
      // OPEN -> CLOSED limit create also succeeds; market does not.
      const l = await request(s, {
        side,
        orderType: 'limit',
        quantity: '1',
        limitPrice: '100',
      });
      const m = await request(s, { side, quantity: '0.5' });
      closed(s);
      await rejected(create(s, m.body), 'MARKET_CLOSED');
      const waiting = await create(s, l.body);
      const skipped = await execution.fillLimitOrder({
        orderId: waiting.data.order.orderId,
        plan: {
          path: 'snapshot',
          executedPrice: d('100'),
          assetPriceSnapshotId: s.price.id,
        },
      });
      assert.equal(skipped.state, 'skipped');
      setSession(await dbNow());
      const old = await execution.fillLimitOrder({
        orderId: waiting.data.order.orderId,
        plan: {
          path: 'snapshot',
          executedPrice: d('100'),
          assetPriceSnapshotId: s.price.id,
        },
      });
      assert.equal(old.state, 'skipped');
      await refresh(s, '100', new Date(Date.now() + 60000));
      const future = await execution.fillLimitOrder({
        orderId: waiting.data.order.orderId,
        plan: {
          path: 'snapshot',
          executedPrice: d('100'),
          assetPriceSnapshotId: s.price.id,
        },
      });
      assert.equal(future.state, 'skipped');
      await refresh(s);
      const matched = await matcher.matchDueLimitOrders({
        now: await dbNow(),
        batchSize: 10,
      });
      assert.equal(matched.filledPathA, 1);
      assert.equal(
        (
          await prisma.order.findUniqueOrThrow({
            where: { id: waiting.data.order.orderId },
          })
        ).status,
        'executed',
      );
      const beforeUnavailable: Awaited<ReturnType<typeof request>>[] = [];
      for (const orderType of ['market', 'limit'])
        beforeUnavailable.push(
          await request(s, {
            side,
            orderType,
            quantity: '1',
            ...(orderType === 'limit' ? { limitPrice: '100' } : {}),
          }),
        );
      resetMarketSessionOverrideStoreForTest();
      markMarketSessionOverrideStoreRequired();
      for (const pending of beforeUnavailable)
        await rejected(create(s, pending.body), 'MARKET_CALENDAR_UNAVAILABLE');
      for (const orderType of ['market', 'limit']) {
        await rejected(
          request(s, {
            side,
            orderType,
            quantity: '1',
            ...(orderType === 'limit' ? { limitPrice: '100' } : {}),
          }),
          'MARKET_CALENDAR_UNAVAILABLE',
        );
      }
      resetMarketSessionOverrideStoreForTest();
      setSession(await dbNow());
    }
    // A closed candle formed before registration never authorizes the new order.
    closed(s);
    const historical = await request(s, {
      side: 'buy',
      orderType: 'limit',
      quantity: '1',
      limitPrice: '100',
    });
    const waiting = await create(s, historical.body);
    const now = await dbNow();
    const openTime = new Date(
      Math.floor(now.getTime() / 300000) * 300000 - 300000,
    );
    const closeTime = new Date(openTime.getTime() + 300000);
    setSession(now);
    const candle = await prisma.marketCandle.create({
      data: {
        assetId: s.asset.id,
        interval: '5m',
        openTime,
        closeTime,
        open: '100',
        high: '110',
        low: '90',
        close: '100',
        volume: '1',
        isClosed: true,
        sourceProvider: 'kis',
        sourceUpdatedAt: closeTime,
        updatedAt: closeTime,
      },
    });
    const eligible = await candles.findEligibleClosedCandlesForAsset(
      s.asset,
      now,
      3600000,
    );
    const evidence = eligible.find((row) => row.marketCandleId === candle.id)!;
    assert.ok(evidence);
    const plan = {
      path: 'candle' as const,
      executedPrice: d('100'),
      candle: evidence,
    };
    assert.equal(
      (
        await execution.fillLimitOrder({
          orderId: waiting.data.order.orderId,
          plan,
        })
      ).state,
      'skipped',
    );
    // Represent an order submitted the previous evening, awaiting this next
    // regular session. Only fixture time changes; fill remains the real DB core.
    await prisma.order.update({
      where: { id: waiting.data.order.orderId },
      data: { submittedAt: new Date(openTime.getTime() - 86400000) },
    });
    resetMarketSessionOverrideStoreForTest();
    markMarketSessionOverrideStoreRequired();
    assert.equal(
      (
        await execution.fillLimitOrder({
          orderId: waiting.data.order.orderId,
          plan,
        })
      ).state,
      'skipped',
    );
    resetMarketSessionOverrideStoreForTest();
    setSession(now);
    for (const field of ['sourceUpdatedAt', 'finalizedAt'] as const) {
      assert.equal(
        (
          await execution.fillLimitOrder({
            orderId: waiting.data.order.orderId,
            plan: {
              ...plan,
              candle: { ...evidence, [field]: new Date(Date.now() + 60000) },
            },
          })
        ).state,
        'skipped',
      );
    }
    assert.equal(
      (
        await execution.fillLimitOrder({
          orderId: waiting.data.order.orderId,
          plan,
        })
      ).state,
      'filled',
    );
    assert.ok((await wallet(s)).reservedAmount.eq(0));
    console.log(
      `PASS ${mode} ${assetType}: stock fractional market, integer limit CLOSED registration, session transitions, evidence guards and matcher Path A/B`,
    );
  } finally {
    await cleanup(s);
  }
}
async function main() {
  await prisma.$connect();
  try {
    for (const mode of modes) {
      await cryptoAmount(mode);
      await stockPolicy(mode, 'domestic_stock');
      await stockPolicy(mode, 'us_stock');
    }
    console.log('order input policy db integration ok');
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
