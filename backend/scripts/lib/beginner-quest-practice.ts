/** Test-only real financial practice. Never imported by application code. */
// Calendar fixture before any service (see the fixture): the stock practice
// opens its own KRX/US windows and puts the caller's back.
import { tradingSessions } from '../../test/support/trading-session-fixture';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TradingAccountAccessService } from '../../src/trading-accounts/trading-account-access.service';
import { BeginnerQuestsService } from '../../src/trading-accounts/beginner-quests.service';
import { PortfolioValuationService } from '../../src/portfolio/portfolio-valuation.service';
import { GeneralAccountPerformanceService } from '../../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../../src/portfolio/general-external-funding.service';
import {
  OrdersService,
  type OrderRequestBody,
} from '../../src/orders/orders.service';
import { OrderReservationService } from '../../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../../src/orders/limit-order-create.service';
import { LimitOrderCancelService } from '../../src/orders/limit-order-cancel.service';
import { ConditionalService } from '../../src/conditional/conditional.service';
import { ConditionalSellService } from '../../src/conditional/conditional-sell.service';
import { FuturesService } from '../../src/futures/futures.service';
import { FxService } from '../../src/fx/fx.service';
import { TradingAccountWalletTransferService } from '../../src/wallets/trading-account-wallet-transfer.service';
import { BINANCE_FUTURES_SYMBOLS } from '../../src/providers/binance/binance-product-catalog';
import { KOSCOM_PRICE_SOURCE } from '../../src/providers/koscom/koscom.config';
import { usStockPriceSourceName } from '../../src/providers/source-eligibility.policy';

export function practiceServices(db: PrismaService) {
  const access = new TradingAccountAccessService(db);
  const valuation = new PortfolioValuationService(db);
  const performance = new GeneralAccountPerformanceService(
    db,
    valuation,
    new GeneralExternalFundingService(db),
  );
  const reservations = new OrderReservationService();
  const cancel = new LimitOrderCancelService(db, reservations);
  const orders = new OrdersService(
    db,
    undefined,
    new LimitOrderCreateService(db, reservations),
    cancel,
    access,
    performance,
  );
  const futures = new FuturesService(db, access, performance);
  return {
    access,
    performance,
    orders,
    futures,
    quests: new BeginnerQuestsService(db, access, performance),
    fx: new FxService(db, undefined, undefined, access, performance, valuation),
    transfers: new TradingAccountWalletTransferService(db, access, performance),
    conditional: new ConditionalService(db, access, orders, cancel, futures),
    conditionalSell: new ConditionalSellService(db, access, orders),
  };
}

export async function practiceOrder(
  app: ReturnType<typeof practiceServices>,
  userId: string,
  accountId: string,
  body: OrderRequestBody,
) {
  const quote = await app.orders.quoteOrderForTradingAccount(
    userId,
    accountId,
    body,
  );
  return app.orders.createOrderForTradingAccount(userId, accountId, {
    ...body,
    quoteId: quote.data.quoteId,
    idempotencyKey: randomUUID(),
  });
}

/** Callers provide fresh market/FX observations and enabled TEST flags.
 * QUEST 04 is practiced with the whole-position OCO protection (default, the
 * original evidence) or with an independent stop-loss on half the holding
 * (`protection: 'independent'`, the order screen's 손절가/익절가 설정). */
