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
  fxEvidenceIds,
  cleanup,
  code,
  untilDb,
  type Scenario,
} from './futures-integration';
import { Prisma } from '../src/generated/prisma/client';
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
import { LimitOrderCandidateRepository } from '../src/orders/limit-order-candidate.repository';
import { LimitOrderMatchingService } from '../src/orders/limit-order-matching.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { ConditionalSellService } from '../src/conditional/conditional-sell.service';
import { ConditionalSellWorker } from '../src/conditional/conditional-sell-worker.service';
import { ConditionalService } from '../src/conditional/conditional.service';
import {
  CONDITIONAL_SELL_EXECUTION_WINDOW_MS,
  CONDITIONAL_SELL_MAX_LIVE_PER_ACCOUNT,
  type ConditionalSellBody,
} from '../src/conditional/conditional-sell-policy';
import {
  LimitOnCloseEvidenceService,
  SessionCloseEvidenceError,
  type KoscomSessionCloseSource,
  type SessionCloseTarget,
} from '../src/orders/limit-on-close-evidence.service';
import { LimitOnCloseSettlementService } from '../src/orders/limit-on-close-settlement.service';
import type { LimitOnCloseConfig } from '../src/orders/limit-on-close.config';
import { sessionDateText } from '../src/orders/limit-on-close.policy';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { lockSeasonTradingContext } from '../src/seasons/season-trading-lock';

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.CONDITIONAL_SELL_DB_INTEGRATION !== '1'
)
  throw new Error('Explicit disposable conditional SELL PG opt-in required');
process.env.CONDITIONAL_SELL_ORDERS_ENABLED = 'true';
process.env.INDEPENDENT_TP_SL_ORDERS_ENABLED = 'true';
process.env.LOC_SELL_ORDERS_ENABLED = 'true';
// LOC BUY stays off: the SELL flag alone must enable LOC SELL.
process.env.LOC_ORDERS_ENABLED = 'false';
process.env.CONDITIONAL_BUY_ORDERS_ENABLED = 'false';
// Whole-position OCO protection on, for the conflict policy.
process.env.CONDITIONAL_ORDERS_ENABLED = 'true';
process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED = 'true';

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
const candleEvidence = new LimitOrderCandleEvidenceService(db);
const fill = new LimitOrderExecutionService(
  db,
  candleEvidence,
  orders,
  performance,
);
const matcher = new LimitOrderMatchingService(
  db,
  new LimitOrderCandidateRepository(db),
  candleEvidence,
  fill,
);
const conditionalSell = new ConditionalSellService(db, access, orders);
const protection = new ConditionalService(
  db,
  access,
  orders,
  cancel,
  app.futures,
);
const evidence = new LimitOnCloseEvidenceService(db);
/** Dated-close provider double with the KOSCOM observation contract. */
const closes: Array<string | Error> = [];
const source = {
  async observe(target: SessionCloseTarget) {
    const next = closes.shift();
    if (next === undefined || next instanceof Error)
      throw (
        next ?? new SessionCloseEvidenceError('KOSCOM_CLOSE_EVIDENCE_MISSING')
      );
    return {
      provider: 'koscom',
      sourceName: 'koscom_history',
      providerSymbol: target.symbol,
      providerTradingDate: sessionDateText(target.sessionDate).replaceAll(
        '-',
        '',
      ),
      closePrice: D(next),
      currencyCode: 'KRW' as const,
      observedAt: await now(),
      raw: { fixture: 'dated_close', close: next },
    };
  },
} as unknown as KoscomSessionCloseSource;
const settlement = new LimitOnCloseSettlementService(
  db,
  evidence,
  source,
  fill,
  cancel,
);
const CONFIRM_MS = 400;
const locConfig: LimitOnCloseConfig = {
  enabled: false,
  sellEnabled: true,
  evidenceMinDelayMs: 0,
  evidenceConfirmMs: CONFIRM_MS,
  evidenceDeadlineMs: 10_800_000,
};

let checks = 0;
function pass(label: string) {
  checks++;
  console.log(`PASS ConditionalSell ${label}`);
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
type Sell = Scenario & {
  kind: Market;
  assetId: string;
  /** Holding at the start of the scenario (before any sell). */
  startQuantity: Prisma.Decimal;
  startBalance: Prisma.Decimal;
};

const sellWalletWhere = (s: Scenario, kind: Market) => ({
  tradingAccountId: s.accountId,
  walletScope:
    kind === 'BINANCE' ? ('crypto_spot' as const) : ('securities' as const),
  currencyCode: kind === 'BINANCE' ? ('USD' as const) : ('KRW' as const),
});

/** KRX: the fixture asset becomes a domestic stock on an open session. */
async function market(s: Scenario, kind: Market, closeAt?: Date) {
  if (kind === 'BINANCE') return s.instruments[0].asset;
  tradingSessions.set(await now(), closeAt, ['KRX', 'US']);
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
    where: sellWalletWhere(s, 'KRX'),
    data: { balanceAmount: '1000000' },
  });
  return asset;
}
/** Eligible Spot evidence at the DB clock (KRX in-session / Binance Spot). */
async function quote(
  s: Sell | Scenario,
  kind: Market,
  value: string,
  ageMs = 0,
) {
  if (kind === 'BINANCE') return spotPrice(s, value, 0, ageMs);
  const at = await now();
  return db.assetPriceSnapshot.create({
    data: {
      assetId: s.instruments[0].asset.id,
      price: value,
      currencyCode: 'KRW',
      sourceType: 'provider_api',
      sourceName: 'koscom_krx_realtime_price',
      effectiveAt: new Date(at.getTime() - ageMs),
      capturedAt: new Date(at.getTime() - ageMs),
    },
  });
}
/** The starting holding (a fixture row, like the OCO runner's createSpot). */
async function hold(s: Scenario, kind: Market, quantity: string) {
  return db.position.create({
    data: {
      tradingAccountId: s.accountId,
      assetId: s.instruments[0].asset.id,
      quantity,
      averageCost: '100',
      currencyCode: kind === 'BINANCE' ? 'USD' : 'KRW',
    },
  });
}
async function release(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  const assetIds = s.instruments.map((row) => row.asset.id);
  await db.conditionalSellOrder.deleteMany({ where });
  const groups = await db.protectionGroup.findMany({
    where,
    select: { id: true },
  });
  const groupIds = groups.map((row) => row.id);
  await db.protectionChild.deleteMany({ where: { groupId: { in: groupIds } } });
  await db.protectionLeg.deleteMany({ where: { groupId: { in: groupIds } } });
  await db.protectionGroup.deleteMany({ where });
  await db.protectionCommand.deleteMany({ where });
  await db.limitOnCloseOrder.deleteMany({ where });
  await db.order.deleteMany({ where });
  await db.position.deleteMany({ where });
  await db.seasonRanking.deleteMany({ where });
  await db.dailyPortfolioSnapshot.deleteMany({ where });
  await db.sessionClosePriceEvidence.deleteMany({
    where: { assetId: { in: assetIds } },
  });
  await db.limitOrderCandleEvidence.deleteMany({
    where: { assetId: { in: assetIds } },
  });
  await cleanup(s);
}
async function sellScenario(
  mode: 'general' | 'season' | 'beginner',
  kind: Market,
  quantity: string,
  work: (s: Sell) => Promise<void>,
  options: { closeInMs?: number; freshLearning?: boolean } = {},
) {
  const base = await fixture(mode, '10000', options.freshLearning ?? false);
  closes.length = 0;
  try {
    await fxEvidence();
    const closeAt =
      options.closeInMs === undefined
        ? undefined
        : new Date((await now()).getTime() + options.closeInMs);
    const asset = await market(base, kind, closeAt);
    if (D(quantity).gt(0)) await hold(base, kind, quantity);
    await quote(base, kind, '100');
    const wallet = await db.cashWallet.findFirstOrThrow({
      where: sellWalletWhere(base, kind),
    });
    await work({
      ...base,
      kind,
      assetId: asset.id,
      startQuantity: D(quantity),
      startBalance: wallet.balanceAmount,
    });
  } finally {
    tradingSessions.reset();
    await release(base);
  }
}

type IntentBody = Partial<ConditionalSellBody> & Record<string, unknown>;
async function register(s: Sell, body: IntentBody, key: string = randomUUID()) {
  const result = await conditionalSell.create(s.userId, s.accountId, {
    assetId: s.assetId,
    idempotencyKey: key,
    ...body,
  });
  return result.data;
}
async function condition(
  s: Sell,
  patch: {
    triggerCondition: 'at_or_above' | 'at_or_below';
    triggerPrice: string;
    quantity: string;
    executionType?: 'market' | 'limit';
    limitPrice?: string;
  },
) {
  const data = await register(s, {
    kind: 'condition',
    executionType: 'market',
    ...patch,
  });
  assert.equal(data.conditionalOrders.length, 1);
  return data.conditionalOrders[0].id;
}
type Leg = {
  triggerPrice: string;
  quantity: string;
  executionType?: 'market' | 'limit';
  limitPrice?: string;
};
async function tpSl(s: Sell, legs: { stopLoss?: Leg; takeProfit?: Leg }) {
  const leg = (value?: Leg) =>
    value ? { executionType: 'market', ...value } : undefined;
  const data = await register(s, {
    kind: 'protection',
    stopLoss: leg(legs.stopLoss),
    takeProfit: leg(legs.takeProfit),
  });
  const id = (kind: string) =>
    data.conditionalOrders.find((row) => row.kind === kind)?.id;
  return { stopLoss: id('stop_loss'), takeProfit: id('take_profit'), data };
}
const intent = (id: string) =>
  db.conditionalSellOrder.findUniqueOrThrow({
    where: { id },
    include: { order: true },
  });
const view = async (s: Sell, id: string) =>
  (await conditionalSell.get(s.userId, s.accountId, id)).data.conditionalOrder;
