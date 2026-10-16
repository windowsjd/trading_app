import { tradingSessions } from '../test/support/trading-session-fixture';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  db,
  app,
  fixture,
  now,
  spotPrice,
  price as futuresLastPrice,
  fxEvidence,
  cleanup,
  code,
  holdRowLock,
  untilLockWaiting,
  type Scenario,
} from './futures-integration';
import { Prisma, type FuturesDirection } from '../src/generated/prisma/client';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import {
  OrdersService,
  type OrderRequestBody,
} from '../src/orders/orders.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { LimitOrderExecutionService } from '../src/orders/limit-order-execution.service';
import { LimitOrderCandleEvidenceService } from '../src/orders/limit-order-candle-evidence.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { ConditionalSellService } from '../src/conditional/conditional-sell.service';
import { ConditionalBuyService } from '../src/conditional/conditional-buy.service';
import { ConditionalService } from '../src/conditional/conditional.service';
import { EntryTpSlService } from '../src/conditional/entry-tp-sl.service';
import { endEntryTpSlPlansOfEndedEntries } from '../src/conditional/entry-tp-sl-state';
import { FuturesLimitService } from '../src/futures/futures-limit.service';
import { FuturesConditionalEntryService } from '../src/futures/futures-conditional-entry.service';
import { FuturesTpSlService } from '../src/futures/futures-tp-sl.service';
import { lockSeasonTradingContext } from '../src/seasons/season-trading-lock';

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.INDEPENDENT_TP_SL_DB_INTEGRATION !== '1'
)
  throw new Error('Explicit disposable independent TP/SL PG opt-in required');
process.env.INDEPENDENT_TP_SL_ORDERS_ENABLED = 'true';
process.env.CONDITIONAL_SELL_ORDERS_ENABLED = 'false';
process.env.FUTURES_TP_SL_ORDERS_ENABLED = 'true';
process.env.CONDITIONAL_BUY_ORDERS_ENABLED = 'true';
process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'true';
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED = 'true';
// Existing OCO groups keep executing under this flag; NEW groups are retired
// unless LEGACY_OCO_REGISTRATION_ENABLED (toggled only where a test needs one).
process.env.CONDITIONAL_ORDERS_ENABLED = 'true';
process.env.LEGACY_OCO_REGISTRATION_ENABLED = 'false';

const D = (value: string | number | Prisma.Decimal) =>
  new Prisma.Decimal(value);
const access = new TradingAccountAccessService(db);
const valuation = new PortfolioValuationService(db);
const performance = new GeneralAccountPerformanceService(
  db,
  valuation,
  new GeneralExternalFundingService(db),
);
const reservation = new OrderReservationService();
const cancel = new LimitOrderCancelService(db, reservation);
const orders = new OrdersService(
  db,
  undefined,
  new LimitOrderCreateService(db, reservation),
  cancel,
  access,
  performance,
);
const fill = new LimitOrderExecutionService(
  db,
  new LimitOrderCandleEvidenceService(db),
  orders,
  performance,
);
const conditionalSell = new ConditionalSellService(db, access, orders);
const conditionalBuy = new ConditionalBuyService(db, access, orders);
const protection = new ConditionalService(
  db,
  access,
  orders,
  cancel,
  app.futures,
);
const plans = new EntryTpSlService(db, access);
const futuresLimits = new FuturesLimitService(db, access, app.futures);
const futuresEntries = new FuturesConditionalEntryService(
  db,
  access,
  app.futures,
  futuresLimits,
);
const futuresTpSl = new FuturesTpSlService(db, access, app.futures);

let checks = 0;
function pass(label: string) {
  checks++;
  console.log(`PASS IndependentTpSl ${label}`);
}
async function rejects(work: Promise<unknown>, expected: string) {
  let observed = 'RESOLVED';
  try {
    await work;
  } catch (error) {
    observed = code(error);
  }
  assert.equal(observed, expected);
}

type Market = 'KRX' | 'BINANCE';

/** KRX: the fixture asset becomes a domestic stock on an open session. */
async function market(s: Scenario, kind: Market) {
  if (kind === 'BINANCE') return s.instruments[0].asset;
  tradingSessions.set(await now(), undefined, ['KRX', 'US']);
  const asset = await db.asset.update({
    where: { id: s.instruments[0].asset.id },
    data: {
      market: 'KRX',
      assetType: 'domestic_stock',
      currencyCode: 'KRW',
      priceCurrency: 'KRW',
      settlementCurrency: 'KRW',
    },
  });
  await db.cashWallet.updateMany({
    where: {
      tradingAccountId: s.accountId,
      walletScope: 'securities',
      currencyCode: 'KRW',
    },
    data: { balanceAmount: '1000000' },
  });
  return asset;
}
/** Eligible Spot evidence at the DB clock (KRX in-session / Binance Spot). */
async function quote(s: Scenario, kind: Market, value: string) {
  if (kind === 'BINANCE') return spotPrice(s, value, 0, 0);
  const at = await now();
  return db.assetPriceSnapshot.create({
    data: {
      assetId: s.instruments[0].asset.id,
      price: value,
      currencyCode: 'KRW',
      sourceType: 'provider_api',
      sourceName: 'koscom_krx_realtime_price',
      effectiveAt: at,
      capturedAt: at,
    },
  });
}
async function release(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  await db.entryTpSlPlan.deleteMany({ where });
  await db.futuresTpSlSetting.deleteMany({ where });
  await db.conditionalSellOrder.deleteMany({ where });
  await db.conditionalBuyOrder.deleteMany({ where });
  await db.futuresConditionalEntry.deleteMany({ where });
  const groups = await db.protectionGroup.findMany({
    where,
    select: { id: true },
  });
  const groupId = { in: groups.map((row) => row.id) };
  await db.protectionChild.deleteMany({ where: { groupId } });
  await db.protectionLeg.deleteMany({ where: { groupId } });
  await db.protectionGroup.deleteMany({ where });
  await db.protectionCommand.deleteMany({ where });
  await db.order.deleteMany({ where });
  await db.position.deleteMany({ where });
  await db.seasonRanking.deleteMany({ where });
  await db.dailyPortfolioSnapshot.deleteMany({ where });
  await db.limitOrderCandleEvidence.deleteMany({
    where: { assetId: { in: s.instruments.map((row) => row.asset.id) } },
  });
  await cleanup(s);
}
async function scenario(
  mode: 'general' | 'season',
  work: (s: Scenario) => Promise<void>,
) {
  const s = await fixture(mode, '10000');
  try {
    await fxEvidence();
    await work(s);
  } finally {
    tradingSessions.reset();
    process.env.LEGACY_OCO_REGISTRATION_ENABLED = 'false';
    process.env.FUTURES_TP_SL_ORDERS_ENABLED = 'true';
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    await release(s);
  }
}