export async function practiceFoundation(
  db: PrismaService,
  userId: string,
  accountId: string,
  assetId: string,
  check: (
    stage: number,
    app: ReturnType<typeof practiceServices>,
  ) => Promise<void> = async () => {},
  options: { protection?: 'oco' | 'independent' } = {},
) {
  const app = practiceServices(db);
  const progress = async () =>
    (await app.quests.getQuestProgress(userId, accountId)).data;
  let p = await progress();
  await check(0, app);
  if (p.quests[0].status !== 'completed') {
    const body = {
      fromCurrency: 'KRW',
      toCurrency: 'USD',
      sourceAmount: '1400000',
    };
    const quote = await app.fx.quoteForTradingAccount(userId, accountId, body);
    await app.fx.executeForTradingAccount(userId, accountId, {
      ...body,
      quoteId: quote.data.quoteId,
      idempotencyKey: randomUUID(),
    });
  }
  await check(1, app);
  p = await progress();
  if (p.quests[1].status !== 'completed') {
    const wallets = await db.cashWallet.findMany({
      where: { tradingAccountId: accountId },
    });
    await app.transfers.transfer(userId, accountId, {
      sourceWalletId: wallets.find(
        (w) => w.walletScope === 'securities' && w.currencyCode === 'USD',
      )!.id,
      destinationWalletId: wallets.find((w) => w.walletScope === 'crypto_spot')!
        .id,
      amount: '200',
      idempotencyKey: randomUUID(),
    });
  }
  await check(2, app);
  const buy = await practiceOrder(app, userId, accountId, {
    assetId,
    side: 'buy',
    orderType: 'market',
    amount: '100',
  });
  assert.equal(buy.data.order.status, 'executed');
  await check(21, app);
  await app.quests.acknowledge(userId, accountId, {
    stepId: 'holdings_reviewed',
    orderId: buy.data.order.orderId,
  });
  await check(3, app);
  const position = await db.position.findFirstOrThrow({
    where: { tradingAccountId: accountId, assetId },
  });
  if (options.protection === 'independent') {
    await app.conditionalSell.create(userId, accountId, {
      kind: 'protection',
      assetId,
      stopLoss: {
        triggerPrice: '80',
        executionType: 'market',
        quantity: position.quantity
          .div(2)
          .toDecimalPlaces(6, 1 /* ROUND_DOWN */)
          .toFixed(6),
      },
      idempotencyKey: randomUUID(),
    });
    await check(4, app);
  } else {
    const protectedResult = await app.conditional.create(userId, accountId, {
      domain: 'spot',
      assetId,
      positionId: position.id,
      idempotencyKey: randomUUID(),
      legs: [
        { kind: 'take_profit', triggerPrice: '120', childOrderType: 'market' },
        { kind: 'stop_loss', triggerPrice: '80', childOrderType: 'market' },
      ],
    });
    await check(4, app);
    await app.conditional.cancelGroup(
      userId,
      accountId,
      (protectedResult as { data: { groupId: string } }).data.groupId,
      { idempotencyKey: randomUUID() },
    );
  }
  // Whatever an automatic exit already sold, the user sells the rest.
  const remaining = await db.position.findFirstOrThrow({
    where: { tradingAccountId: accountId, assetId },
  });
  await practiceOrder(app, userId, accountId, {
    assetId,
    side: 'sell',
    orderType: 'market',
    quantity: remaining.quantity.toFixed(8),
  });
  await check(5, app);
  const limit = await practiceOrder(app, userId, accountId, {
    assetId,
    side: 'buy',
    orderType: 'limit',
    amount: '90',
    limitPrice: '90',
  });
  assert.equal(limit.data.order.status, 'submitted');
  await check(51, app);
  await app.orders.cancelOrderForTradingAccount(
    userId,
    accountId,
    limit.data.order.orderId,
  );
  await check(52, app);
  await app.quests.acknowledge(userId, accountId, {
    stepId: 'limit_result_reviewed',
    orderId: limit.data.order.orderId,
  });
  await check(6, app);
  assert.equal((await progress()).learningAccess.allTrading, true);
  return {
    app,
    buyId: buy.data.order.orderId,
    limitId: limit.data.order.orderId,
  };
}

/**
 * QUEST 07–10 after QUEST 06, with real commands (B차, 2026-10-18: every
 * quest opens the ordinary trading): one Korean and one US stock market BUY,
 * then a 2x Long and a 2x Short each opened and fully closed by the user on a
 * Futures catalog contract no other row in the database uses. Every asset it
 * creates is named `learning-fixture:<account>` for the cleanup below. The
 * caller's runner must import the session fixture before its services (this
 * module does so first); its windows and Futures mode are put back after.
 */