const position = (s: Sell) =>
  db.position.findUniqueOrThrow({
    where: {
      tradingAccountId_assetId: {
        tradingAccountId: s.accountId,
        assetId: s.assetId,
      },
    },
  });
const evaluate = async (id: string) =>
  (await conditionalSell.evaluate(id)).state;

/** Ordinary user order through the real quote → create core. */
async function userOrder(s: Sell, body: OrderRequestBody) {
  const request = { assetId: s.assetId, ...body };
  const quoted = await orders.quoteOrderForTradingAccount(
    s.userId,
    s.accountId,
    request,
  );
  return orders.createOrderForTradingAccount(s.userId, s.accountId, {
    ...request,
    quantity: quoted.data.quantity,
    quoteId: quoted.data.quoteId,
    idempotencyKey: randomUUID(),
  });
}
const marketSell = (s: Sell, quantity: string) =>
  userOrder(s, { side: 'sell', orderType: 'market', quantity });
const limitSell = (s: Sell, quantity: string, limitPrice: string) =>
  userOrder(s, { side: 'sell', orderType: 'limit', quantity, limitPrice });

/**
 * Financial invariants after every scenario step that can move money:
 * holding never negative, reservation never above holding and equal to the
 * submitted sells' own reservations, holding = start − every executed sell
 * (+ explicit buys), one sell ledger credit per executed sell and the wallet
 * moved by exactly their net amounts, and every intent at most one order no
 * larger than its target.
 */
async function invariants(s: Sell, bought = D(0)) {
  const p = await position(s);
  assert.ok(p.quantity.gte(0), 'holding never negative');
  assert.ok(p.reservedQuantity.gte(0), 'reservation never negative');
  assert.ok(p.reservedQuantity.lte(p.quantity), 'reservation ≤ holding');
  const sells = await db.order.findMany({
    where: { tradingAccountId: s.accountId, assetId: s.assetId, side: 'sell' },
  });
  const executed = sells.filter((row) => row.status === 'executed');
  const submitted = sells.filter((row) => row.status === 'submitted');
  const sold = executed.reduce(
    (sum, row) => sum.add(row.executedQuantity ?? row.quantity),
    D(0),
  );
  assert.equal(
    s.startQuantity.add(bought).sub(sold).toFixed(8),
    p.quantity.toFixed(8),
    'holding = start + buys − executed sells',
  );
  assert.equal(
    submitted
      .reduce((sum, row) => sum.add(row.reservedQuantity ?? 0), D(0))
      .toFixed(8),
    p.reservedQuantity.toFixed(8),
    'position reservation = submitted sells’ reservations',
  );
  const credits = await db.walletTransaction.findMany({
    where: { tradingAccountId: s.accountId, txType: 'order_sell' },
  });
  assert.equal(credits.length, executed.length, 'one credit per executed sell');
  const net = executed.reduce((sum, row) => sum.add(row.netAmount ?? 0), D(0));
  assert.equal(
    credits.reduce((sum, row) => sum.add(row.amount), D(0)).toFixed(8),
    net.toFixed(8),
  );
  const debits = await db.walletTransaction.findMany({
    where: { tradingAccountId: s.accountId, txType: 'order_buy' },
  });
  const wallet = await db.cashWallet.findFirstOrThrow({
    where: sellWalletWhere(s, s.kind),
  });
  assert.equal(
    wallet.balanceAmount.toFixed(8),
    s.startBalance
      .add(net)
      .sub(debits.reduce((sum, row) => sum.add(row.amount), D(0)))
      .toFixed(8),
    'wallet moved by exactly the executed net amounts',
  );
  const intents = await db.conditionalSellOrder.findMany({
    where: { tradingAccountId: s.accountId },
    include: { order: true },
  });
  for (const row of intents) {
    assert.equal(row.status === 'ordered', row.orderId !== null);
    if (row.order) {
      assert.equal(row.order.side, 'sell');
      assert.ok(row.order.quantity.lte(row.quantity), 'order ≤ target');
    }
  }
  return { position: p, executed, submitted, intents };
}

async function main() {
  await db.$connect();
  try {
    await run();
  } finally {
    await db.fxRateSnapshot.deleteMany({
      where: { id: { in: fxEvidenceIds } },
    });
  }
}

// Scenario sections are appended below (quantity sync, conditional SELL,
// independent stop-loss/take-profit, LOC SELL, races, lifecycle).

// ── A. Several SELL settings on one holding: >100% allowed, never oversold ──

/** A1: 10 held, two 10-share settings fire together: one sale of 10. */
async function sameTargetTwice(mode: 'general' | 'season', kind: Market) {
  await sellScenario(mode, kind, '10', async (s) => {
    const a = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '10',
    });
    const b = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '10',
    });
    // 200% of the holding is a valid setting; nothing is reserved.
    let p = await position(s);
    assert.equal(p.reservedQuantity.toFixed(8), '0.00000000');
    assert.equal(
      (await view(s, a)).position?.executableQuantity,
      '10.00000000',
    );
    assert.equal(
      (await view(s, b)).position?.executableQuantity,
      '10.00000000',
    );
    await quote(s, kind, '95');
    assert.equal(await evaluate(a), 'ordered');
    // The selling transaction itself ended the other setting.
    const other = await intent(b);
    assert.equal(other.status, 'canceled');
    assert.equal(other.terminalReason, 'position_closed');
    assert.equal(await evaluate(b), 'terminal');
    const result = await invariants(s);
    assert.equal(result.executed.length, 1);
    assert.equal(result.executed[0].quantity.toFixed(0), '10');
    p = await position(s);
    assert.equal(p.quantity.toFixed(8), '0.00000000');
    assert.equal((await view(s, a)).state, 'filled');
    pass(
      `${mode} ${kind} 10 held, settings 10 + 10: one sale of 10, other ends position_closed`,
    );
  });
}

/** A2: 10 held, 6 + 6: the second sells only the 4 left (shown as limited). */
async function overlappingTargets(mode: 'general' | 'season', kind: Market) {
  await sellScenario(mode, kind, '10', async (s) => {
    const a = await condition(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      quantity: '6',
    });
    const b = await condition(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      quantity: '6',
    });
    await quote(s, kind, '105');
    assert.equal(await evaluate(a), 'ordered');
    // Re-evaluated against the real remainder, not the 6 it asked for.
    const live = await view(s, b);
    assert.equal(live.state, 'watching');
    assert.equal(live.position?.holdingQuantity, '4.00000000');
    assert.equal(live.position?.executableQuantity, '4.00000000');
    assert.equal(await evaluate(b), 'ordered');
    const second = await intent(b);
    assert.equal(second.order?.quantity.toFixed(8), '4.00000000');
    assert.equal(second.executionAvailableQuantity?.toFixed(8), '4.00000000');
    const shown = await view(s, b);
    assert.equal(shown.quantity, '6.00000000');
    assert.equal(shown.order?.quantity, '4.00000000');
    assert.equal(shown.quantityLimited, true);
    assert.equal(shown.state, 'filled');
    const result = await invariants(s);
    assert.equal(result.position.quantity.toFixed(8), '0.00000000');
    assert.equal(result.executed.length, 2);
    pass(
      `${mode} ${kind} 10 held, settings 6 + 6: 6 then the 4 left, target kept as 6`,
    );
  });
}

/** A4/A10: an earlier partial sale shrinks what a later setting can sell. */
async function soldBeforeTrigger(kind: Market) {
  await sellScenario('general', kind, '10', async (s) => {
    const id = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '10',
    });
    await marketSell(s, '6');
    let live = await view(s, id);
    assert.equal(live.position?.holdingQuantity, '4.00000000');
    assert.equal(live.position?.executableQuantity, '4.00000000');
    await marketSell(s, '1.5');
    live = await view(s, id);
    assert.equal(live.position?.executableQuantity, '2.50000000');
    await quote(s, kind, '95');
    assert.equal(await evaluate(id), 'ordered');
    const row = await intent(id);
    assert.equal(row.order?.quantity.toFixed(8), '2.50000000');
    const result = await invariants(s);
    assert.equal(result.position.quantity.toFixed(8), '0.00000000');
    assert.equal(result.executed.length, 3);
    pass(
      `${kind} partial sales first: setting of 10 sells the 2.5 really left`,
    );
  });
}

/** A5: an existing 6-share limit reservation is respected, never taken. */
async function existingReservation(kind: Market) {
  await sellScenario('general', kind, '10', async (s) => {
    const limit = await limitSell(s, '6', '130');
    const limitId = limit.data.order.orderId;
    let p = await position(s);
    assert.equal(p.reservedQuantity.toFixed(8), '6.00000000');
    // The setting may target the whole holding; only 4 are free to sell.
    await rejects(
      condition(s, {
        triggerCondition: 'at_or_below',
        triggerPrice: '95',
        quantity: '10.5',
      }),
      'CONDITIONAL_SELL_QUANTITY_EXCEEDS_HOLDING',
    );
    const id = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '10',
    });
    const live = await view(s, id);
    assert.equal(live.position?.reservedQuantity, '6.00000000');
    assert.equal(live.position?.availableQuantity, '4.00000000');
    assert.equal(live.position?.executableQuantity, '4.00000000');
    await quote(s, kind, '95');
    assert.equal(await evaluate(id), 'ordered');
    assert.equal((await intent(id)).order?.quantity.toFixed(8), '4.00000000');
    // The limit order still owns its 6 and was not canceled.
    const kept = await db.order.findUniqueOrThrow({ where: { id: limitId } });
    assert.equal(kept.status, 'submitted');
    assert.equal(kept.reservedQuantity?.toFixed(8), '6.00000000');
    p = (await invariants(s)).position;
    assert.equal(p.quantity.toFixed(8), '6.00000000');
    assert.equal(p.reservedQuantity.toFixed(8), '6.00000000');
    // Its own cancel releases exactly its reservation, once.
    await orders.cancelOrderForTradingAccount(s.userId, s.accountId, limitId);
    await orders.cancelOrderForTradingAccount(s.userId, s.accountId, limitId);
    p = (await invariants(s)).position;
    assert.equal(p.reservedQuantity.toFixed(8), '0.00000000');
    pass(
      `${kind} 6 reserved by a limit sell: a 10-share setting sells the free 4, reservation kept`,
    );
  });
}