// ---------------------------------------------------------------- Spot helpers
type Draft = {
  kind: 'stop_loss' | 'take_profit';
  triggerPrice: string;
  ratio: number;
};
/** A real Spot BUY Limit through quote → create, optionally with plans. */
async function limitBuy(
  s: Scenario,
  kind: Market,
  limitPrice: string,
  size: string,
  extra: Partial<OrderRequestBody> = {},
) {
  const payload: OrderRequestBody = {
    assetId: s.instruments[0].asset.id,
    side: 'buy',
    orderType: 'limit',
    ...(kind === 'BINANCE' ? { amount: size } : { quantity: size }),
    limitPrice,
  };
  const quoted = await orders.quoteOrderForTradingAccount(
    s.userId,
    s.accountId,
    payload,
  );
  const result = await orders.createOrderForTradingAccount(
    s.userId,
    s.accountId,
    {
      ...payload,
      quoteId: quoted.data.quoteId,
      idempotencyKey: randomUUID(),
      ...extra,
    },
  );
  return result.data.order.orderId;
}
async function settleLimit(
  s: Scenario,
  kind: Market,
  orderId: string,
  value: string,
) {
  const snapshot = await quote(s, kind, value);
  await fxEvidence();
  return fill.fillLimitOrder({
    orderId,
    plan: {
      path: 'snapshot',
      assetPriceSnapshotId: snapshot.id,
      executedPrice: D(value),
    },
  });
}
async function marketSell(s: Scenario, quantity: string) {
  const request: OrderRequestBody = {
    assetId: s.instruments[0].asset.id,
    side: 'sell',
    orderType: 'market',
    quantity,
  };
  const quoted = await orders.quoteOrderForTradingAccount(
    s.userId,
    s.accountId,
    request,
  );
  return orders.createOrderForTradingAccount(s.userId, s.accountId, {
    ...request,
    quoteId: quoted.data.quoteId,
    idempotencyKey: randomUUID(),
  });
}
async function addPlans(
  s: Scenario,
  entryType:
    | 'spot_limit_order'
    | 'spot_conditional_buy'
    | 'futures_limit_order'
    | 'futures_conditional_entry',
  entryId: string,
  legs: {
    stopLoss?: { triggerPrice: string; ratio: number };
    takeProfit?: { triggerPrice: string; ratio: number };
  },
  key = randomUUID(),
) {
  return (
    await plans.create(s.userId, s.accountId, {
      entryType,
      entryId,
      idempotencyKey: key,
      ...legs,
    })
  ).data;
}
const planRows = (s: Scenario) =>
  db.entryTpSlPlan.findMany({
    where: { tradingAccountId: s.accountId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
const settings = (s: Scenario) =>
  db.conditionalSellOrder.findMany({
    where: {
      tradingAccountId: s.accountId,
      kind: { in: ['stop_loss', 'take_profit'] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
const holding = (s: Scenario) =>
  db.position.findUnique({
    where: {
      tradingAccountId_assetId: {
        tradingAccountId: s.accountId,
        assetId: s.instruments[0].asset.id,
      },
    },
  });

/**
 * Plans attached to a Spot BUY Limit at creation: pending until the fill,
 * nothing reserved for them, the per-kind 100% / distinct-price / side rules,
 * then ONE activation for ratio × the filled quantity, each setting
 * independent of the others.
 */
async function spotLimitEntry(kind: Market) {
  await scenario('general', async (s) => {
    await market(s, kind);
    await quote(s, kind, '100');
    const drafts: Draft[] = [
      { kind: 'take_profit', triggerPrice: '110', ratio: 30 },
      { kind: 'take_profit', triggerPrice: '120', ratio: 70 },
      { kind: 'stop_loss', triggerPrice: '90', ratio: 100 },
    ];
    const orderId = await limitBuy(
      s,
      kind,
      '100',
      kind === 'BINANCE' ? '500' : '10',
      { entryTpSl: drafts },
    );
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    const expected = order.quantity;
    assert.equal(expected.toFixed(0), kind === 'BINANCE' ? '5' : '10');
    let rows = await planRows(s);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.status === 'pending'));
    assert.ok(rows.every((row) => row.orderId === orderId));
    // Plans reserve nothing: only the order's own cash reservation exists.
    const wallet = await db.cashWallet.findFirstOrThrow({
      where: {
        tradingAccountId: s.accountId,
        walletScope: kind === 'BINANCE' ? 'crypto_spot' : 'securities',
        currencyCode: kind === 'BINANCE' ? 'USD' : 'KRW',
      },
    });
    assert.equal(
      wallet.reservedAmount.toFixed(8),
      order.reservedAmount!.toFixed(8),
    );
    assert.equal((await settings(s)).length, 0);
    // Rules on the pending entry.
    await rejects(
      addPlans(s, 'spot_limit_order', orderId, {
        takeProfit: { triggerPrice: '110', ratio: 10 },
      }),
      'ENTRY_TP_SL_DUPLICATE_PRICE',
    );
    await rejects(
      addPlans(s, 'spot_limit_order', orderId, {
        takeProfit: { triggerPrice: '130', ratio: 1 },
      }),
      'ENTRY_TP_SL_TOTAL_EXCEEDS_ENTRY',
    );
    await rejects(
      addPlans(s, 'spot_limit_order', orderId, {
        stopLoss: { triggerPrice: '100', ratio: 10 },
      }),
      'ENTRY_TP_SL_TOTAL_EXCEEDS_ENTRY',
    );
    // Cancel one take-profit; its share is free again (new price required
    // to be on the protective side of the limit).
    const tp2 = rows.find((row) => row.triggerPrice.eq(120))!;
    const canceled = await plans.cancel(s.userId, s.accountId, tp2.id);
    assert.equal(canceled.data.plan.status, 'canceled');
    assert.equal(canceled.data.plan.terminalReason, 'user_canceled');
    assert.equal(
      (await plans.cancel(s.userId, s.accountId, tp2.id)).data.duplicate,
      true,
    );
    await rejects(
      addPlans(s, 'spot_limit_order', orderId, {
        takeProfit: { triggerPrice: '100', ratio: 70 },
      }),
      'ENTRY_TP_SL_INVALID_TRIGGER',
    );
    const key = randomUUID();
    const added = await addPlans(
      s,
      'spot_limit_order',
      orderId,
      { takeProfit: { triggerPrice: '125', ratio: 70 } },
      key,
    );
    assert.equal(added.plans.length, 1);
    // Same key, same body replays; a different body conflicts.
    const replay = await addPlans(
      s,
      'spot_limit_order',
      orderId,
      { takeProfit: { triggerPrice: '125', ratio: 70 } },
      key,
    );
    assert.equal(replay.duplicate, true);
    assert.equal(replay.plans[0].id, added.plans[0].id);
    await rejects(
      addPlans(
        s,
        'spot_limit_order',
        orderId,
        { takeProfit: { triggerPrice: '126', ratio: 70 } },
        key,
      ),
      'CONDITIONAL_IDEMPOTENCY_CONFLICT',
    );
    const listed = (
      await plans.list(s.userId, s.accountId, {
        entryType: 'spot_limit_order',
        entryId: orderId,
      })
    ).data;
    assert.equal(listed.entry?.state, 'open');
    assert.equal(listed.entry?.expectedQuantity, expected.toFixed(8));
    assert.equal(listed.plans.filter((p) => p.status === 'pending').length, 3);
    // Fill: ONE activation for ratio × the filled quantity.
    assert.equal((await settleLimit(s, kind, orderId, '99')).state, 'filled');
    rows = await planRows(s);
    const active = rows.filter((row) => row.status === 'activated');
    assert.equal(active.length, 3);
    const created = await settings(s);
    assert.equal(created.length, 3);
    const byPrice = (value: number) =>
      created.find((row) => row.triggerPrice.eq(value))!;
    assert.equal(
      byPrice(110).quantity.toFixed(8),
      expected.mul(0.3).toFixed(8),
    );
    assert.equal(
      byPrice(125).quantity.toFixed(8),
      expected.mul(0.7).toFixed(8),
    );
    assert.equal(byPrice(90).quantity.toFixed(8), expected.toFixed(8));
    assert.equal(byPrice(90).kind, 'stop_loss');
    assert.equal(byPrice(90).triggerCondition, 'at_or_below');
    assert.equal(byPrice(110).triggerCondition, 'at_or_above');
    assert.ok(created.every((row) => row.executionType === 'market'));
    assert.ok(created.every((row) => row.status === 'watching'));
    for (const plan of active) {
      assert.equal(plan.fillOrderId, orderId);
      assert.equal(plan.basisQuantity?.toFixed(8), expected.toFixed(8));
      assert.ok(plan.conditionalSellOrderId);
    }
    // The entry is filled: new plans go to the holding instead.
    await rejects(
      addPlans(s, 'spot_limit_order', orderId, {
        stopLoss: { triggerPrice: '80', ratio: 10 },
      }),
      'ENTRY_TP_SL_ENTRY_FILLED',
    );
    // Independent settings: the 110 take-profit sells only its own target;
    // the other take-profit and the stop-loss stay live.
    await quote(s, kind, '111');
    assert.equal(
      (await conditionalSell.evaluate(byPrice(110).id)).state,
      'ordered',
    );
    const afterFirst = await holding(s);
    assert.equal(
      afterFirst!.quantity.toFixed(8),
      expected.sub(expected.mul(0.3)).toFixed(8),
    );
    assert.equal(
      (
        await db.conditionalSellOrder.findUniqueOrThrow({
          where: { id: byPrice(125).id },
        })
      ).status,
      'watching',
    );
    assert.equal(
      (
        await db.conditionalSellOrder.findUniqueOrThrow({
          where: { id: byPrice(90).id },
        })
      ).status,
      'watching',
    );
    // The 125 take-profit sells the rest (its target equals the remainder):
    // the flat holding ends the stop-loss in the same transaction.
    await quote(s, kind, '126');
    assert.equal(
      (await conditionalSell.evaluate(byPrice(125).id)).state,
      'ordered',
    );
    assert.equal((await holding(s))!.quantity.toFixed(8), '0.00000000');
    const sl = await db.conditionalSellOrder.findUniqueOrThrow({
      where: { id: byPrice(90).id },
    });
    assert.equal(sl.status, 'canceled');
    assert.equal(sl.terminalReason, 'position_closed');
    pass(
      `${kind} BUY Limit plans: pending → one activation → independent exits`,
    );
  });
}

/** An entry that ends unfilled ends its plans; ended entries take no plans. */
async function spotEntryEnds() {
  await scenario('general', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    const orderId = await limitBuy(s, 'KRX', '100', '4', {
      entryTpSl: [{ kind: 'stop_loss', triggerPrice: '90', ratio: 50 }],
    });
    await orders.cancelOrderForTradingAccount(s.userId, s.accountId, orderId);
    const [plan] = await planRows(s);
    assert.equal(plan.status, 'canceled');
    assert.equal(plan.terminalReason, 'entry_canceled');
    await rejects(
      addPlans(s, 'spot_limit_order', orderId, {
        stopLoss: { triggerPrice: '90', ratio: 50 },
      }),
      'ENTRY_TP_SL_ENTRY_NOT_OPEN',
    );
    // A SELL limit is not an entry.
    await db.position.create({
      data: {
        tradingAccountId: s.accountId,
        assetId: s.instruments[0].asset.id,
        quantity: '5',
        averageCost: '100',
        currencyCode: 'KRW',
      },
    });
    const sellRequest: OrderRequestBody = {
      assetId: s.instruments[0].asset.id,
      side: 'sell',
      orderType: 'limit',
      quantity: '1',
      limitPrice: '130',
    };
    const quoted = await orders.quoteOrderForTradingAccount(
      s.userId,
      s.accountId,
      sellRequest,
    );
    const sell = await orders.createOrderForTradingAccount(
      s.userId,
      s.accountId,
      {
        ...sellRequest,
        quoteId: quoted.data.quoteId,
        idempotencyKey: randomUUID(),
      },
    );
    await rejects(
      addPlans(s, 'spot_limit_order', sell.data.order.orderId, {
        stopLoss: { triggerPrice: '90', ratio: 50 },
      }),
      'ENTRY_TP_SL_ENTRY_UNSUPPORTED',
    );
    // Plans never ride on a SELL create.
    await rejects(
      orders.createOrderForTradingAccount(s.userId, s.accountId, {
        ...sellRequest,
        quoteId: quoted.data.quoteId,
        idempotencyKey: randomUUID(),
        entryTpSl: [{ kind: 'stop_loss', triggerPrice: '90', ratio: 10 }],
      }),
      'INVALID_ATTACHED_ENTRY',
    );
    pass('canceled entry ends its plans; ended/SELL entries refuse plans');
  });
}

/**
 * The new entry's targets come from ITS fill only, are bounded per kind with
 * the holding's live settings, and a plan the holding rules would refuse
 * fails (with the fill evidence) instead of creating an oversized setting.
 */
async function spotHoldingMerge() {
  await scenario('general', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    await db.position.create({
      data: {
        tradingAccountId: s.accountId,
        assetId: s.instruments[0].asset.id,
        quantity: '5',
        averageCost: '100',
        currencyCode: 'KRW',
      },
    });
    const holdingSl = await conditionalSell.create(s.userId, s.accountId, {
      kind: 'protection',
      assetId: s.instruments[0].asset.id,
      stopLoss: {
        triggerPrice: '80',
        executionType: 'market',
        quantity: '5',
      },
      idempotencyKey: randomUUID(),
    });
    const orderId = await limitBuy(s, 'KRX', '100', '10', {
      entryTpSl: [
        { kind: 'stop_loss', triggerPrice: '90', ratio: 100 },
        { kind: 'take_profit', triggerPrice: '120', ratio: 50 },
      ],
    });
    // A second, independent entry on the same asset with its own plan.
    const other = await limitBuy(s, 'KRX', '95', '2', {
      entryTpSl: [{ kind: 'take_profit', triggerPrice: '140', ratio: 100 }],
    });
    assert.equal((await settleLimit(s, 'KRX', orderId, '100')).state, 'filled');
    const rows = await settings(s);
    // Holding SL (5 @ 80) untouched; the entry adds SL 10 @ 90 and TP 5 @ 120.
    assert.equal(rows.length, 3);
    const slEntry = rows.find((row) => row.triggerPrice.eq(90))!;
    const tpEntry = rows.find((row) => row.triggerPrice.eq(120))!;
    assert.equal(slEntry.quantity.toFixed(0), '10');
    assert.equal(tpEntry.quantity.toFixed(0), '5');
    assert.equal(
      rows
        .find((row) => row.id === holdingSl.data.conditionalOrders[0].id)
        ?.quantity.toFixed(0),
      '5',
    );
    // The other entry's plan is still pending: another order's fill never
    // activates it.
    const pendingOther = await db.entryTpSlPlan.findFirstOrThrow({
      where: { orderId: other },
    });
    assert.equal(pendingOther.status, 'pending');
    // Now the holding (15) takes a TP for all of it; selling 5 leaves the
    // live TP targets (5 + 15) above the 10 remaining.
    await conditionalSell.create(s.userId, s.accountId, {
      kind: 'protection',
      assetId: s.instruments[0].asset.id,
      takeProfit: {
        triggerPrice: '150',
        executionType: 'market',
        quantity: '10',
      },
      idempotencyKey: randomUUID(),
    });
    await quote(s, 'KRX', '100');
    await marketSell(s, '5');
    assert.equal((await holding(s))!.quantity.toFixed(0), '10');
    // The other entry fills 2: TP total 5 + 10 + 2 = 17 > 12 → failed.
    assert.equal((await settleLimit(s, 'KRX', other, '95')).state, 'filled');
    const failed = await db.entryTpSlPlan.findFirstOrThrow({
      where: { orderId: other },
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'ENTRY_TP_SL_TOTAL_EXCEEDS_HOLDING');
    assert.equal(failed.fillOrderId, other);
    assert.equal(failed.basisQuantity?.toFixed(0), '2');
    assert.equal(failed.conditionalSellOrderId, null);
    assert.equal(
      (await settings(s)).filter((row) => row.triggerPrice.eq(140)).length,
      0,
    );
    pass(
      'entry targets come from its own fill; holding totals bound activation',
    );
  });
}

/** Conditional BUY: plans on the watch, activation from the order it
 * creates (market here), sized from the executed quantity. */
async function conditionalBuyMarket() {
  await scenario('general', async (s) => {
    await market(s, 'BINANCE');
    await quote(s, 'BINANCE', '100');
    const watch = await conditionalBuy.create(s.userId, s.accountId, {
      assetId: s.instruments[0].asset.id,
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      executionType: 'market',
      amount: '100',
      idempotencyKey: randomUUID(),
    });
    const id = watch.data.conditionalOrder.id;
    // Reference for a market watch is its trigger price (95).
    await rejects(
      addPlans(s, 'spot_conditional_buy', id, {
        stopLoss: { triggerPrice: '95', ratio: 100 },
      }),
      'ENTRY_TP_SL_INVALID_TRIGGER',
    );
    await addPlans(s, 'spot_conditional_buy', id, {
      stopLoss: { triggerPrice: '90', ratio: 100 },
      takeProfit: { triggerPrice: '110', ratio: 50 },
    });
    const listed = (
      await plans.list(s.userId, s.accountId, {
        entryType: 'spot_conditional_buy',
        entryId: id,
      })
    ).data;
    // A crypto watch by amount knows no quantity before it executes.
    assert.equal(listed.entry?.expectedQuantity, null);
    assert.equal(listed.entry?.amount, '100.00000000');
    // Watching never activates anything.
    await quote(s, 'BINANCE', '97');
    assert.equal((await conditionalBuy.evaluate(id)).state, 'watching');
    assert.equal((await settings(s)).length, 0);
    await quote(s, 'BINANCE', '95');
    assert.equal((await conditionalBuy.evaluate(id)).state, 'ordered');
    const row = await db.conditionalBuyOrder.findUniqueOrThrow({
      where: { id },
      include: { order: true },
    });
    assert.equal(row.order?.status, 'executed');
    const executed = row.order.executedQuantity ?? row.order.quantity;
    const rows = await settings(s);
    assert.equal(rows.length, 2);
    assert.equal(
      rows.find((r) => r.kind === 'stop_loss')!.quantity.toFixed(6),
      executed.toFixed(6),
    );
    assert.equal(
      rows.find((r) => r.kind === 'take_profit')!.quantity.toFixed(6),
      executed
        .mul(50)
        .div(100)
        .toDecimalPlaces(6, Prisma.Decimal.ROUND_DOWN)
        .toFixed(6),
    );
    const activated = await planRows(s);
    assert.ok(activated.every((p) => p.status === 'activated'));
    assert.ok(activated.every((p) => p.fillOrderId === row.orderId));
    pass('conditional BUY (market) plans activate from the executed quantity');
  });
}

/** Conditional BUY with limit execution: the watch and the order it created
 * share ONE plan set; the order's fill activates it once. */
async function conditionalBuyLimitChild() {
  await scenario('general', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    const created = await conditionalBuy.create(s.userId, s.accountId, {
      assetId: s.instruments[0].asset.id,
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      executionType: 'limit',
      limitPrice: '94',
      quantity: '3',
      idempotencyKey: randomUUID(),
    });
    const id = created.data.conditionalOrder.id;
    await addPlans(s, 'spot_conditional_buy', id, {
      stopLoss: { triggerPrice: '85', ratio: 100 },
    });
    await quote(s, 'KRX', '95');
    assert.equal((await conditionalBuy.evaluate(id)).state, 'ordered');
    const watch = await db.conditionalBuyOrder.findUniqueOrThrow({
      where: { id },
    });
    const childId = watch.orderId!;
    // Registered through the child order, stored on the watch.
    const viaChild = await addPlans(s, 'spot_limit_order', childId, {
      takeProfit: { triggerPrice: '110', ratio: 100 },
    });
    assert.equal(viaChild.entry?.entryType, 'spot_conditional_buy');
    assert.equal(viaChild.entry?.entryId, id);
    const stored = await planRows(s);
    assert.equal(stored.length, 2);
    assert.ok(stored.every((p) => p.conditionalBuyOrderId === id));
    assert.ok(stored.every((p) => p.orderId === null));
    // One set: the same price through either id is a duplicate.
    await rejects(
      addPlans(s, 'spot_limit_order', childId, {
        stopLoss: { triggerPrice: '85', ratio: 1 },
      }),
      'ENTRY_TP_SL_DUPLICATE_PRICE',
    );
    assert.equal((await settleLimit(s, 'KRX', childId, '93')).state, 'filled');
    const rows = await settings(s);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.quantity.toFixed(0) === '3'));
    const activated = await planRows(s);
    assert.ok(activated.every((p) => p.status === 'activated'));
    assert.ok(activated.every((p) => p.fillOrderId === childId));
    pass('conditional BUY → limit child: one plan set, activated once on fill');
  });
  await scenario('general', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    // Watching watch canceled → plans end.
    const watching = (
      await conditionalBuy.create(s.userId, s.accountId, {
        assetId: s.instruments[0].asset.id,
        triggerCondition: 'at_or_above',
        triggerPrice: '105',
        executionType: 'market',
        quantity: '2',
        idempotencyKey: randomUUID(),
      })
    ).data.conditionalOrder.id;
    await addPlans(s, 'spot_conditional_buy', watching, {
      stopLoss: { triggerPrice: '95', ratio: 100 },
    });
    await conditionalBuy.cancel(s.userId, s.accountId, watching);
    // Ordered watch whose limit child is canceled → plans end.
    const ordered = (
      await conditionalBuy.create(s.userId, s.accountId, {
        assetId: s.instruments[0].asset.id,
        triggerCondition: 'at_or_below',
        triggerPrice: '96',
        executionType: 'limit',
        limitPrice: '95',
        quantity: '2',
        idempotencyKey: randomUUID(),
      })
    ).data.conditionalOrder.id;
    await addPlans(s, 'spot_conditional_buy', ordered, {
      takeProfit: { triggerPrice: '120', ratio: 100 },
    });
    await quote(s, 'KRX', '96');
    assert.equal((await conditionalBuy.evaluate(ordered)).state, 'ordered');
    const child = (
      await db.conditionalBuyOrder.findUniqueOrThrow({ where: { id: ordered } })
    ).orderId!;
    await orders.cancelOrderForTradingAccount(s.userId, s.accountId, child);
    const rows = await planRows(s);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((p) => p.status === 'canceled'));
    assert.ok(rows.every((p) => p.terminalReason === 'entry_canceled'));
    assert.equal(
      await endEntryTpSlPlansOfEndedEntries(db, null, await now()),
      0,
    );
    pass('canceled watch / canceled child order end the watch plans');
  });
}