export async function practiceMarkets(
  db: PrismaService,
  userId: string,
  accountId: string,
) {
  const app = practiceServices(db);
  const name = `learning-fixture:${accountId}`;
  const clock = async () =>
    (
      await db.$queryRaw<
        Array<{ now: Date }>
      >`SELECT clock_timestamp() AS "now"`
    )[0].now;
  const sessions = tradingSessions.save();
  const futuresMode = process.env.FUTURES_TRADING_MODE;
  process.env.FUTURES_TRADING_MODE = 'ENABLED';
  try {
    // Prices two seconds old (fresh: quote 60 s, execution 10 s) are never
    // "future" if a host clock steps back by a second or so meanwhile.
    let at = new Date((await clock()).getTime() - 2000);
    tradingSessions.set(at, new Date(at.getTime() + 86_400_000), ['KRX', 'US']);
    // Securities USD for the US BUY and the Futures funding: a caller may have
    // moved it all to Spot after QUEST 01·02. Exchange stays open (QUEST 01).
    const securitiesUsd = await db.cashWallet.findUniqueOrThrow({
      where: {
        tradingAccountId_walletScope_currencyCode: {
          tradingAccountId: accountId,
          walletScope: 'securities',
          currencyCode: 'USD',
        },
      },
    });
    if (securitiesUsd.balanceAmount.sub(securitiesUsd.reservedAmount).lt(400)) {
      const body = {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '700000',
      };
      const quote = await app.fx.quoteForTradingAccount(
        userId,
        accountId,
        body,
      );
      await app.fx.executeForTradingAccount(userId, accountId, {
        ...body,
        quoteId: quote.data.quoteId,
        idempotencyKey: randomUUID(),
      });
    }
    for (const [assetType, market, currency, sourceName] of [
      ['domestic_stock', 'KRX', 'KRW', KOSCOM_PRICE_SOURCE],
      ['us_stock', 'NASDAQ', 'USD', usStockPriceSourceName()],
    ] as const) {
      const asset = await db.asset.create({
        data: {
          assetType,
          market,
          symbol: `L${randomUUID().slice(0, 7).toUpperCase()}`,
          name,
          currencyCode: currency,
          priceCurrency: currency,
          settlementCurrency: currency,
        },
      });
      await db.assetPriceSnapshot.create({
        data: {
          assetId: asset.id,
          price: '100',
          currencyCode: currency,
          sourceType: 'provider_api',
          sourceName,
          effectiveAt: at,
          capturedAt: at,
        },
      });
      const bought = await practiceOrder(app, userId, accountId, {
        assetId: asset.id,
        side: 'buy',
        orderType: 'market',
        quantity: '1',
      });
      assert.equal(bought.data.order.status, 'executed');
      // The BUY fill is the evidence; like the foundation, no holding stays.
      const sold = await practiceOrder(app, userId, accountId, {
        assetId: asset.id,
        side: 'sell',
        orderType: 'market',
        quantity: '1',
      });
      assert.equal(sold.data.order.status, 'executed');
    }
    // A catalog contract (the Futures product rule) that nothing else holds.
    const used = new Set(
      (
        await db.asset.findMany({
          where: {
            market: 'BINANCE',
            symbol: { in: [...BINANCE_FUTURES_SYMBOLS] },
          },
          select: { symbol: true },
        })
      ).map((row) => row.symbol),
    );
    const symbol = [...BINANCE_FUTURES_SYMBOLS]
      .reverse()
      .find((value) => !used.has(value));
    assert.ok(symbol, 'No free Futures contract for the learning practice');
    const underlying = await db.asset.create({
      data: {
        symbol,
        name,
        market: 'BINANCE',
        assetType: 'crypto',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
      },
    });
    const instrument = await db.futuresInstrument.create({
      data: {
        underlyingAssetId: underlying.id,
        markVerifiedAt: await clock(),
        markContractJson: {
          symbol,
          pair: symbol,
          baseAsset: symbol.slice(0, -4),
          contractType: 'PERPETUAL',
          status: 'TRADING',
          quoteAsset: 'USDT',
          marginAsset: 'USDT',
          underlyingType: 'COIN',
        },
      },
    });
    const wallets = await db.cashWallet.findMany({
      where: { tradingAccountId: accountId, currencyCode: 'USD' },
    });
    await app.transfers.transfer(userId, accountId, {
      sourceWalletId: wallets.find((w) => w.walletScope === 'securities')!.id,
      destinationWalletId: wallets.find(
        (w) => w.walletScope === 'crypto_futures',
      )!.id,
      amount: '200',
      idempotencyKey: randomUUID(),
    });
    for (const direction of ['long', 'short'] as const) {
      // Two seconds old as above: fresh for Last (10 s) and Mark (5 s).
      at = new Date((await clock()).getTime() - 2000);
      const evidence = {
        instrumentId: instrument.id,
        symbol,
        price: '100',
        effectiveAt: at,
        capturedAt: at,
      };
      await db.futuresLastPriceSnapshot.create({
        data: { ...evidence, source: 'binance_usdm_agg_trade_ws' },
      });
      await db.futuresMarkSnapshot.create({
        data: { ...evidence, source: 'binance_usdm_mark_ws' },
      });
      const body = {
        instrumentId: instrument.id,
        direction,
        marginMode: 'isolated' as const,
        leverage: 2,
        quantity: '1',
      };
      const opened = await app.futures.execute(userId, accountId, {
        ...body,
        operation: 'open',
        idempotencyKey: randomUUID(),
      });
      await app.futures.execute(userId, accountId, {
        ...body,
        positionId: opened.data.position.id,
        operation: 'close',
        idempotencyKey: randomUUID(),
      });
    }
  } finally {
    tradingSessions.restore(sessions);
    if (futuresMode === undefined) delete process.env.FUTURES_TRADING_MODE;
    else process.env.FUTURES_TRADING_MODE = futuresMode;
  }
  const progress = (await app.quests.getQuestProgress(userId, accountId)).data;
  assert.deepEqual(
    progress.quests
      .filter((quest) => quest.status !== 'completed')
      .map((quest) => quest.questId),
    [],
    'every quest is complete',
  );
  assert.equal(progress.learningPermissions.allTrading, true);
}