/** A2-style zero case: everything reserved → no order, clear failure. */
async function nothingFree(kind: Market) {
  await sellScenario('season', kind, '10', async (s) => {
    const limit = await limitSell(s, '10', '130');
    const id = await condition(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      quantity: '5',
    });
    assert.equal((await view(s, id)).position?.executableQuantity, null);
    await quote(s, kind, '105');
    assert.equal(await evaluate(id), 'CONDITIONAL_SELL_QUANTITY_UNAVAILABLE');
    const row = await intent(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.terminalReason, 'quantity_unavailable');
    assert.equal(row.failureCode, 'CONDITIONAL_SELL_QUANTITY_UNAVAILABLE');
    assert.equal(row.executionAvailableQuantity?.toFixed(8), '0.00000000');
    assert.equal(row.orderId, null);
    const result = await invariants(s);
    assert.equal(result.executed.length, 0);
    assert.equal(
      (
        await db.order.findUniqueOrThrow({
          where: { id: limit.data.order.orderId },
        })
      ).status,
      'submitted',
    );
    pass(
      `${kind} all 10 reserved elsewhere: triggered setting ends quantity_unavailable, no order`,
    );
  });
}

// ── D. Independent stop-loss / take-profit (not OCO) ──

/** SL only, TP only, and both with their own quantities (sum > 100%). */
async function independentTpSl(kind: Market) {
  await sellScenario('general', kind, '10', async (s) => {
    const only = await tpSl(s, {
      stopLoss: { triggerPrice: '90', quantity: '3' },
    });
    assert.ok(only.stopLoss && !only.takeProfit);
    const tpOnly = await tpSl(s, {
      takeProfit: { triggerPrice: '120', quantity: '2' },
    });
    assert.ok(tpOnly.takeProfit && !tpOnly.stopLoss);
    const pair = await tpSl(s, {
      stopLoss: { triggerPrice: '95', quantity: '10' },
      takeProfit: { triggerPrice: '110', quantity: '6' },
    });
    assert.ok(pair.stopLoss && pair.takeProfit);
    assert.equal(pair.data.conditionalOrders.length, 2);
    // Kind ↔ direction is fixed: SL at or below, TP at or above.
    const sl = await intent(pair.stopLoss!);
    const tp = await intent(pair.takeProfit!);
    assert.equal(sl.triggerCondition, 'at_or_below');
    assert.equal(tp.triggerCondition, 'at_or_above');
    assert.equal(sl.idempotencyKey, tp.idempotencyKey);
    // TP fires: 6 sold, the SL keeps watching (no OCO cancel) for the rest.
    await quote(s, kind, '110');
    assert.equal(await evaluate(pair.takeProfit!), 'ordered');
    assert.equal(await evaluate(pair.stopLoss!), 'watching');
    const slLive = await view(s, pair.stopLoss!);
    assert.equal(slLive.state, 'watching');
    assert.equal(slLive.triggerPrice, '95.00000000');
    assert.equal(slLive.quantity, '10.00000000');
    assert.equal(slLive.position?.executableQuantity, '4.00000000');
    // Its price stays the user's; the drop sells the 4 really left.
    await quote(s, kind, '94');
    assert.equal(await evaluate(pair.stopLoss!), 'ordered');
    assert.equal(
      (await intent(pair.stopLoss!)).order?.quantity.toFixed(8),
      '4.00000000',
    );
    // The 3-share SL (also met) and the TP-only setting ended with the holding.
    for (const id of [only.stopLoss!, tpOnly.takeProfit!]) {
      const row = await intent(id);
      assert.equal(row.status, 'canceled');
      assert.equal(row.terminalReason, 'position_closed');
    }
    const result = await invariants(s);
    assert.equal(result.position.quantity.toFixed(8), '0.00000000');
    assert.equal(result.executed.length, 2);
    pass(
      `${kind} SL-only, TP-only, SL10+TP6: TP sells 6, SL stays armed and sells the 4 left`,
    );
  });
  await sellScenario('season', kind, '10', async (s) => {
    const pair = await tpSl(s, {
      stopLoss: { triggerPrice: '95', quantity: '10' },
      takeProfit: { triggerPrice: '110', quantity: '10' },
    });
    await quote(s, kind, '111');
    assert.equal(await evaluate(pair.takeProfit!), 'ordered');
    const sl = await intent(pair.stopLoss!);
    assert.equal(sl.status, 'canceled');
    assert.equal(sl.terminalReason, 'position_closed');
    const result = await invariants(s);
    assert.equal(result.executed.length, 1);
    assert.equal(result.executed[0].quantity.toFixed(0), '10');
    pass(`${kind} SL10 + TP10 on 10: TP sells 10, SL ends with the holding`);
  });
}

/** A limit TP waits with its reservation while the SL fires on the rest. */
async function pendingLimitThenOpposite(kind: Market) {
  await sellScenario('general', kind, '10', async (s) => {
    const pair = await tpSl(s, {
      stopLoss: { triggerPrice: '95', quantity: '10' },
      takeProfit: {
        triggerPrice: '110',
        quantity: '6',
        executionType: 'limit',
        limitPrice: '112',
      },
    });
    await quote(s, kind, '110');
    assert.equal(await evaluate(pair.takeProfit!), 'ordered');
    const tp = await intent(pair.takeProfit!);
    assert.equal(tp.order?.status, 'submitted');
    assert.equal(tp.order?.limitPrice?.toFixed(2), '112.00');
    assert.equal(tp.order?.reservedQuantity?.toFixed(8), '6.00000000');
    assert.equal((await view(s, pair.takeProfit!)).state, 'order_pending');
    // Opposite condition: only the unreserved 4 can be sold; the pending TP
    // keeps its reservation (never taken, never silently canceled).
    await quote(s, kind, '95');
    assert.equal(await evaluate(pair.stopLoss!), 'ordered');
    assert.equal(
      (await intent(pair.stopLoss!)).order?.quantity.toFixed(8),
      '4.00000000',
    );
    let result = await invariants(s);
    assert.equal(result.position.quantity.toFixed(8), '6.00000000');
    assert.equal(result.position.reservedQuantity.toFixed(8), '6.00000000');
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: tp.orderId! } })).status,
      'submitted',
    );
    // The limit TP later fills through the existing matcher (path A).
    await fxEvidence();
    await quote(s, kind, '113');
    const summary = await matcher.matchDueLimitOrders({ now: await now() });
    assert.equal(summary.filledPathA, 1);
    result = await invariants(s);
    assert.equal(result.position.quantity.toFixed(8), '0.00000000');
    assert.equal(result.position.reservedQuantity.toFixed(8), '0.00000000');
    assert.equal((await view(s, pair.takeProfit!)).state, 'filled');
    assert.equal(
      (
        await db.order.findUniqueOrThrow({ where: { id: tp.orderId! } })
      ).executedPrice?.toFixed(2),
      '113.00',
    );
    pass(
      `${kind} limit TP pending (6 reserved) + SL fires: SL sells 4, TP fills later via matcher`,
    );
  });
}

/** Whole-position OCO and independent SELL intents never share a holding. */
async function ocoConflict() {
  await sellScenario('general', 'BINANCE', '10', async (s) => {
    const p = await position(s);
    const groupId = (
      (await protection.create(s.userId, s.accountId, {
        domain: 'spot',
        assetId: s.assetId,
        positionId: p.id,
        legs: [
          { kind: 'stop_loss', triggerPrice: '90', childOrderType: 'market' },
        ],
        idempotencyKey: randomUUID(),
      })) as { data: { groupId: string } }
    ).data.groupId;
    await rejects(
      condition(s, {
        triggerCondition: 'at_or_below',
        triggerPrice: '95',
        quantity: '5',
      }),
      'PROTECTION_CONFLICT',
    );
    await rejects(
      tpSl(s, { takeProfit: { triggerPrice: '110', quantity: '5' } }),
      'PROTECTION_CONFLICT',
    );
    // A LOC/limit SELL keeps the existing limit-vs-protection conflict too.
    await rejects(limitSell(s, '5', '130'), 'PROTECTION_CONFLICT');
    // The existing OCO group is untouched and still cancelable.
    await protection.cancelGroup(s.userId, s.accountId, groupId, {
      idempotencyKey: randomUUID(),
    });
    const id = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '5',
    });
    // …and the reverse: OCO registration is refused while intents are live.
    await rejects(
      protection.create(s.userId, s.accountId, {
        domain: 'spot',
        assetId: s.assetId,
        positionId: p.id,
        legs: [
          { kind: 'stop_loss', triggerPrice: '90', childOrderType: 'market' },
        ],
        idempotencyKey: randomUUID(),
      }),
      'CONDITIONAL_SELL_CONFLICT',
    );
    await conditionalSell.cancel(s.userId, s.accountId, id);
    await protection.create(s.userId, s.accountId, {
      domain: 'spot',
      assetId: s.assetId,
      positionId: p.id,
      legs: [
        { kind: 'stop_loss', triggerPrice: '90', childOrderType: 'market' },
      ],
      idempotencyKey: randomUUID(),
    });
    pass(
      'OCO protection ⟂ SELL intents in both directions; existing OCO untouched',
    );
  });
}

// ── C. KRX Limit-on-Close SELL ──