/**
 * Registration vs fill on the same entry, both orders: whichever commits
 * first under the account fence decides; plans are never lost after a
 * successful registration and never attached to a filled entry.
 */
async function registrationFillRace() {
  // Registration first: the fill waits, then activates the new plan.
  await scenario('general', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    const orderId = await limitBuy(s, 'KRX', '100', '4');
    const snapshot = await quote(s, 'KRX', '99');
    await fxEvidence();
    const held = await holdRowLock(
      (tx) =>
        tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`,
    );
    const registration = addPlans(s, 'spot_limit_order', orderId, {
      stopLoss: { triggerPrice: '90', ratio: 100 },
    });
    await untilLockWaiting();
    const filling = fill.fillLimitOrder({
      orderId,
      plan: {
        path: 'snapshot',
        assetPriceSnapshotId: snapshot.id,
        executedPrice: D('99'),
      },
    });
    await untilLocksWaiting(2);
    await held.release();
    await registration;
    assert.equal((await filling).state, 'filled');
    const [plan] = await planRows(s);
    assert.equal(plan.status, 'activated');
    assert.equal((await settings(s))[0].quantity.toFixed(0), '4');
    pass('registration then fill: the fill activates the just-registered plan');
  });
  // Fill first: the registration waits and then refuses the filled entry.
  await scenario('general', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    const orderId = await limitBuy(s, 'KRX', '100', '4');
    const snapshot = await quote(s, 'KRX', '99');
    await fxEvidence();
    const held = await holdRowLock(
      (tx) =>
        tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`,
    );
    const filling = fill.fillLimitOrder({
      orderId,
      plan: {
        path: 'snapshot',
        assetPriceSnapshotId: snapshot.id,
        executedPrice: D('99'),
      },
    });
    await untilLockWaiting();
    const registration = addPlans(s, 'spot_limit_order', orderId, {
      stopLoss: { triggerPrice: '90', ratio: 100 },
    });
    await untilLocksWaiting(2);
    await held.release();
    assert.equal((await filling).state, 'filled');
    await rejects(registration, 'ENTRY_TP_SL_ENTRY_FILLED');
    assert.equal((await planRows(s)).length, 0);
    assert.equal((await settings(s)).length, 0);
    pass('fill then registration: the filled entry refuses the plan');
  });
}