/** Existing financial regression fixtures exercise a fully learned beginner.
 * Their explicit starting balances are restored after REAL foundation commands;
 * the immutable orders/acknowledgements remain available to the policy reader. */
let preparation: Promise<unknown> = Promise.resolve();
export function prepareLearnedBeginner(
  db: PrismaService,
  userId: string,
  accountId: string,
) {
  const pending = preparation.then(() =>
    prepareLearningFixture(db, userId, accountId),
  );
  preparation = pending.catch(() => undefined);
  return pending;
}
async function prepareLearningFixture(
  db: PrismaService,
  userId: string,
  accountId: string,
) {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('Learning fixture is test-only');
  const saved = await db.cashWallet.findMany({
    where: { tradingAccountId: accountId },
  });
  const flags = {
    limit: process.env.LIMIT_ORDER_ENABLED,
    protection: process.env.CONDITIONAL_ORDERS_ENABLED,
    legacyOco: process.env.LEGACY_OCO_REGISTRATION_ENABLED,
  };
  process.env.LIMIT_ORDER_ENABLED = 'true';
  process.env.CONDITIONAL_ORDERS_ENABLED = 'true';
  // The practiced QUEST 04 fixture is a legacy OCO group (retired for new
  // registrations by default since 2026-10-16; existing evidence still counts).
  process.env.LEGACY_OCO_REGISTRATION_ENABLED = 'true';
  const asset = await db.asset.create({
    data: {
      symbol: `LEARN-${randomUUID()}`,
      name: `learning-fixture:${accountId}`,
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
  });
  const at = new Date(Date.now() - 1000);
  const rate = await db.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate: '1400',
      sourceType: 'provider_api',
      sourceName: 'korea_exim_exchange_rate',
      capturedAt: at,
      effectiveAt: at,
    },
  });
  try {
    await db.assetPriceSnapshot.create({
      data: {
        assetId: asset.id,
        price: '100',
        currencyCode: 'USD',
        sourceType: 'provider_api',
        sourceName: 'binance_spot_ws_ticker',
        effectiveAt: at,
        capturedAt: at,
      },
    });
    await db.cashWallet.updateMany({
      where: { tradingAccountId: accountId },
      data: { reservedAmount: '0' },
    });
    await practiceFoundation(db, userId, accountId, asset.id, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    // Ordinary trading opens only with all ten quests (B차, 2026-10-18).
    await practiceMarkets(db, userId, accountId);
    for (const wallet of saved)
      await db.cashWallet.update({
        where: { id: wallet.id },
        data: {
          balanceAmount: wallet.balanceAmount,
          reservedAmount: wallet.reservedAmount,
        },
      });
  } finally {
    if (flags.limit === undefined) delete process.env.LIMIT_ORDER_ENABLED;
    else process.env.LIMIT_ORDER_ENABLED = flags.limit;
    if (flags.protection === undefined)
      delete process.env.CONDITIONAL_ORDERS_ENABLED;
    else process.env.CONDITIONAL_ORDERS_ENABLED = flags.protection;
    if (flags.legacyOco === undefined)
      delete process.env.LEGACY_OCO_REGISTRATION_ENABLED;
    else process.env.LEGACY_OCO_REGISTRATION_ENABLED = flags.legacyOco;
    // Keep the rate while ExchangeTransaction references it; cleanup below owns it.
  }
  return rate.id;
}