async function locSell(
  s: Sell,
  quantity: string,
  limitPrice = '100',
  key: string = randomUUID(),
) {
  const body: OrderRequestBody = {
    assetId: s.assetId,
    side: 'sell',
    orderType: 'limit',
    quantity,
    limitPrice,
    limitOnClose: true,
  };
  const quoted = await orders.quoteOrderForTradingAccount(
    s.userId,
    s.accountId,
    body,
  );
  const data = quoted.data as typeof quoted.data & {
    quantityAdjustment?: {
      requestedQuantity: string;
      acceptedQuantity: string;
      availableQuantity: string;
    } | null;
    limitOnClose?: { sessionDate: string };
  };
  const created = await orders.createOrderForTradingAccount(
    s.userId,
    s.accountId,
    {
      ...body,
      quantity: data.quantity,
      ...(data.quantityAdjustment
        ? { requestedQuantity: data.quantityAdjustment.requestedQuantity }
        : {}),
      quoteId: data.quoteId,
      idempotencyKey: key,
    },
  );
  return { quote: data, created, orderId: created.data.order.orderId, key };
}
async function waitDb(ms: number) {
  await untilDb((await now()).getTime() + ms);
}
async function finalClose(s: Sell, close: string) {
  const row = await db.limitOnCloseOrder.findFirstOrThrow({
    where: { tradingAccountId: s.accountId },
  });
  const target: SessionCloseTarget = {
    assetId: s.assetId,
    symbol: s.instruments[0].asset.symbol,
    assetMarket: 'KRX',
    market: 'KRX',
    sessionDate: row.sessionDate,
    sessionCloseAt: row.sessionCloseAt,
  };
  closes.push(close, close);
  await evidence.recordObservation(
    target,
    await source.observe(target),
    CONFIRM_MS,
  );
  await waitDb(CONFIRM_MS + 50);
  const final = await evidence.recordObservation(
    target,
    await source.observe(target),
    CONFIRM_MS,
  );
  assert.equal(final?.status, 'final');
  return final!;
}
async function settleAfterClose(s: Sell) {
  const row = await db.limitOnCloseOrder.findFirstOrThrow({
    where: { tradingAccountId: s.accountId },
  });
  await untilDb(row.sessionCloseAt.getTime() + 50);
  await fxEvidence();
  return settlement.runCycle({ config: locConfig });
}

/** Close vs limit for a SELL: below → unfilled, equal/above → fill AT CLOSE. */
async function locSellDecision(close: string, expect: 'fill' | 'unfilled') {
  await sellScenario(
    'general',
    'KRX',
    '10',
    async (s) => {
      const { quote: q, created, orderId } = await locSell(s, '4', '100');
      assert.equal(q.limitOnClose?.sessionDate, '2026-07-10');
      assert.equal(q.quantityAdjustment, null);
      assert.equal(created.data.order.status, 'submitted');
      assert.equal(created.data.order.side, 'sell');
      assert.equal(created.data.order.limitOnClose?.status, 'pending');
      assert.equal(
        (
          created.data as {
            executionPolicy?: { autoExecutionEnabled: boolean };
          }
        ).executionPolicy?.autoExecutionEnabled,
        false,
      );
      // Position quantity (not cash) is reserved for exactly the order.
      let p = (await invariants(s)).position;
      assert.equal(p.reservedQuantity.toFixed(8), '4.00000000');
      // Neither realtime prices nor the continuous matcher fill it.
      await quote(s, 'KRX', '150');
      await matcher.matchDueLimitOrders({ now: await now() });
      assert.equal(
        (await db.order.findUniqueOrThrow({ where: { id: orderId } })).status,
        'submitted',
      );
      await settleAfterClose(s);
      const final = await finalClose(s, close);
      const summary = await settlement.runCycle({ config: locConfig });
      const order = await db.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { limitOnClose: true },
      });
      p = (await invariants(s)).position;
      assert.equal(p.reservedQuantity.toFixed(8), '0.00000000');
      if (expect === 'fill') {
        assert.equal(summary.filled, 1);
        assert.equal(order.status, 'executed');
        // The execution price is the final close, never the limit.
        assert.equal(order.executedPrice?.toFixed(2), D(close).toFixed(2));
        assert.equal(order.sessionCloseEvidenceId, final.id);
        assert.equal(order.limitOnClose?.status, 'filled');
        assert.equal(order.limitOnClose?.decisionReason, 'loc_close_reached');
        assert.equal(p.quantity.toFixed(8), '6.00000000');
      } else {
        assert.equal(summary.unfilled, 1);
        assert.equal(order.status, 'canceled');
        assert.equal(order.cancelReason, 'loc_close_not_reached');
        assert.equal(order.limitOnClose?.status, 'unfilled');
        assert.equal(p.quantity.toFixed(8), '10.00000000');
      }
      // A rerun of settlement changes nothing.
      await settlement.runCycle({ config: locConfig });
      await invariants(s);
      pass(
        `LOC SELL limit 100, final close ${close} → ${expect}${expect === 'fill' ? ' at the close' : ', reservation released'}`,
      );
    },
    { closeInMs: 2500 },
  );
}

/** A6: an existing 6-share limit reservation; LOC SELL accepts only the 4 left. */
async function locSellSizing() {
  await sellScenario(
    'season',
    'KRX',
    '10',
    async (s) => {
      await limitSell(s, '6', '130');
      const first = await locSell(s, '10', '100');
      assert.deepEqual(first.quote.quantityAdjustment, {
        reason: 'available_quantity',
        requestedQuantity: '10.000000',
        acceptedQuantity: '4.000000',
        availableQuantity: '4.000000',
      });
      assert.equal(first.quote.quantity, '4.000000');
      assert.equal(first.created.data.order.quantity, '4.000000');
      assert.equal(
        first.created.data.order.limitOnClose?.requestedQuantity,
        '10.00000000',
      );
      let p = (await invariants(s)).position;
      assert.equal(p.reservedQuantity.toFixed(8), '10.00000000');
      // Nothing unreserved is left: refused, nothing reserved twice.
      await rejects(locSell(s, '1', '100'), 'INSUFFICIENT_QUANTITY');
      // More than the holding is refused outright.
      await rejects(locSell(s, '11', '100'), 'INSUFFICIENT_QUANTITY');
      // A setting registered now finds nothing free when it fires.
      const id = await condition(s, {
        triggerCondition: 'at_or_below',
        triggerPrice: '95',
        quantity: '10',
      });
      await quote(s, 'KRX', '95');
      assert.equal(await evaluate(id), 'CONDITIONAL_SELL_QUANTITY_UNAVAILABLE');
      p = (await invariants(s)).position;
      assert.equal(p.reservedQuantity.toFixed(8), '10.00000000');
      // A replay of the same LOC create is the same order, not a new one.
      const replay = await orders.createOrderForTradingAccount(
        s.userId,
        s.accountId,
        {
          assetId: s.assetId,
          side: 'sell',
          orderType: 'limit',
          quantity: '4',
          limitPrice: '100',
          limitOnClose: true,
          requestedQuantity: '10',
          quoteId: first.created.data.order.quoteId!,
          idempotencyKey: first.key,
        },
      );
      assert.equal(replay.data.order.orderId, first.orderId);
      // The same key with another requested quantity is a different request.
      await rejects(
        orders.createOrderForTradingAccount(s.userId, s.accountId, {
          assetId: s.assetId,
          side: 'sell',
          orderType: 'limit',
          quantity: '4',
          limitPrice: '100',
          limitOnClose: true,
          requestedQuantity: '9',
          quoteId: first.created.data.order.quoteId!,
          idempotencyKey: first.key,
        }),
        'ORDER_IDEMPOTENCY_CONFLICT',
      );
      p = (await invariants(s)).position;
      assert.equal(p.reservedQuantity.toFixed(8), '10.00000000');
      pass(
        'LOC SELL with 6 reserved elsewhere: requested 10, accepted/reserved 4; nothing reserved twice',
      );
    },
    { closeInMs: 6000 },
  );
}

/** LOC SELL registration gates, cancel and expiry release. */
async function locSellRules() {
  await sellScenario(
    'general',
    'KRX',
    '10',
    async (s) => {
      process.env.LOC_SELL_ORDERS_ENABLED = 'false';
      process.env.LOC_ORDERS_ENABLED = 'true';
      try {
        await rejects(locSell(s, '2'), 'LOC_SELL_ORDERS_DISABLED');
      } finally {
        process.env.LOC_SELL_ORDERS_ENABLED = 'true';
        process.env.LOC_ORDERS_ENABLED = 'false';
      }
      await rejects(
        orders.quoteOrderForTradingAccount(s.userId, s.accountId, {
          assetId: s.assetId,
          side: 'sell',
          orderType: 'limit',
          quantity: '2',
          limitPrice: '100',
          limitOnClose: true,
          attachedProtection: [
            { kind: 'stop_loss', triggerPrice: '90', childOrderType: 'market' },
          ],
        }),
        'INVALID_ATTACHED_ENTRY',
      );
      await rejects(
        orders.createOrderForTradingAccount(s.userId, s.accountId, {
          assetId: s.assetId,
          side: 'sell',
          orderType: 'limit',
          quantity: '2',
          limitPrice: '100',
          requestedQuantity: '3',
          quoteId: randomUUID(),
          idempotencyKey: randomUUID(),
        }),
        'INVALID_LIMIT_ON_CLOSE',
      );
      // User cancel releases the reservation exactly once.
      const placed = await locSell(s, '3');
      let p = (await invariants(s)).position;
      assert.equal(p.reservedQuantity.toFixed(8), '3.00000000');
      await orders.cancelOrderForTradingAccount(
        s.userId,
        s.accountId,
        placed.orderId,
      );
      await orders.cancelOrderForTradingAccount(
        s.userId,
        s.accountId,
        placed.orderId,
      );
      const canceled = await db.order.findUniqueOrThrow({
        where: { id: placed.orderId },
        include: { limitOnClose: true },
      });
      assert.equal(canceled.limitOnClose?.status, 'canceled');
      p = (await invariants(s)).position;
      assert.equal(p.reservedQuantity.toFixed(8), '0.00000000');
      // No final evidence by the deadline: expires and releases.
      const expiring = await locSell(s, '2');
      await settleAfterClose(s);
      await db.limitOnCloseOrder.update({
        where: { orderId: expiring.orderId },
        data: { evidenceDeadlineAt: new Date((await now()).getTime() - 1) },
      });
      const summary = await settlement.runCycle({ config: locConfig });
      assert.equal(summary.expired.loc_close_evidence_unavailable, 1);
      const expired = await db.order.findUniqueOrThrow({
        where: { id: expiring.orderId },
        include: { limitOnClose: true },
      });
      assert.equal(expired.status, 'canceled');
      assert.equal(expired.limitOnClose?.status, 'expired');
      p = (await invariants(s)).position;
      assert.equal(p.reservedQuantity.toFixed(8), '0.00000000');
      assert.equal(p.quantity.toFixed(8), '10.00000000');
      // After the close the session no longer accepts LOC.
      await rejects(locSell(s, '1'), 'LOC_SESSION_NOT_OPEN');
      pass(
        'LOC SELL flag separate from BUY, attached/requestedQuantity rules, cancel and expiry release once',
      );
    },
    { closeInMs: 5000 },
  );
  // Crypto has no LOC; US waits for an approved close data provider.
  await sellScenario('general', 'BINANCE', '10', async (s) => {
    await rejects(locSell(s, '2'), 'LOC_MARKET_NOT_SUPPORTED');
    pass('LOC SELL refused for crypto');
  });
}