/** Resolves once `count` backends of this database wait for a lock. */
async function untilLocksWaiting(count: number) {
  const started = Date.now();
  for (;;) {
    const [row] = await db.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS "waiting" FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (row.waiting >= count) return;
    assert.ok(Date.now() - started < 4000, 'transactions did not queue');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ------------------------------------------------------------- Futures helpers
async function fresh(s: Scenario, value: string) {
  await fxEvidence();
  await futuresLastPrice(s, value, 0, 0);
  const at = await now();
  await db.futuresMarkSnapshot.create({
    data: {
      instrumentId: s.instruments[0].instrument.id,
      symbol: s.instruments[0].asset.symbol,
      price: value,
      source: 'binance_usdm_mark_ws',
      effectiveAt: at,
      capturedAt: at,
    },
  });
}
async function openPosition(
  s: Scenario,
  direction: FuturesDirection,
  quantity: string,
) {
  await fresh(s, '100');
  return app.futures.execute(s.userId, s.accountId, {
    instrumentId: s.instruments[0].instrument.id,
    operation: 'open',
    direction,
    quantity,
    leverage: 5,
    idempotencyKey: randomUUID(),
  });
}
const futuresSettings = (s: Scenario) =>
  db.futuresTpSlSetting.findMany({
    where: { tradingAccountId: s.accountId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { execution: true },
  });
const lifetime = (s: Scenario) =>
  db.futuresPosition.findFirst({
    where: {
      tradingAccountId: s.accountId,
      instrumentId: s.instruments[0].instrument.id,
    },
    orderBy: { createdAt: 'desc' },
  });
async function registerFutures(
  s: Scenario,
  positionId: string,
  legs: {
    stopLoss?: { triggerPrice: string; quantity: string };
    takeProfit?: { triggerPrice: string; quantity: string };
  },
  key = randomUUID(),
) {
  return (
    await futuresTpSl.create(s.userId, s.accountId, {
      positionId,
      idempotencyKey: key,
      ...legs,
    })
  ).data;
}

/**
 * Futures limit entry with plans (long and short sides): one activation on
 * the new lifetime for ratio × the executed quantity, then reduce-only
 * partial exits at Futures Last that never cancel each other, a later
 * trigger re-sized to the smaller position, and the lifetime close ending
 * the rest in the same transaction.
 */
async function futuresLimitEntry(direction: FuturesDirection) {
  await scenario('season', async (s) => {
    const long = direction === 'long';
    await fresh(s, '100');
    const drafts: Draft[] = long
      ? [
          { kind: 'take_profit', triggerPrice: '110', ratio: 30 },
          { kind: 'take_profit', triggerPrice: '120', ratio: 70 },
          { kind: 'stop_loss', triggerPrice: '90', ratio: 100 },
        ]
      : [
          { kind: 'take_profit', triggerPrice: '90', ratio: 30 },
          { kind: 'take_profit', triggerPrice: '80', ratio: 70 },
          { kind: 'stop_loss', triggerPrice: '110', ratio: 100 },
        ];
    const entry = (
      await futuresLimits.create(s.userId, s.accountId, {
        instrumentId: s.instruments[0].instrument.id,
        direction,
        marginMode: 'isolated',
        quantity: '1',
        leverage: 5,
        limitPrice: '100',
        idempotencyKey: randomUUID(),
        entryTpSl: drafts,
      })
    ).data.order;
    assert.equal((await planRows(s)).length, 3);
    // Both kinds are at 100% of the entry.
    await rejects(
      addPlans(s, 'futures_limit_order', entry.id, {
        stopLoss: { triggerPrice: long ? '85' : '115', ratio: 1 },
      }),
      'ENTRY_TP_SL_TOTAL_EXCEEDS_ENTRY',
    );
    // Pending: no setting, no trigger.
    assert.equal((await futuresSettings(s)).length, 0);
    await fresh(s, '100');
    assert.equal((await futuresLimits.evaluate(entry.id)).state, 'executed');
    const position = (await lifetime(s))!;
    assert.equal(position.status, 'open');
    let rows = await futuresSettings(s);
    assert.equal(rows.length, 3);
    const at = (value: number) => rows.find((r) => r.triggerPrice.eq(value))!;
    const tp1 = at(long ? 110 : 90);
    const tp2 = at(long ? 120 : 80);
    const sl = at(long ? 90 : 110);
    assert.equal(tp1.quantity.toFixed(8), '0.30000000');
    assert.equal(tp2.quantity.toFixed(8), '0.70000000');
    assert.equal(sl.quantity.toFixed(8), '1.00000000');
    assert.ok(rows.every((r) => r.positionId === position.id));
    assert.ok(rows.every((r) => r.direction === direction));
    const opening = await db.futuresLimitOrder.findUniqueOrThrow({
      where: { id: entry.id },
    });
    const activated = await planRows(s);
    assert.ok(activated.every((p) => p.status === 'activated'));
    assert.ok(
      activated.every((p) => p.fillExecutionId === opening.executionId),
    );
    // Not yet met: watching.
    await futuresLastPrice(s, long ? '109' : '91', 0, 0);
    assert.equal((await futuresTpSl.evaluate(tp1.id)).state, 'watching');
    // TP1 reached: reduce 0.3 only; TP2 and SL stay live (no OCO).
    await futuresLastPrice(s, long ? '110' : '90', 0, 0);
    assert.equal((await futuresTpSl.evaluate(tp1.id)).state, 'ordered');
    assert.equal((await lifetime(s))!.quantity.toFixed(8), '0.70000000');
    rows = await futuresSettings(s);
    assert.equal(at(long ? 110 : 90).status, 'ordered');
    assert.equal(at(long ? 110 : 90).execution?.operation, 'reduce');
    assert.equal(
      at(long ? 110 : 90).execution?.quantity.toFixed(8),
      '0.30000000',
    );
    assert.equal(at(long ? 120 : 80).status, 'watching');
    assert.equal(at(long ? 90 : 110).status, 'watching');
    // A second evaluation never executes twice.
    assert.equal((await futuresTpSl.evaluate(tp1.id)).state, 'terminal');
    // Manual reduce 0.2 → the SL (target 1.0) later closes only the 0.5 left.
    await fresh(s, '100');
    await app.futures.execute(s.userId, s.accountId, {
      instrumentId: s.instruments[0].instrument.id,
      positionId: position.id,
      operation: 'reduce',
      direction,
      quantity: '0.2',
      leverage: 5,
      idempotencyKey: randomUUID(),
    });
    await futuresLastPrice(s, long ? '90' : '110', 0, 0);
    assert.equal((await futuresTpSl.evaluate(sl.id)).state, 'ordered');
    const closed = (await lifetime(s))!;
    assert.equal(closed.status, 'closed');
    rows = await futuresSettings(s);
    assert.equal(at(long ? 90 : 110).execution?.operation, 'close');
    assert.equal(
      at(long ? 90 : 110).execution?.quantity.toFixed(8),
      '0.50000000',
    );
    const ended = at(long ? 120 : 80);
    assert.equal(ended.status, 'canceled');
    assert.equal(ended.terminalReason, 'position_closed');
    const participant = await db.seasonParticipant.findUniqueOrThrow({
      where: { tradingAccountId: s.accountId },
    });
    // entry fill + TP1 + manual reduce + SL close
    assert.equal(participant.totalFillCount, 4);
    const executions = await db.futuresExecution.count({
      where: { tradingAccountId: s.accountId },
    });
    assert.equal(executions, 4);
    pass(`Futures ${direction} limit entry plans → partial reduce-only exits`);
  });
}

/** Holding settings on an open position: registration rules, flags/modes,
 * OCO coexistence, idempotency and a concurrent double evaluation. */
async function futuresSettingRules() {
  await scenario('general', async (s) => {
    const opened = await openPosition(s, 'long', '1');
    const positionId = opened.data.position.id;
    await futuresLastPrice(s, '100', 0, 0);
    await rejects(
      registerFutures(s, positionId, {
        takeProfit: { triggerPrice: '110', quantity: '1.1' },
      }),
      'FUTURES_TP_SL_QUANTITY_EXCEEDS_POSITION',
    );
    await rejects(
      registerFutures(s, positionId, {
        takeProfit: { triggerPrice: '100', quantity: '0.5' },
      }),
      'FUTURES_TP_SL_ALREADY_MET',
    );
    const key = randomUUID();
    const first = await registerFutures(
      s,
      positionId,
      {
        stopLoss: { triggerPrice: '90', quantity: '1' },
        takeProfit: { triggerPrice: '110', quantity: '0.6' },
      },
      key,
    );
    assert.equal(first.settings.length, 2);
    const replay = await registerFutures(
      s,
      positionId,
      {
        stopLoss: { triggerPrice: '90', quantity: '1' },
        takeProfit: { triggerPrice: '110', quantity: '0.6' },
      },
      key,
    );
    assert.equal(replay.duplicate, true);
    await rejects(
      registerFutures(
        s,
        positionId,
        { stopLoss: { triggerPrice: '91', quantity: '1' } },
        key,
      ),
      'FUTURES_IDEMPOTENCY_CONFLICT',
    );
    await rejects(
      registerFutures(s, positionId, {
        takeProfit: { triggerPrice: '110', quantity: '0.1' },
      }),
      'FUTURES_TP_SL_DUPLICATE_PRICE',
    );
    await rejects(
      registerFutures(s, positionId, {
        takeProfit: { triggerPrice: '115', quantity: '0.5' },
      }),
      'FUTURES_TP_SL_TOTAL_EXCEEDS_POSITION',
    );
    // Flags and modes gate new settings only.
    process.env.FUTURES_TP_SL_ORDERS_ENABLED = 'false';
    await rejects(
      registerFutures(s, positionId, {
        takeProfit: { triggerPrice: '115', quantity: '0.1' },
      }),
      'FUTURES_TP_SL_DISABLED',
    );
    const tp = first.settings.find((row) => row.kind === 'take_profit')!;
    await futuresLastPrice(s, '111', 0, 0);
    assert.equal((await futuresTpSl.evaluate(tp.id)).state, 'disabled');
    process.env.FUTURES_TP_SL_ORDERS_ENABLED = 'true';
    process.env.FUTURES_TRADING_MODE = 'DISABLED';
    await rejects(
      registerFutures(s, positionId, {
        takeProfit: { triggerPrice: '115', quantity: '0.1' },
      }),
      'FUTURES_TRADING_DISABLED',
    );
    assert.equal((await futuresTpSl.evaluate(tp.id)).state, 'paused');
    // REDUCE_ONLY: the reduce-only exit still runs.
    process.env.FUTURES_TRADING_MODE = 'REDUCE_ONLY';
    await futuresLastPrice(s, '111', 0, 0);
    // Two concurrent evaluations → exactly one execution.
    const states = await Promise.all([
      futuresTpSl.evaluate(tp.id),
      futuresTpSl.evaluate(tp.id),
    ]);
    assert.ok(states.some((row) => row.state === 'ordered'));
    const executed = await db.futuresTpSlSetting.findUniqueOrThrow({
      where: { id: tp.id },
      include: { execution: true },
    });
    assert.equal(executed.status, 'ordered');
    assert.equal(executed.execution?.quantity.toFixed(8), '0.60000000');
    assert.equal(
      await db.futuresExecution.count({
        where: { tradingAccountId: s.accountId, operation: 'reduce' },
      }),
      1,
    );
    assert.equal((await lifetime(s))!.quantity.toFixed(8), '0.40000000');
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    // Cancel: live → canceled; again → replay.
    const sl = first.settings.find((row) => row.kind === 'stop_loss')!;
    const canceled = await futuresTpSl.cancel(s.userId, s.accountId, sl.id);
    assert.equal(canceled.data.setting.status, 'canceled');
    assert.equal(
      (await futuresTpSl.cancel(s.userId, s.accountId, sl.id)).data.duplicate,
      true,
    );
    // A whole-lifetime OCO group (legacy) and settings never share a lifetime.
    const list = (await futuresTpSl.list(s.userId, s.accountId, { positionId }))
      .data;
    assert.equal(list.settings.length, 0);
    assert.equal(list.capabilities.canCreate, true);
    process.env.LEGACY_OCO_REGISTRATION_ENABLED = 'true';
    await futuresLastPrice(s, '100', 0, 0);
    await protection.create(s.userId, s.accountId, {
      domain: 'futures',
      assetId: s.instruments[0].asset.id,
      positionId,
      legs: [
        { kind: 'stop_loss', triggerPrice: '80', childOrderType: 'market' },
      ],
      idempotencyKey: randomUUID(),
    });
    process.env.LEGACY_OCO_REGISTRATION_ENABLED = 'false';
    await futuresLastPrice(s, '100', 0, 0);
    await rejects(
      registerFutures(s, positionId, {
        takeProfit: { triggerPrice: '130', quantity: '0.1' },
      }),
      'PROTECTION_CONFLICT',
    );
    pass(
      'Futures settings: rules, flags/modes, OCO exclusion, single execution',
    );
  });
}

/** Futures conditional entries: market open activates the watch plans; a
 * limit execution keeps ONE set across the watch and its limit entry; a
 * canceled watch ends them. */
async function futuresConditionalEntryPlans() {
  await scenario('general', async (s) => {
    await fresh(s, '100');
    const watch = (
      await futuresEntries.create(s.userId, s.accountId, {
        instrumentId: s.instruments[0].instrument.id,
        direction: 'short',
        marginMode: 'isolated',
        leverage: 5,
        quantity: '2',
        triggerCondition: 'at_or_above',
        triggerPrice: '105',
        executionType: 'market',
        idempotencyKey: randomUUID(),
      })
    ).data.entry;
    // Short at 105: stop-loss above, take-profit below.
    await rejects(
      addPlans(s, 'futures_conditional_entry', watch.id, {
        stopLoss: { triggerPrice: '100', ratio: 100 },
      }),
      'ENTRY_TP_SL_INVALID_TRIGGER',
    );
    await addPlans(s, 'futures_conditional_entry', watch.id, {
      stopLoss: { triggerPrice: '115', ratio: 100 },
      takeProfit: { triggerPrice: '95', ratio: 25 },
    });
    await fresh(s, '105');
    assert.equal((await futuresEntries.evaluate(watch.id)).state, 'ordered');
    const position = (await lifetime(s))!;
    assert.equal(position.direction, 'short');
    const rows = await futuresSettings(s);
    assert.equal(rows.length, 2);
    assert.equal(
      rows.find((r) => r.kind === 'stop_loss')!.quantity.toFixed(8),
      '2.00000000',
    );
    assert.equal(
      rows.find((r) => r.kind === 'take_profit')!.quantity.toFixed(8),
      '0.50000000',
    );
    assert.ok((await planRows(s)).every((p) => p.status === 'activated'));
    pass('Futures conditional (market) plans activate on the opened lifetime');
  });
  await scenario('general', async (s) => {
    await fresh(s, '100');
    const watch = (
      await futuresEntries.create(s.userId, s.accountId, {
        instrumentId: s.instruments[0].instrument.id,
        direction: 'long',
        marginMode: 'isolated',
        leverage: 5,
        quantity: '1',
        triggerCondition: 'at_or_below',
        triggerPrice: '95',
        executionType: 'limit',
        limitPrice: '94',
        idempotencyKey: randomUUID(),
      })
    ).data.entry;
    await addPlans(s, 'futures_conditional_entry', watch.id, {
      stopLoss: { triggerPrice: '90', ratio: 100 },
    });
    await fresh(s, '95');
    assert.equal((await futuresEntries.evaluate(watch.id)).state, 'ordered');
    const limitOrderId = (
      await db.futuresConditionalEntry.findUniqueOrThrow({
        where: { id: watch.id },
      })
    ).limitOrderId!;
    const viaChild = await addPlans(s, 'futures_limit_order', limitOrderId, {
      takeProfit: { triggerPrice: '110', ratio: 40 },
    });
    assert.equal(viaChild.entry?.entryType, 'futures_conditional_entry');
    assert.ok(
      (await planRows(s)).every(
        (p) => p.futuresConditionalEntryId === watch.id,
      ),
    );
    await fresh(s, '94');
    assert.equal(
      (await futuresLimits.evaluate(limitOrderId)).state,
      'executed',
    );
    const rows = await futuresSettings(s);
    assert.equal(rows.length, 2);
    assert.equal(
      rows.find((r) => r.kind === 'take_profit')!.quantity.toFixed(8),
      '0.40000000',
    );
    pass('Futures conditional (limit) → one plan set via the child entry');
  });
  await scenario('general', async (s) => {
    await fresh(s, '100');
    const watch = (
      await futuresEntries.create(s.userId, s.accountId, {
        instrumentId: s.instruments[0].instrument.id,
        direction: 'long',
        marginMode: 'isolated',
        leverage: 5,
        quantity: '1',
        triggerCondition: 'at_or_above',
        triggerPrice: '105',
        executionType: 'market',
        idempotencyKey: randomUUID(),
      })
    ).data.entry;
    await addPlans(s, 'futures_conditional_entry', watch.id, {
      stopLoss: { triggerPrice: '95', ratio: 100 },
    });
    await futuresEntries.cancel(s.userId, s.accountId, watch.id);
    const [plan] = await planRows(s);
    assert.equal(plan.status, 'canceled');
    assert.equal(plan.terminalReason, 'entry_canceled');
    // A canceled Futures limit entry ends its plans too.
    const entry = (
      await futuresLimits.create(s.userId, s.accountId, {
        instrumentId: s.instruments[0].instrument.id,
        direction: 'long',
        marginMode: 'isolated',
        quantity: '1',
        leverage: 5,
        limitPrice: '99',
        idempotencyKey: randomUUID(),
        entryTpSl: [{ kind: 'stop_loss', triggerPrice: '90', ratio: 100 }],
      })
    ).data.order;
    await futuresLimits.cancel(s.userId, s.accountId, entry.id);
    const ended = await db.entryTpSlPlan.findFirstOrThrow({
      where: { futuresLimitOrderId: entry.id },
    });
    assert.equal(ended.status, 'canceled');
    pass('canceled Futures watch / limit entry end their plans');
  });
}

/** Participant exclusion ends live Futures settings and pending plans in the
 * existing lifecycle transaction. */
async function lifecycleCleanup() {
  await scenario('season', async (s) => {
    const opened = await openPosition(s, 'long', '1');
    await futuresLastPrice(s, '100', 0, 0);
    await registerFutures(s, opened.data.position.id, {
      stopLoss: { triggerPrice: '90', quantity: '1' },
    });
    await quote(s, 'BINANCE', '100');
    await limitBuy(s, 'BINANCE', '100', '100', {
      entryTpSl: [{ kind: 'stop_loss', triggerPrice: '90', ratio: 100 }],
    });
    await db.$transaction(async (tx) => {
      await lockSeasonTradingContext(tx, {
        seasonParticipantId: (
          await tx.seasonParticipant.findUniqueOrThrow({
            where: { tradingAccountId: s.accountId },
          })
        ).id,
        participantWrite: true,
      });
      await cancel.cancelOpenLimitBuysForParticipantInTransaction(tx, {
        tradingAccountId: s.accountId,
        reason: 'participant_excluded',
        canceledAt: await now(),
      });
    });
    const [setting] = await futuresSettings(s);
    assert.equal(setting.status, 'canceled');
    assert.equal(setting.terminalReason, 'participant_excluded');
    const [plan] = await planRows(s);
    assert.equal(plan.status, 'canceled');
    assert.equal(plan.terminalReason, 'entry_canceled');
    pass('participant exclusion ends Futures settings and entry plans');
  });
}

/** New OCO groups are retired on every registration path; nothing is left
 * behind by a refused create. */
async function legacyOcoRetired() {
  await scenario('general', async (s) => {
    await quote(s, 'BINANCE', '100');
    const before = await db.order.count({
      where: { tradingAccountId: s.accountId },
    });
    await rejects(
      limitBuy(s, 'BINANCE', '100', '200', {
        attachedProtection: [
          { kind: 'stop_loss', triggerPrice: '90', childOrderType: 'market' },
        ],
      }),
      'PROTECTION_REGISTRATION_RETIRED',
    );
    assert.equal(
      await db.order.count({ where: { tradingAccountId: s.accountId } }),
      before,
    );
    await fresh(s, '100');
    const wallet = await db.cashWallet.findUniqueOrThrow({
      where: { id: s.futuresWalletId },
    });
    await rejects(
      futuresLimits.create(s.userId, s.accountId, {
        instrumentId: s.instruments[0].instrument.id,
        direction: 'long',
        marginMode: 'isolated',
        quantity: '1',
        leverage: 5,
        limitPrice: '99',
        idempotencyKey: randomUUID(),
        attachedProtection: [
          { kind: 'stop_loss', triggerPrice: '90', childOrderType: 'market' },
        ],
      }),
      'PROTECTION_REGISTRATION_RETIRED',
    );
    assert.equal(
      (
        await db.cashWallet.findUniqueOrThrow({
          where: { id: s.futuresWalletId },
        })
      ).reservedAmount.toFixed(8),
      wallet.reservedAmount.toFixed(8),
    );
    const opened = await openPosition(s, 'long', '1');
    await rejects(
      protection.create(s.userId, s.accountId, {
        domain: 'futures',
        assetId: s.instruments[0].asset.id,
        positionId: opened.data.position.id,
        legs: [
          { kind: 'stop_loss', triggerPrice: '80', childOrderType: 'market' },
        ],
        idempotencyKey: randomUUID(),
      }),
      'PROTECTION_REGISTRATION_RETIRED',
    );
    const caps = (
      await protection.list(s.userId, s.accountId, { domain: 'futures' })
    ).data.capabilities;
    assert.equal(caps.canCreateFutures, false);
    // Existing groups are still watched: monitoring never followed registration.
    assert.equal(caps.canMonitorFutures, true);
    assert.equal(caps.canCancel, true);
    pass(
      'new OCO registration retired on all three paths; reads/cancel intact',
    );
  });
}

async function main() {
  await spotLimitEntry('KRX');
  await spotLimitEntry('BINANCE');
  await spotEntryEnds();
  await spotHoldingMerge();
  await conditionalBuyMarket();
  await conditionalBuyLimitChild();
  await registrationFillRace();
  await futuresLimitEntry('long');
  await futuresLimitEntry('short');
  await futuresSettingRules();
  await futuresConditionalEntryPlans();
  await lifecycleCleanup();
  await legacyOcoRetired();
  console.log(`independent TP/SL db integration ok (${checks} scenarios)`);
}
main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