export async function cleanupLearningPractice(
  db: PrismaService,
  accountId: string,
) {
  const assets = await db.asset.findMany({
    where: { name: `learning-fixture:${accountId}` },
    select: { id: true },
  });
  if (!assets.length) return;
  const where = { tradingAccountId: accountId };
  const rates = await db.exchangeTransaction.findMany({
    where,
    select: { fxRateSnapshotId: true },
  });
  await db.beginnerQuestAcknowledgement.deleteMany({ where });
  // The Futures practice: commands, then executions, then positions.
  const contracts = {
    instrument: { underlyingAssetId: { in: assets.map((a) => a.id) } },
  };
  await db.futuresExecuteRequest.deleteMany({
    where: { ...where, execution: contracts },
  });
  await db.futuresExecution.deleteMany({ where: { ...where, ...contracts } });
  await db.futuresPosition.deleteMany({ where: { ...where, ...contracts } });
  await db.conditionalSellOrder.deleteMany({ where });
  await db.protectionChild.deleteMany({ where: { group: where } });
  await db.protectionLeg.deleteMany({ where: { group: where } });
  await db.protectionGroup.deleteMany({ where });
  await db.protectionCommand.deleteMany({ where });
  await db.order.deleteMany({
    where: { ...where, assetId: { in: assets.map((a) => a.id) } },
  });
  await db.position.deleteMany({
    where: { ...where, assetId: { in: assets.map((a) => a.id) } },
  });
  // Quote rows retain their asset FK until the account's ordinary cleanup runs.
  return {
    assetIds: assets.map((a) => a.id),
    rateIds: rates
      .map((r) => r.fxRateSnapshotId)
      .filter((id): id is string => !!id),
  };
}

export async function releaseLearningAssets(
  db: PrismaService,
  learning: Awaited<ReturnType<typeof cleanupLearningPractice>>,
) {
  if (!learning) return;
  const contracts = {
    instrument: { underlyingAssetId: { in: learning.assetIds } },
  };
  await db.futuresLastPriceSnapshot.deleteMany({ where: contracts });
  await db.futuresMarkSnapshot.deleteMany({ where: contracts });
  await db.futuresInstrument.deleteMany({
    where: { underlyingAssetId: { in: learning.assetIds } },
  });
  await db.assetPriceSnapshot.deleteMany({
    where: { assetId: { in: learning.assetIds } },
  });
  await db.asset.deleteMany({ where: { id: { in: learning.assetIds } } });
  await db.fxRateSnapshot.deleteMany({
    where: {
      id: { in: learning.rateIds },
      exchangeTransactions: { none: {} },
      orders: { none: {} },
      quotes: { none: {} },
    },
  });
}