/** Only the bound session's own final close settles a LOC SELL; two
 * concurrent settlement runs fill it once. */
async function locSellEvidenceAndRaces() {
  await sellScenario(
    'general',
    'KRX',
    '10',
    async (s) => {
      const { orderId } = await locSell(s, '3', '100');
      const row = await db.limitOnCloseOrder.findUniqueOrThrow({
        where: { orderId },
      });
      await untilDb(row.sessionCloseAt.getTime() + 50);
      // Final evidence of ANOTHER session date never fills this order.
      const otherDate = new Date(row.sessionDate.getTime() - 86_400_000);
      const other: SessionCloseTarget = {
        assetId: s.assetId,
        symbol: s.instruments[0].asset.symbol,
        assetMarket: 'KRX',
        market: 'KRX',
        sessionDate: otherDate,
        sessionCloseAt: new Date(row.sessionCloseAt.getTime() - 86_400_000),
      };
      closes.push('150', '150');
      await evidence.recordObservation(
        other,
        await source.observe(other),
        CONFIRM_MS,
      );
      await waitDb(CONFIRM_MS + 50);
      const wrong = await evidence.recordObservation(
        other,
        await source.observe(other),
        CONFIRM_MS,
      );
      assert.equal(wrong?.status, 'final');
      await fxEvidence();
      const skipped = await fill.fillLimitOrder({
        orderId,
        plan: {
          path: 'session_close',
          executedPrice: D('150'),
          closeEvidenceId: wrong!.id,
        },
      });
      assert.equal(
        skipped.state === 'skipped' ? skipped.reason : skipped.state,
        'session_close_evidence_invalid',
      );
      // A continuous-matcher plan never fills a LOC SELL either.
      const realtimeEvidence = await quote(s, 'KRX', '150');
      const continuous = await fill.fillLimitOrder({
        orderId,
        plan: {
          path: 'snapshot',
          executedPrice: D('150'),
          assetPriceSnapshotId: realtimeEvidence.id,
        },
      });
      assert.equal(
        continuous.state === 'skipped' ? continuous.reason : continuous.state,
        'limit_on_close_order',
      );
      let p = (await invariants(s)).position;
      assert.equal(p.reservedQuantity.toFixed(8), '3.00000000');
      // The real session's final close, then two settlement runs at once.
      await finalClose(s, '120');
      const [first, second] = await Promise.all([
        settlement.runCycle({ config: locConfig }),
        settlement.runCycle({ config: locConfig }),
      ]);
      assert.equal(first.filled + second.filled, 1, 'filled exactly once');
      const order = await db.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      assert.equal(order.status, 'executed');
      assert.equal(order.executedPrice?.toFixed(2), '120.00');
      p = (await invariants(s)).position;
      assert.equal(p.quantity.toFixed(8), '7.00000000');
      assert.equal(p.reservedQuantity.toFixed(8), '0.00000000');
      pass(
        'LOC SELL: other-session evidence and a continuous plan never fill; concurrent settlement fills once',
      );
    },
    { closeInMs: 2500 },
  );
}

/** A season that ends before the close refuses LOC SELL registration. */
async function locSellSeasonEnd() {
  await sellScenario(
    'season',
    'KRX',
    '10',
    async (s) => {
      await db.season.update({
        where: { id: s.season!.id },
        data: { endAt: new Date((await now()).getTime() + 1000) },
      });
      await rejects(locSell(s, '2'), 'LOC_SESSION_AFTER_SEASON_END');
      pass('LOC SELL refused when the session closes after Season end');
    },
    { closeInMs: 5000 },
  );
}

// ── A7–A15. Concurrency, flat holding, re-buy, idempotency, workers ──

/** A7: several settings fire at once; the fence serializes, never oversells. */
async function concurrentTriggers(kind: Market, targets: string[]) {
  await sellScenario('general', kind, '10', async (s) => {
    const ids: string[] = [];
    for (const quantity of targets)
      ids.push(
        await condition(s, {
          triggerCondition: 'at_or_below',
          triggerPrice: '95',
          quantity,
        }),
      );
    await quote(s, kind, '95');
    await Promise.allSettled(ids.map((id) => conditionalSell.evaluate(id)));
    // Retry once for any that lost a race inside its window.
    await Promise.allSettled(ids.map((id) => conditionalSell.evaluate(id)));
    const result = await invariants(s);
    const sold = result.executed.reduce(
      (sum, row) => sum.add(row.quantity),
      D(0),
    );
    assert.ok(sold.lte(10), 'never more than the holding');
    const expected = Prisma.Decimal.min(
      10,
      targets.reduce((sum, value) => sum.add(value), D(0)),
    );
    assert.equal(sold.toFixed(8), expected.toFixed(8));
    for (const row of result.intents)
      assert.ok(
        ['ordered', 'canceled', 'failed'].includes(row.status),
        `settled ${row.status}`,
      );
    pass(
      `${kind} ${targets.join('+')} fire concurrently: ${sold.toFixed(0)} sold of 10, no oversell`,
    );
  });
}

/** A8: a 10-share setting races a manual 10-share market sell: one wins. */
async function manualVsTrigger(kind: Market) {
  await sellScenario('season', kind, '10', async (s) => {
    const id = await condition(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      quantity: '10',
    });
    await quote(s, kind, '105');
    const [manual, automatic] = await Promise.allSettled([
      marketSell(s, '10'),
      conditionalSell.evaluate(id),
    ]);
    const result = await invariants(s);
    assert.equal(result.executed.length, 1, 'exactly one sale of 10');
    assert.equal(result.position.quantity.toFixed(8), '0.00000000');
    const row = await intent(id);
    if (row.status === 'ordered') {
      assert.equal(manual.status, 'rejected');
      assert.equal(code(manual.reason), 'INSUFFICIENT_QUANTITY');
    } else {
      assert.equal(manual.status, 'fulfilled');
      assert.ok(['canceled', 'failed'].includes(row.status));
      assert.ok(automatic.status === 'fulfilled');
    }
    pass(
      `${kind} setting 10 vs manual market sell 10 concurrently: one sale (winner: ${row.status === 'ordered' ? 'setting' : 'manual'})`,
    );
  });
}

/** A9: a limit reservation is canceled while a setting fires. */
async function cancelVsFire(kind: Market) {
  await sellScenario('general', kind, '10', async (s) => {
    const limit = await limitSell(s, '10', '130');
    const id = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '10',
    });
    await quote(s, kind, '95');
    await Promise.allSettled([
      orders.cancelOrderForTradingAccount(
        s.userId,
        s.accountId,
        limit.data.order.orderId,
      ),
      conditionalSell.evaluate(id),
    ]);
    const result = await invariants(s);
    const row = await intent(id);
    // Either it sized against the reservation (nothing free) or after the
    // release (all 10): never both the reservation and a sale of the same 10.
    if (row.status === 'ordered')
      assert.equal(result.position.quantity.toFixed(8), '0.00000000');
    else {
      assert.equal(row.terminalReason, 'quantity_unavailable');
      assert.equal(result.position.quantity.toFixed(8), '10.00000000');
    }
    assert.equal(result.position.reservedQuantity.toFixed(8), '0.00000000');
    pass(
      `${kind} reservation cancel vs setting fire: one consistent outcome (${row.status === 'ordered' ? 'cancel first, setting sold 10' : 'setting first, nothing free'})`,
    );
  });
}

/** A11/A12: flat holding ends every setting at once; a re-buy inherits none. */
async function flatThenRebuy() {
  await sellScenario('general', 'KRX', '10', async (s) => {
    const cond = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '10',
    });
    const pair = await tpSl(s, {
      stopLoss: { triggerPrice: '90', quantity: '5' },
      takeProfit: { triggerPrice: '110', quantity: '10' },
    });
    const before = await position(s);
    await marketSell(s, '10');
    // Ended in the selling transaction itself, before any worker pass.
    for (const id of [cond, pair.stopLoss!, pair.takeProfit!]) {
      const row = await intent(id);
      assert.equal(row.status, 'canceled');
      assert.equal(row.terminalReason, 'position_closed');
    }
    // Re-buy the same asset: same position row, a new holding lifetime.
    await quote(s, 'KRX', '100');
    await userOrder(s, { side: 'buy', orderType: 'market', quantity: '7' });
    const after = await position(s);
    assert.equal(after.id, before.id);
    assert.equal(after.quantity.toFixed(8), '7.00000000');
    await quote(s, 'KRX', '89');
    for (const id of [cond, pair.stopLoss!])
      assert.equal(await evaluate(id), 'terminal');
    await quote(s, 'KRX', '111');
    assert.equal(await evaluate(pair.takeProfit!), 'terminal');
    const sells = await db.order.count({
      where: { tradingAccountId: s.accountId, side: 'sell' },
    });
    assert.equal(sells, 1, 'no sale from an earlier holding’s settings');
    await invariants(s, D(7));
    // Registration again works on the new holding (bounded by it).
    await rejects(
      condition(s, {
        triggerCondition: 'at_or_below',
        triggerPrice: '95',
        quantity: '8',
      }),
      'CONDITIONAL_SELL_QUANTITY_EXCEEDS_HOLDING',
    );
    await quote(s, 'KRX', '100');
    await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '7',
    });
    pass(
      'flat holding ends all settings in the same transaction; re-buy inherits none',
    );
  });
}

/** Limit fills that flatten the holding also end the remaining settings. */
async function limitFillFlattens() {
  await sellScenario('general', 'BINANCE', '10', async (s) => {
    const id = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '80',
      quantity: '10',
    });
    await limitSell(s, '10', '101');
    await fxEvidence();
    await quote(s, 'BINANCE', '102');
    const summary = await matcher.matchDueLimitOrders({ now: await now() });
    assert.equal(summary.filledPathA, 1);
    const row = await intent(id);
    assert.equal(row.status, 'canceled');
    assert.equal(row.terminalReason, 'position_closed');
    await invariants(s);
    pass(
      'a limit SELL fill that flattens the holding ends live settings in its transaction',
    );
  });
}

/** A13: create replay, pair replay, executeConditionalSell after commit. */
async function idempotency() {
  await sellScenario('general', 'BINANCE', '10', async (s) => {
    const key = `csell-${randomUUID()}`;
    const body = {
      kind: 'protection',
      stopLoss: { triggerPrice: '90', executionType: 'market', quantity: '4' },
      takeProfit: {
        triggerPrice: '120',
        executionType: 'limit',
        limitPrice: '121',
        quantity: '10',
      },
    };
    const first = await register(s, body, key);
    const replay = await register(s, body, key);
    assert.equal(replay.duplicate, true);
    assert.deepEqual(
      replay.conditionalOrders.map((row) => row.id).sort(),
      first.conditionalOrders.map((row) => row.id).sort(),
    );
    await rejects(
      register(
        s,
        { ...body, takeProfit: { ...body.takeProfit, quantity: '9' } },
        key,
      ),
      'CONDITIONAL_IDEMPOTENCY_CONFLICT',
    );
    await rejects(
      register(
        s,
        {
          kind: 'condition',
          triggerCondition: 'at_or_below',
          triggerPrice: '90',
          executionType: 'market',
          quantity: '4',
        },
        key,
      ),
      'CONDITIONAL_IDEMPOTENCY_CONFLICT',
    );
    assert.equal(
      await db.conditionalSellOrder.count({
        where: { tradingAccountId: s.accountId },
      }),
      2,
    );
    // A committed order: the worker adapter never makes a second one.
    const sl = first.conditionalOrders.find((row) => row.kind === 'stop_loss')!;
    await quote(s, 'BINANCE', '89');
    assert.equal(await evaluate(sl.id), 'ordered');
    assert.equal(
      await orders.executeConditionalSell(s.userId, s.accountId, sl.id),
      null,
    );
    assert.equal(await evaluate(sl.id), 'terminal');
    const result = await invariants(s);
    assert.equal(result.executed.length, 1);
    pass(
      'create/pair replay, conflict on changed body, no second order per intent',
    );
  });
}

/** A14: two workers and a restart never execute one intent twice. */
async function workerDuplicates() {
  await sellScenario('general', 'BINANCE', '10', async (s) => {
    const ids = [
      await condition(s, {
        triggerCondition: 'at_or_below',
        triggerPrice: '95',
        quantity: '3',
      }),
      await condition(s, {
        triggerCondition: 'at_or_below',
        triggerPrice: '95',
        quantity: '3',
      }),
    ];
    await quote(s, 'BINANCE', '94');
    const workers = [0, 1].map(
      () =>
        new ConditionalSellWorker(
          db,
          new OpsJobLockService(db),
          new OpsJobRunService(db),
          conditionalSell,
        ),
    );
    await Promise.all(workers.map((worker) => worker.tick()));
    await Promise.all(workers.map((worker) => worker.tick()));
    // A restarted worker (fresh cursor) only finds terminal rows.
    const restarted = new ConditionalSellWorker(
      db,
      new OpsJobLockService(db),
      new OpsJobRunService(db),
      conditionalSell,
    );
    await restarted.tick();
    // The same intent evaluated twice at once still yields one order.
    for (const id of ids) {
      const row = await intent(id);
      assert.equal(row.status, 'ordered');
    }
    const result = await invariants(s);
    assert.equal(result.executed.length, 2);
    assert.equal(result.position.quantity.toFixed(8), '4.00000000');
    const third = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '93',
      quantity: '4',
    });
    await quote(s, 'BINANCE', '92');
    await Promise.allSettled([
      conditionalSell.evaluate(third),
      conditionalSell.evaluate(third),
    ]);
    assert.equal(
      await db.order.count({
        where: { tradingAccountId: s.accountId, side: 'sell' },
      }),
      3,
    );
    await invariants(s);
    pass('two workers + restart + double evaluate: one order per intent');
  });
}

/** A15: concurrent registrations on one holding all succeed (>100%) up to the cap. */
async function concurrentRegistrations() {
  await sellScenario('general', 'KRX', '10', async (s) => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        condition(s, {
          triggerCondition: 'at_or_below',
          triggerPrice: '95',
          quantity: '10',
        }),
      ),
    );
    assert.equal(
      results.filter((row) => row.status === 'fulfilled').length,
      5,
      'five 100% settings on one holding are valid',
    );
    for (let live = 5; live < CONDITIONAL_SELL_MAX_LIVE_PER_ACCOUNT - 1; live++)
      await condition(s, {
        triggerCondition: 'at_or_above',
        triggerPrice: '150',
        quantity: '1',
      });
    // One slot left: a pair (two rows) does not fit, a single one does.
    await rejects(
      tpSl(s, {
        stopLoss: { triggerPrice: '90', quantity: '1' },
        takeProfit: { triggerPrice: '110', quantity: '1' },
      }),
      'CONDITIONAL_SELL_LIMIT_EXCEEDED',
    );
    await tpSl(s, { stopLoss: { triggerPrice: '90', quantity: '1' } });
    await rejects(
      condition(s, {
        triggerCondition: 'at_or_above',
        triggerPrice: '150',
        quantity: '1',
      }),
      'CONDITIONAL_SELL_LIMIT_EXCEEDED',
    );
    const p = await position(s);
    assert.equal(p.reservedQuantity.toFixed(8), '0.00000000');
    pass(
      `concurrent registrations: 5×100% accepted, cap ${CONDITIONAL_SELL_MAX_LIVE_PER_ACCOUNT} live per account`,
    );
  });
}

// ── B. Conditional SELL rules, evidence, flags, lifecycle ──

async function registrationRules(kind: Market) {
  await sellScenario('season', kind, '10', async (s) => {
    for (const [triggerCondition, triggerPrice] of [
      ['at_or_above', '100'],
      ['at_or_below', '100'],
      ['at_or_above', '99'],
      ['at_or_below', '101'],
    ] as const)
      await rejects(
        condition(s, { triggerCondition, triggerPrice, quantity: '1' }),
        'CONDITIONAL_SELL_ALREADY_MET',
      );
    await rejects(
      tpSl(s, { stopLoss: { triggerPrice: '100', quantity: '1' } }),
      'CONDITIONAL_SELL_ALREADY_MET',
    );
    await rejects(
      tpSl(s, {
        stopLoss: { triggerPrice: '95', quantity: '1' },
        takeProfit: { triggerPrice: '99', quantity: '1' },
      }),
      'CONDITIONAL_SELL_ALREADY_MET',
    );
    await rejects(
      register(s, { kind: 'protection' }),
      'INVALID_CONDITIONAL_SELL',
    );
    await rejects(
      register(s, {
        kind: 'condition',
        triggerCondition: 'at_or_below',
        triggerPrice: '95',
        executionType: 'market',
        limitPrice: '94',
        quantity: '1',
      }),
      'INVALID_CONDITIONAL_SELL',
    );
    if (kind === 'KRX')
      await rejects(
        condition(s, {
          triggerCondition: 'at_or_below',
          triggerPrice: '95',
          executionType: 'limit',
          limitPrice: '94',
          quantity: '1.5',
        }),
        'FRACTIONAL_LIMIT_ORDER_NOT_SUPPORTED',
      );
    // Stale evidence never validates a registration.
    await db.assetPriceSnapshot.deleteMany({ where: { assetId: s.assetId } });
    await quote(s, kind, '100', 60_000);
    await rejects(
      condition(s, {
        triggerCondition: 'at_or_below',
        triggerPrice: '95',
        quantity: '1',
      }),
      'CONDITIONAL_PRICE_UNAVAILABLE',
    );
    assert.equal(
      await db.conditionalSellOrder.count({
        where: { tradingAccountId: s.accountId },
      }),
      0,
    );
    pass(
      `${kind} registration: already met (condition, SL, TP), shape, stock limit unit, stale evidence`,
    );
  });
  await sellScenario('general', kind, '0', async (s) => {
    await rejects(
      condition(s, {
        triggerCondition: 'at_or_below',
        triggerPrice: '95',
        quantity: '1',
      }),
      'CONDITIONAL_SELL_POSITION_UNAVAILABLE',
    );
    pass(`${kind} registration without a holding refused`);
  });
}

async function flags() {
  await sellScenario('general', 'BINANCE', '10', async (s) => {
    const cond = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '5',
    });
    const pair = await tpSl(s, {
      stopLoss: { triggerPrice: '90', quantity: '5' },
    });
    process.env.CONDITIONAL_SELL_ORDERS_ENABLED = 'false';
    process.env.INDEPENDENT_TP_SL_ORDERS_ENABLED = 'false';
    try {
      await rejects(
        condition(s, {
          triggerCondition: 'at_or_below',
          triggerPrice: '95',
          quantity: '1',
        }),
        'CONDITIONAL_SELL_DISABLED',
      );
      await rejects(
        tpSl(s, { stopLoss: { triggerPrice: '90', quantity: '1' } }),
        'INDEPENDENT_TP_SL_DISABLED',
      );
      // Existing rows keep watching (no trigger), read and cancel work.
      await quote(s, 'BINANCE', '80');
      assert.equal(await evaluate(cond), 'disabled');
      assert.equal(await evaluate(pair.stopLoss!), 'disabled');
      const list = await conditionalSell.list(s.userId, s.accountId, {
        state: 'open',
      });
      assert.equal(list.data.capabilities.enabled, false);
      assert.equal(list.data.capabilities.condition.canCreate, false);
      assert.equal(list.data.capabilities.protection.canCreate, false);
      assert.equal(list.data.capabilities.canCancel, true);
      assert.equal(list.data.conditionalOrders.length, 2);
      await conditionalSell.cancel(s.userId, s.accountId, cond);
      assert.equal((await intent(cond)).status, 'canceled');
    } finally {
      process.env.CONDITIONAL_SELL_ORDERS_ENABLED = 'true';
      process.env.INDEPENDENT_TP_SL_ORDERS_ENABLED = 'true';
    }
    // Each kind is gated alone.
    process.env.INDEPENDENT_TP_SL_ORDERS_ENABLED = 'false';
    try {
      await condition(s, {
        triggerCondition: 'at_or_below',
        triggerPrice: '70',
        quantity: '1',
      });
      await rejects(
        tpSl(s, { takeProfit: { triggerPrice: '120', quantity: '1' } }),
        'INDEPENDENT_TP_SL_DISABLED',
      );
    } finally {
      process.env.INDEPENDENT_TP_SL_ORDERS_ENABLED = 'true';
    }
    // Limit execution needs Spot limit registration and the matcher.
    process.env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED = 'false';
    try {
      await rejects(
        condition(s, {
          triggerCondition: 'at_or_below',
          triggerPrice: '70',
          executionType: 'limit',
          limitPrice: '69',
          quantity: '1',
        }),
        'CONDITIONAL_LIMIT_UNAVAILABLE',
      );
    } finally {
      process.env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED = 'true';
    }
    await invariants(s);
    pass(
      'flags off: no new SELL intents, no triggers; read/cancel stay; kinds gated separately',
    );
  });
}

async function evidenceAndSession() {
  await sellScenario('general', 'KRX', '10', async (s) => {
    const id = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '3',
    });
    // Stale and pre-registration evidence never triggers.
    const old = new Date((await now()).getTime() - 60_000);
    await db.assetPriceSnapshot.create({
      data: {
        assetId: s.assetId,
        price: '90',
        currencyCode: 'KRW',
        sourceType: 'provider_api',
        sourceName: 'koscom_krx_realtime_price',
        effectiveAt: old,
        capturedAt: old,
      },
    });
    assert.ok(
      ['watching', 'price_unavailable', 'awaiting_price'].includes(
        await evaluate(id),
      ),
    );
    assert.equal((await intent(id)).status, 'watching');
    // Closed session: no trigger even on a met fresh price.
    tradingSessions.set(
      new Date((await now()).getTime() - 3_600_000),
      new Date((await now()).getTime() - 1000),
      ['KRX', 'US'],
    );
    await quote(s, 'KRX', '90');
    assert.equal(await evaluate(id), 'price_unavailable');
    assert.equal((await intent(id)).status, 'watching');
    // Back in session: the fresh trade triggers and sells.
    tradingSessions.set(await now(), undefined, ['KRX', 'US']);
    await quote(s, 'KRX', '94');
    assert.equal(await evaluate(id), 'ordered');
    const row = await intent(id);
    const evidence = row.triggerEvidenceJson as { price: string; kind: string };
    assert.equal(evidence.price, '94.00000000');
    assert.equal(evidence.kind, 'condition');
    await invariants(s);
    pass(
      'KRX: stale / closed-session evidence never triggers; trigger evidence recorded',
    );
  });
  await sellScenario('general', 'BINANCE', '10', async (s) => {
    const id = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '3',
    });
    // Futures Last at 80 is not Spot evidence: no trigger (the only Spot
    // trade predates registration).
    await futuresLastPrice(s, '80', 0, 0);
    assert.ok(['watching', 'awaiting_price'].includes(await evaluate(id)));
    assert.equal((await intent(id)).status, 'watching');
    await quote(s, 'BINANCE', '96');
    assert.equal(await evaluate(id), 'watching');
    await quote(s, 'BINANCE', '94');
    assert.equal(await evaluate(id), 'ordered');
    const order = (await intent(id)).order!;
    assert.equal(order.executedPrice?.toFixed(2), '94.00');
    await invariants(s);
    pass('crypto: Futures Last never triggers a Spot SELL; Binance Spot does');
  });
}

async function limitExecution(kind: Market) {
  await sellScenario('season', kind, '10', async (s) => {
    const id = await condition(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      executionType: 'limit',
      limitPrice: '107',
      quantity: '4',
    });
    await quote(s, kind, '105');
    assert.equal(await evaluate(id), 'ordered');
    const row = await intent(id);
    assert.equal(row.order?.status, 'submitted');
    assert.equal(row.order?.limitPrice?.toFixed(2), '107.00');
    assert.equal(row.triggerPrice.toFixed(2), '105.00');
    let result = await invariants(s);
    assert.equal(result.position.reservedQuantity.toFixed(8), '4.00000000');
    // The trigger price alone never fills the limit; 107+ does.
    await fxEvidence();
    await quote(s, kind, '106');
    await matcher.matchDueLimitOrders({ now: await now() });
    assert.equal((await intent(id)).order?.status, 'submitted');
    await quote(s, kind, '108');
    const summary = await matcher.matchDueLimitOrders({ now: await now() });
    assert.equal(summary.filledPathA, 1);
    result = await invariants(s);
    assert.equal(result.position.quantity.toFixed(8), '6.00000000');
    assert.equal(result.position.reservedQuantity.toFixed(8), '0.00000000');
    assert.equal((await view(s, id)).state, 'filled');
    // A second one canceled through the ordinary order cancel.
    const other = await condition(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '110',
      executionType: 'limit',
      limitPrice: '115',
      quantity: '2',
    });
    await quote(s, kind, '111');
    assert.equal(await evaluate(other), 'ordered');
    await rejects(
      conditionalSell.cancel(s.userId, s.accountId, other),
      'CONDITIONAL_SELL_ALREADY_ORDERED',
    );
    await orders.cancelOrderForTradingAccount(
      s.userId,
      s.accountId,
      (await intent(other)).orderId!,
    );
    assert.equal((await view(s, other)).state, 'order_canceled');
    result = await invariants(s);
    assert.equal(result.position.reservedQuantity.toFixed(8), '0.00000000');
    pass(
      `${kind} limit execution: separate trigger/limit, matcher fill, ordinary cancel releases`,
    );
  });
}

async function cancelVsTrigger(kind: Market) {
  await sellScenario('general', kind, '10', async (s) => {
    const id = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '5',
    });
    await quote(s, kind, '95');
    await Promise.allSettled([
      conditionalSell.cancel(s.userId, s.accountId, id),
      conditionalSell.evaluate(id),
    ]);
    const row = await intent(id);
    const result = await invariants(s);
    if (row.status === 'ordered') assert.equal(result.executed.length, 1);
    else {
      assert.equal(row.status, 'canceled');
      assert.equal(row.terminalReason, 'user_canceled');
      assert.equal(result.executed.length, 0);
    }
    pass(
      `${kind} user cancel vs trigger: exactly one winner (${row.status === 'ordered' ? 'trigger' : 'cancel'})`,
    );
  });
}

async function lifecycle() {
  await sellScenario('season', 'KRX', '10', async (s) => {
    const a = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '5',
    });
    const pair = await tpSl(s, {
      takeProfit: { triggerPrice: '110', quantity: '5' },
    });
    await db.$transaction(async (tx) => {
      const participant = await tx.seasonParticipant.findUniqueOrThrow({
        where: { tradingAccountId: s.accountId },
      });
      await lockSeasonTradingContext(tx, {
        seasonParticipantId: participant.id,
        participantWrite: true,
      });
      await cancel.cancelOpenLimitBuysForParticipantInTransaction(tx, {
        tradingAccountId: s.accountId,
        reason: 'participant_excluded',
        canceledAt: await now(),
      });
    });
    for (const id of [a, pair.takeProfit!])
      assert.equal((await intent(id)).terminalReason, 'participant_excluded');
    pass('participant exclusion cleanup ends live SELL intents');
  });
  await sellScenario('season', 'KRX', '10', async (s) => {
    const id = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '5',
    });
    await db.season.update({
      where: { id: s.season!.id },
      data: { endAt: new Date((await now()).getTime() - 1000) },
    });
    await quote(s, 'KRX', '94');
    assert.equal(await evaluate(id), 'lifecycle_canceled');
    assert.equal((await intent(id)).terminalReason, 'season_ended');
    assert.equal((await invariants(s)).executed.length, 0);
    pass('season end: met condition never sells after endAt');
  });
  await sellScenario('season', 'BINANCE', '10', async (s) => {
    const id = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '5',
    });
    await db.season.update({
      where: { id: s.season!.id },
      data: {
        status: 'ended',
        endAt: new Date((await now()).getTime() - 1000),
      },
    });
    await cancel.cleanupEndedSeasonLimitReservations({ now: await now() });
    assert.equal((await intent(id)).terminalReason, 'season_ended');
    pass('ended-season lifecycle cleanup ends live SELL intents');
  });
  await sellScenario('general', 'BINANCE', '10', async (s) => {
    const id = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '5',
    });
    await db.tradingAccount.update({
      where: { id: s.accountId },
      data: { status: 'suspended' },
    });
    await quote(s, 'BINANCE', '94');
    assert.equal(await evaluate(id), 'lifecycle_canceled');
    assert.equal((await intent(id)).terminalReason, 'account_not_tradable');
    await db.tradingAccount.update({
      where: { id: s.accountId },
      data: { status: 'active' },
    });
    pass('inactive general account: intent ends account_not_tradable, no sale');
  });
}

async function executionWindow() {
  await sellScenario('general', 'BINANCE', '10', async (s) => {
    const id = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '5',
    });
    // A trigger already 30 s old (restart/outage) never becomes an order.
    const snapshot = await quote(s, 'BINANCE', '94');
    const old = new Date(
      (await now()).getTime() - CONDITIONAL_SELL_EXECUTION_WINDOW_MS - 1000,
    );
    await db.conditionalSellOrder.update({
      where: { id },
      data: {
        status: 'triggered',
        triggeredAt: old,
        triggerSnapshotId: snapshot.id,
        triggerEvidenceJson: { fixture: 'aged trigger' },
      },
    });
    assert.equal(await evaluate(id), 'failed');
    const row = await intent(id);
    assert.equal(row.terminalReason, 'execution_window_expired');
    assert.equal(row.orderId, null);
    assert.equal((await invariants(s)).executed.length, 0);
    pass('trigger older than the 30 s window ends failed, no order');
  });
  await sellScenario('general', 'KRX', '10', async (s) => {
    const id = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      quantity: '5',
    });
    const snapshot = await quote(s, 'KRX', '94');
    await db.conditionalSellOrder.update({
      where: { id },
      data: {
        status: 'triggered',
        triggeredAt: await now(),
        triggerSnapshotId: snapshot.id,
        triggerEvidenceJson: { fixture: 'trigger before close' },
      },
    });
    // The market closed between trigger and execution: no forced sale.
    tradingSessions.set(
      new Date((await now()).getTime() - 3_600_000),
      new Date((await now()).getTime() - 500),
      ['KRX', 'US'],
    );
    const state = await evaluate(id);
    assert.notEqual(state, 'ordered');
    const row = await intent(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.orderId, null);
    assert.equal((await invariants(s)).executed.length, 0);
    pass(`market closed after trigger (${row.failureCode}): failed, no sale`);
  });
}

async function scopeAndBeginner() {
  await sellScenario('general', 'KRX', '10', async (s) => {
    await db.asset.update({
      where: { id: s.assetId },
      data: {
        market: 'NAS',
        assetType: 'us_stock',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
      },
    });
    await rejects(
      condition(s, {
        triggerCondition: 'at_or_below',
        triggerPrice: '95',
        quantity: '1',
      }),
      'CONDITIONAL_SELL_MARKET_NOT_SUPPORTED',
    );
    await rejects(
      tpSl(s, { stopLoss: { triggerPrice: '90', quantity: '1' } }),
      'CONDITIONAL_SELL_MARKET_NOT_SUPPORTED',
    );
    await rejects(locSell(s, '1'), 'LOC_MARKET_NOT_SUPPORTED');
    pass(
      'US stocks: new SELL condition/TP·SL/LOC refused until a data provider is approved',
    );
  });
  await sellScenario(
    'beginner',
    'BINANCE',
    '10',
    async (s) => {
      await rejects(
        condition(s, {
          triggerCondition: 'at_or_below',
          triggerPrice: '95',
          quantity: '1',
        }),
        'BEGINNER_FEATURE_LOCKED',
      );
      await rejects(
        tpSl(s, { stopLoss: { triggerPrice: '90', quantity: '1' } }),
        'BEGINNER_FEATURE_LOCKED',
      );
      // A plain SELL stays risk reduction for a beginner.
      await marketSell(s, '1');
      await invariants(s);
      pass(
        'beginner without full access: SELL automation locked, plain sell allowed',
      );
    },
    { freshLearning: true },
  );
  await sellScenario('general', 'KRX', '10', async (s) => {
    const other = await fixture('general');
    try {
      await rejects(
        conditionalSell.list(other.userId, s.accountId, {}),
        'TRADING_ACCOUNT_NOT_FOUND',
      );
      const id = await condition(s, {
        triggerCondition: 'at_or_below',
        triggerPrice: '95',
        quantity: '1',
      });
      await rejects(
        conditionalSell.cancel(other.userId, s.accountId, id),
        'TRADING_ACCOUNT_NOT_FOUND',
      );
    } finally {
      await cleanup(other);
    }
    pass('another user cannot read or cancel the account’s SELL intents');
  });
}

async function listStates() {
  await sellScenario('general', 'BINANCE', '10', async (s) => {
    const watching = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '80',
      quantity: '1',
    });
    const pending = await condition(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      executionType: 'limit',
      limitPrice: '130',
      quantity: '2',
    });
    const pair = await tpSl(s, {
      stopLoss: { triggerPrice: '70', quantity: '3' },
      takeProfit: { triggerPrice: '140', quantity: '3' },
    });
    const canceled = await condition(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '60',
      quantity: '1',
    });
    await conditionalSell.cancel(s.userId, s.accountId, canceled);
    await quote(s, 'BINANCE', '105');
    assert.equal(await evaluate(pending), 'ordered');
    const list = (query: Record<string, string>) =>
      conditionalSell.list(s.userId, s.accountId, { limit: '100', ...query });
    const ids = (page: Awaited<ReturnType<typeof list>>) =>
      page.data.conditionalOrders.map((row) => row.id).sort();
    assert.deepEqual(
      ids(await list({ state: 'open' })),
      [watching, pending, pair.stopLoss!, pair.takeProfit!].sort(),
    );
    assert.deepEqual(ids(await list({ state: 'ended' })), [canceled]);
    assert.deepEqual(
      ids(await list({ state: 'open', kind: 'protection' })),
      [pair.stopLoss!, pair.takeProfit!].sort(),
    );
    assert.deepEqual(
      ids(await list({ state: 'open', kind: 'condition' })),
      [watching, pending].sort(),
    );
    await rejects(
      conditionalSell.list(s.userId, s.accountId, {
        state: 'open',
        history: 'true',
      }),
      'INVALID_PAGINATION',
    );
    await rejects(
      conditionalSell.list(s.userId, s.accountId, { kind: 'stop_loss' }),
      'INVALID_PAGINATION',
    );
    const open = await list({ state: 'open' });
    const pendingRow = open.data.conditionalOrders.find(
      (row) => row.id === pending,
    )!;
    assert.equal(pendingRow.state, 'order_pending');
    assert.equal(pendingRow.order?.reservedQuantity, '2.00000000');
    // Live rows show today's holding facts; others do not.
    const live = open.data.conditionalOrders.find(
      (row) => row.id === watching,
    )!;
    assert.equal(live.position?.holdingQuantity, '10.00000000');
    assert.equal(live.position?.reservedQuantity, '2.00000000');
    assert.equal(live.position?.availableQuantity, '8.00000000');
    assert.equal(pendingRow.position, null);
    // The account order list names the intent behind a linked order.
    const orderList = await orders.getOrdersForTradingAccount(
      s.userId,
      s.accountId,
      { status: 'submitted' },
    );
    const linked = orderList.data.orders.find(
      (row) => row.orderId === pendingRow.order?.orderId,
    ) as { conditionalSell?: { id: string; kind: string } | null } | undefined;
    assert.deepEqual(linked?.conditionalSell, {
      id: pending,
      kind: 'condition',
    });
    pass(
      'state=open/ended and kind filters; live holding facts; linked order names its intent',
    );
  });
}

async function run() {
  for (const mode of ['general', 'season'] as const)
    for (const kind of ['KRX', 'BINANCE'] as const) {
      await sameTargetTwice(mode, kind);
      await overlappingTargets(mode, kind);
    }
  for (const kind of ['KRX', 'BINANCE'] as const) {
    await soldBeforeTrigger(kind);
    await existingReservation(kind);
    await nothingFree(kind);
    await independentTpSl(kind);
    await pendingLimitThenOpposite(kind);
    await registrationRules(kind);
    await limitExecution(kind);
    await concurrentTriggers(kind, ['10', '10', '10']);
    await concurrentTriggers(kind, ['6', '6', '6']);
    await manualVsTrigger(kind);
    await cancelVsFire(kind);
    await cancelVsTrigger(kind);
  }
  await ocoConflict();
  await flatThenRebuy();
  await limitFillFlattens();
  await idempotency();
  await workerDuplicates();
  await concurrentRegistrations();
  await flags();
  await evidenceAndSession();
  await lifecycle();
  await executionWindow();
  await scopeAndBeginner();
  await listStates();
  for (const [close, expect] of [
    ['99', 'unfilled'],
    ['100', 'fill'],
    ['101.5', 'fill'],
  ] as const)
    await locSellDecision(close, expect);
  await locSellSizing();
  await locSellEvidenceAndRaces();
  await locSellRules();
  await locSellSeasonEnd();
  console.log(`Conditional SELL PostgreSQL PASS (${checks} scenarios)`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
