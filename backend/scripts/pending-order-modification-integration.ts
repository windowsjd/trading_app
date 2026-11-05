import { tradingSessions } from '../test/support/trading-session-fixture';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  app,
  cleanup,
  code,
  db,
  fixture,
  fxEvidence,
  fxEvidenceIds,
  holdRowLock,
  now,
  price as futuresLastPrice,
  spotPrice,
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
import { LimitOrderCandidateRepository } from '../src/orders/limit-order-candidate.repository';
import { LimitOrderMatchingService } from '../src/orders/limit-order-matching.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { ConditionalBuyService } from '../src/conditional/conditional-buy.service';
import { ConditionalSellService } from '../src/conditional/conditional-sell.service';
import { EntryTpSlService } from '../src/conditional/entry-tp-sl.service';
import { FuturesLimitService } from '../src/futures/futures-limit.service';
import { FuturesConditionalEntryService } from '../src/futures/futures-conditional-entry.service';
import { FuturesTpSlService } from '../src/futures/futures-tp-sl.service';
import { PendingOrderEventsService } from '../src/pending-order-events/pending-order-events.service';

/**
 * 대기주문·설정 변경 on actual PostgreSQL
 * (docs/pending-order-modification-contract.md): every modifiable type, its
 * guards (state, revision, idempotency, unchanged terms, create rules), the
 * reservation it moves (cash, holding, Futures collateral) and the moved
 * evidence floor, plus a change racing a cancel and a fill on the same rows.
 */
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.PENDING_ORDER_MODIFY_DB_INTEGRATION !== '1'
)
  throw new Error(
    'Explicit disposable pending-order-modification PG opt-in required',
  );
process.env.CONDITIONAL_BUY_ORDERS_ENABLED = 'true';
process.env.CONDITIONAL_SELL_ORDERS_ENABLED = 'true';
process.env.INDEPENDENT_TP_SL_ORDERS_ENABLED = 'true';
process.env.FUTURES_TP_SL_ORDERS_ENABLED = 'true';
process.env.FUTURES_CONDITIONAL_ENTRY_ENABLED = 'true';
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED = 'true';
process.env.CONDITIONAL_ORDERS_ENABLED = 'false';
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
const conditionalBuy = new ConditionalBuyService(db, access, orders);
const conditionalSell = new ConditionalSellService(db, access, orders);
const plans = new EntryTpSlService(db, access);
const futuresLimits = new FuturesLimitService(db, access, app.futures);
const futuresEntries = new FuturesConditionalEntryService(
  db,
  access,
  app.futures,
  futuresLimits,
);
const futuresTpSl = new FuturesTpSlService(db, access, app.futures);
const events = new PendingOrderEventsService(db, access);

let checks = 0;
function pass(label: string) {
  checks++;
  console.log(`PASS PendingOrderModify ${label}`);
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
const settle = <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, code: code(error) }),
  );

async function release(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  await db.pendingOrderModification.deleteMany({ where });
  await db.entryTpSlPlan.deleteMany({ where });
  await db.futuresTpSlSetting.deleteMany({ where });
  await db.conditionalSellOrder.deleteMany({ where });
  await db.conditionalBuyOrder.deleteMany({ where });
  await db.futuresConditionalEntry.deleteMany({ where });
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
    await release(s);
  }
}

const spotWallet = async (s: Scenario) => {
  const row = await db.cashWallet.findUniqueOrThrow({
    where: { id: s.spotWalletId },
  });
  return { balance: row.balanceAmount, reserved: row.reservedAmount };
};
const futuresWallet = async (s: Scenario) =>
  db.cashWallet.findUniqueOrThrow({ where: { id: s.futuresWalletId } });
const order = (id: string) => db.order.findUniqueOrThrow({ where: { id } });
const modifications = (targetId: string) =>
  db.pendingOrderModification.findMany({
    where: { targetId },
    orderBy: { revision: 'asc' },
  });
/** A late-arriving Spot trade from just before `at` (captured now). */
async function lateSpot(s: Scenario, value: string, at: Date) {
  return db.assetPriceSnapshot.create({
    data: {
      assetId: s.instruments[0].asset.id,
      price: value,
      currencyCode: 'USD',
      sourceType: 'provider_api',
      sourceName: 'binance_spot_ws_ticker',
      effectiveAt: new Date(at.getTime() - 200),
      capturedAt: await now(),
    },
  });
}
async function freshFutures(s: Scenario, value: string) {
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
async function spotOrder(s: Scenario, body: OrderRequestBody) {
  const payload = { assetId: s.instruments[0].asset.id, ...body };
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
      ...(body.side === 'sell' ? { quantity: quoted.data.quantity } : {}),
      quoteId: quoted.data.quoteId,
      idempotencyKey: randomUUID(),
    },
  );
  return result.data.order.orderId;
}
const modifySpot = (
  s: Scenario,
  orderId: string,
  body: Record<string, unknown>,
) =>
  orders.modifyOrderForTradingAccount(s.userId, s.accountId, orderId, {
    idempotencyKey: randomUUID(),
    ...body,
  });

/** Conditional BUY: guards, replay, create rules and the moved trigger floor. */
async function conditionalBuyChange(mode: 'general' | 'season') {
  await scenario(mode, async (s) => {
    await spotPrice(s, '100', 0, 1000);
    const created = await conditionalBuy.create(s.userId, s.accountId, {
      assetId: s.instruments[0].asset.id,
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      executionType: 'market',
      amount: '100',
      idempotencyKey: randomUUID(),
    });
    const id = created.data.conditionalOrder.id;
    const registeredAt = (
      await db.conditionalBuyOrder.findUniqueOrThrow({ where: { id } })
    ).createdAt;
    const body = {
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      triggerCondition: 'at_or_below',
      triggerPrice: '90',
      executionType: 'market',
      amount: '50',
    };
    const first = await conditionalBuy.modify(s.userId, s.accountId, id, body);
    assert.equal(first.data.duplicate, false);
    assert.deepEqual(
      [
        first.data.conditionalOrder.revision,
        first.data.conditionalOrder.triggerPrice,
        first.data.conditionalOrder.amount,
      ],
      [1, '90.00000000', '50.00000000'],
    );
    const row = await db.conditionalBuyOrder.findUniqueOrThrow({
      where: { id },
    });
    assert.ok(row.revisedAt && row.revisedAt >= registeredAt);
    assert.equal(
      row.createdAt.getTime(),
      registeredAt.getTime(),
      'first registration time stays',
    );
    // A lost response retried with the same key replays; another body under it conflicts.
    const replay = await conditionalBuy.modify(s.userId, s.accountId, id, body);
    assert.equal(replay.data.duplicate, true);
    assert.equal((await modifications(id)).length, 1);
    const recorded = (await modifications(id))[0];
    assert.equal(
      (recorded.beforeJson as { triggerPrice: string }).triggerPrice,
      '95.00000000',
    );
    assert.equal(
      (recorded.afterJson as { triggerPrice: string }).triggerPrice,
      '90.00000000',
    );
    await rejects(
      conditionalBuy.modify(s.userId, s.accountId, id, {
        ...body,
        triggerPrice: '91',
      }),
      'PENDING_ORDER_MODIFY_IDEMPOTENCY_CONFLICT',
    );
    const next = { ...body, idempotencyKey: randomUUID() };
    await rejects(
      conditionalBuy.modify(s.userId, s.accountId, id, {
        ...next,
        triggerPrice: '91',
      }),
      'PENDING_ORDER_CHANGED',
    );
    await rejects(
      conditionalBuy.modify(s.userId, s.accountId, id, {
        ...next,
        expectedRevision: 1,
      }),
      'PENDING_ORDER_UNCHANGED',
    );
    await rejects(
      conditionalBuy.modify(s.userId, s.accountId, id, {
        ...next,
        expectedRevision: 1,
        triggerPrice: '101',
      }),
      'CONDITIONAL_BUY_ALREADY_MET',
    );
    const kept = await db.conditionalBuyOrder.findUniqueOrThrow({
      where: { id },
    });
    assert.deepEqual(
      [kept.revision, kept.triggerPrice.toFixed(2)],
      [1, '90.00'],
      'refused changes move nothing',
    );
    // A trade from before the change never fires the changed terms.
    await lateSpot(s, '89', kept.revisedAt!);
    assert.equal((await conditionalBuy.evaluate(id)).state, 'awaiting_price');
    await spotPrice(s, '89', 0, 0);
    assert.equal((await conditionalBuy.evaluate(id)).state, 'ordered');
    const ordered = await db.conditionalBuyOrder.findUniqueOrThrow({
      where: { id },
      include: { order: true },
    });
    assert.equal(ordered.order?.status, 'executed');
    await rejects(
      conditionalBuy.modify(s.userId, s.accountId, id, {
        ...next,
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        triggerPrice: '85',
      }),
      'PENDING_ORDER_NOT_MODIFIABLE',
    );
    pass(
      `${mode} conditional BUY: replay/conflict/stale/unchanged/already-met guards, floor moved to the change`,
    );
  });
}

/** Spot limit BUY by amount: reservation moves by the difference, never more than available. */
async function spotLimitBuyChange(mode: 'general' | 'season') {
  await scenario(mode, async (s) => {
    await spotPrice(s, '100', 0, 1000);
    const orderId = await spotOrder(s, {
      side: 'buy',
      orderType: 'limit',
      amount: '100',
      limitPrice: '90',
    });
    const placed = await order(orderId);
    assert.equal(
      (await spotWallet(s)).reserved.toFixed(8),
      placed.reservedAmount!.toFixed(8),
    );
    const up = await modifySpot(s, orderId, {
      expectedRevision: 0,
      limitPrice: '80',
      amount: '200',
    });
    assert.equal(up.data.duplicate, false);
    const raised = await order(orderId);
    assert.deepEqual(
      [
        raised.limitPrice!.toFixed(2),
        raised.quantity.toFixed(8),
        raised.revision,
      ],
      ['80.00', '2.50000000', 1],
    );
    assert.equal(
      raised.submittedAt.getTime(),
      placed.submittedAt.getTime(),
      'submission time stays',
    );
    assert.ok(raised.reservedAmount!.gt(placed.reservedAmount!));
    assert.equal(
      raised.reservedAmount!.toFixed(8),
      D('200')
        .add(D('200').mul(placed.reservationFeeRate!))
        .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP)
        .toFixed(8),
      'reserved at the order’s pinned fee rate',
    );
    assert.equal(
      (await spotWallet(s)).reserved.toFixed(8),
      raised.reservedAmount!.toFixed(8),
    );
    // More than the available cash: refused whole, nothing moves.
    await rejects(
      modifySpot(s, orderId, {
        expectedRevision: 1,
        limitPrice: '80',
        amount: '5000',
      }),
      'INSUFFICIENT_AVAILABLE_BALANCE',
    );
    assert.equal((await order(orderId)).revision, 1);
    assert.equal(
      (await spotWallet(s)).reserved.toFixed(8),
      raised.reservedAmount!.toFixed(8),
    );
    assert.equal((await modifications(orderId)).length, 1);
    const down = await modifySpot(s, orderId, {
      expectedRevision: 1,
      limitPrice: '85',
      amount: '50',
    });
    assert.equal(down.data.order.revision, 2);
    const lowered = await order(orderId);
    assert.equal(
      (await spotWallet(s)).reserved.toFixed(8),
      lowered.reservedAmount!.toFixed(8),
    );
    // A trade from before the change fills neither through the matcher nor the fill re-check.
    const late = await lateSpot(s, '84', lowered.revisedAt!);
    await fxEvidence();
    const skipped = await fill.fillLimitOrder({
      orderId,
      plan: {
        path: 'snapshot',
        assetPriceSnapshotId: late.id,
        executedPrice: D('84'),
      },
    });
    assert.equal(skipped.state, 'skipped');
    await matcher.matchDueLimitOrders({ now: await now() });
    assert.equal((await order(orderId)).status, 'submitted');
    await spotPrice(s, '84', 0, 0);
    await fxEvidence();
    await matcher.matchDueLimitOrders({ now: await now() });
    const filled = await order(orderId);
    assert.deepEqual(
      [filled.status, filled.executedPrice?.toFixed(2)],
      ['executed', '84.00'],
    );
    assert.equal((await spotWallet(s)).reserved.toFixed(8), '0.00000000');
    await rejects(
      modifySpot(s, orderId, {
        expectedRevision: 2,
        limitPrice: '83',
        amount: '50',
      }),
      'PENDING_ORDER_NOT_MODIFIABLE',
    );
    pass(
      `${mode} Spot limit BUY: reservation up/down by the difference, shortage refused whole, pre-change trade never fills`,
    );
  });
}

/** Spot guards: a retired asset, one key raced on two orders, a replay after the Season closed. */
async function spotGuards() {
  await scenario('season', async (s) => {
    await spotPrice(s, '100', 0, 1000);
    const first = await spotOrder(s, {
      side: 'buy',
      orderType: 'limit',
      amount: '100',
      limitPrice: '90',
    });
    const second = await spotOrder(s, {
      side: 'buy',
      orderType: 'limit',
      amount: '100',
      limitPrice: '91',
    });
    const reserved = async () => (await spotWallet(s)).reserved.toFixed(8);
    const ordersReserved = async () =>
      (await order(first))
        .reservedAmount!.add((await order(second)).reservedAmount!)
        .toFixed(8);
    assert.equal(await reserved(), await ordersReserved());
    // A retired asset takes no new terms, as a registration is refused.
    const assetId = s.instruments[0].asset.id;
    await db.asset.update({
      where: { id: assetId },
      data: { isActive: false },
    });
    try {
      await rejects(
        modifySpot(s, first, {
          expectedRevision: 0,
          limitPrice: '80',
          amount: '200',
        }),
        'ASSET_NOT_TRADABLE',
      );
    } finally {
      await db.asset.update({
        where: { id: assetId },
        data: { isActive: true },
      });
    }
    assert.equal((await order(first)).revision, 0);
    assert.equal(await reserved(), await ordersReserved());
    // One key on two orders at once (Season Spot shares the participant
    // lock): one change and one conflict, never a 500; nothing else moves.
    const key = randomUUID();
    const terms = [
      { limitPrice: '85', amount: '150' },
      { limitPrice: '86', amount: '150' },
    ];
    const raced = await Promise.all(
      [first, second].map((id, index) =>
        settle(
          orders.modifyOrderForTradingAccount(s.userId, s.accountId, id, {
            idempotencyKey: key,
            expectedRevision: 0,
            ...terms[index],
          }),
        ),
      ),
    );
    assert.deepEqual(raced.map((r) => (r.ok ? 'ok' : r.code)).sort(), [
      'PENDING_ORDER_MODIFY_IDEMPOTENCY_CONFLICT',
      'ok',
    ]);
    assert.equal(
      await db.pendingOrderModification.count({
        where: { tradingAccountId: s.accountId },
      }),
      1,
    );
    assert.equal(await reserved(), await ordersReserved());
    // The Season closes after the change committed and its answer was lost:
    // the retry still finds its commit, before any Season check.
    const changed = raced[0].ok ? 0 : 1;
    const changedId = [first, second][changed];
    const participant = await db.seasonParticipant.findFirstOrThrow({
      where: { tradingAccountId: s.accountId },
    });
    const season = await db.season.findUniqueOrThrow({
      where: { id: participant.seasonId },
    });
    await db.season.update({
      where: { id: season.id },
      data: { endAt: new Date((await now()).getTime() - 1000) },
    });
    try {
      const replay = await orders.modifyOrderForTradingAccount(
        s.userId,
        s.accountId,
        changedId,
        { idempotencyKey: key, expectedRevision: 0, ...terms[changed] },
      );
      assert.equal(replay.data.duplicate, true);
      await rejects(
        orders.modifyOrderForTradingAccount(s.userId, s.accountId, changedId, {
          idempotencyKey: key,
          expectedRevision: 0,
          limitPrice: '70',
          amount: '150',
        }),
        'PENDING_ORDER_MODIFY_IDEMPOTENCY_CONFLICT',
      );
      await rejects(
        modifySpot(s, changedId, {
          expectedRevision: 1,
          limitPrice: '70',
          amount: '150',
        }),
        'SEASON_ENDED',
      );
    } finally {
      await db.season.update({
        where: { id: season.id },
        data: { endAt: season.endAt },
      });
    }
    assert.equal(
      await db.pendingOrderModification.count({
        where: { tradingAccountId: s.accountId },
      }),
      1,
    );
    pass(
      'Spot guards: retired asset refused, one key raced on two orders = one change + 409, replay after the Season closed = duplicate',
    );
  });
}

/** A change and a cancel of one order serialize on its row; the reservation never leaks. */
async function changeRacesCancel() {
  await scenario('general', async (s) => {
    await spotPrice(s, '100', 0, 1000);
    const orderId = await spotOrder(s, {
      side: 'buy',
      orderType: 'limit',
      amount: '100',
      limitPrice: '90',
    });
    const held = await holdRowLock(
      (tx) =>
        tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`,
    );
    const changing = settle(
      modifySpot(s, orderId, {
        expectedRevision: 0,
        limitPrice: '80',
        amount: '200',
      }),
    );
    await untilLockWaiting();
    const canceling = settle(
      orders.cancelOrderForTradingAccount(s.userId, s.accountId, orderId),
    );
    await held.release();
    const [changed, canceled] = await Promise.all([changing, canceling]);
    assert.equal(canceled.ok, true);
    const final = await order(orderId);
    assert.equal(final.status, 'canceled');
    assert.ok(final.reservationReleasedAt);
    assert.equal(
      (await spotWallet(s)).reserved.toFixed(8),
      '0.00000000',
      'the reservation the order held is released, whichever ran first',
    );
    if (changed.ok) assert.equal(final.revision, 1);
    else assert.equal(changed.code, 'PENDING_ORDER_NOT_MODIFIABLE');
    pass(
      `change vs cancel: serialized on the order row (${changed.ok ? 'change first' : 'cancel first'}), nothing left reserved`,
    );
  });
}

/** The fill takes the same fence: whichever commits first decides, never both terms. */
async function changeRacesFill() {
  for (const first of ['change', 'fill'] as const)
    await scenario('general', async (s) => {
      await spotPrice(s, '100', 0, 1000);
      const orderId = await spotOrder(s, {
        side: 'buy',
        orderType: 'limit',
        amount: '100',
        limitPrice: '90',
      });
      const trade = await spotPrice(s, '89', 0, 0);
      await fxEvidence();
      const held = await holdRowLock(
        (tx) =>
          tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`,
      );
      const change = () =>
        settle(
          modifySpot(s, orderId, {
            expectedRevision: 0,
            limitPrice: '85',
            amount: '100',
          }),
        );
      const fillIt = () =>
        settle(
          fill.fillLimitOrder({
            orderId,
            plan: {
              path: 'snapshot',
              assetPriceSnapshotId: trade.id,
              executedPrice: D('89'),
            },
          }),
        );
      const a = first === 'change' ? change() : fillIt();
      await untilLockWaiting();
      const b = first === 'change' ? fillIt() : change();
      await held.release();
      const [ra, rb] = await Promise.all([a, b]);
      const final = await order(orderId);
      const wallet = await spotWallet(s);
      if (first === 'change') {
        assert.equal(ra.ok, true);
        assert.deepEqual(
          [final.status, final.limitPrice!.toFixed(2), final.revision],
          ['submitted', '85.00', 1],
        );
        assert.equal(
          wallet.reserved.toFixed(8),
          final.reservedAmount!.toFixed(8),
        );
      } else {
        assert.equal(
          rb.ok ? 'RESOLVED' : rb.code,
          'PENDING_ORDER_NOT_MODIFIABLE',
        );
        assert.deepEqual(
          [final.status, final.executedPrice?.toFixed(2), final.revision],
          ['executed', '89.00', 0],
        );
        assert.equal(wallet.reserved.toFixed(8), '0.00000000');
      }
      pass(
        `change vs fill (${first} first): one outcome, reservation consistent`,
      );
    });
}

/** Spot limit SELL: the holding reservation follows the quantity; more than the holding is refused. */
async function spotLimitSellChange() {
  await scenario('general', async (s) => {
    await spotPrice(s, '100', 0, 1000);
    await fxEvidence();
    await spotOrder(s, { side: 'buy', orderType: 'market', amount: '500' });
    const holding = () =>
      db.position.findUniqueOrThrow({
        where: {
          tradingAccountId_assetId: {
            tradingAccountId: s.accountId,
            assetId: s.instruments[0].asset.id,
          },
        },
      });
    const sellId = await spotOrder(s, {
      side: 'sell',
      orderType: 'limit',
      quantity: '1',
      limitPrice: '120',
    });
    assert.equal((await holding()).reservedQuantity.toFixed(8), '1.00000000');
    await modifySpot(s, sellId, {
      expectedRevision: 0,
      limitPrice: '130',
      quantity: '2',
    });
    assert.deepEqual(
      [
        (await holding()).reservedQuantity.toFixed(8),
        (await order(sellId)).reservedQuantity!.toFixed(8),
      ],
      ['2.00000000', '2.00000000'],
    );
    await rejects(
      modifySpot(s, sellId, {
        expectedRevision: 1,
        limitPrice: '130',
        quantity: '100',
      }),
      'INSUFFICIENT_QUANTITY',
    );
    assert.equal((await holding()).reservedQuantity.toFixed(8), '2.00000000');
    await modifySpot(s, sellId, {
      expectedRevision: 1,
      limitPrice: '125',
      quantity: '0.5',
    });
    assert.equal((await holding()).reservedQuantity.toFixed(8), '0.50000000');
    pass(
      'Spot limit SELL: holding reservation follows the quantity, shortage refused whole',
    );
  });
}

/** Futures limit entry: collateral reservation re-derived as at registration and moved by the difference. */
async function futuresLimitChange() {
  await scenario('general', async (s) => {
    await freshFutures(s, '100');
    const placed = (
      await futuresLimits.create(s.userId, s.accountId, {
        instrumentId: s.instruments[0].instrument.id,
        direction: 'long',
        marginMode: 'isolated',
        quantity: '1',
        leverage: 5,
        limitPrice: '95',
        idempotencyKey: randomUUID(),
      })
    ).data.order;
    assert.equal(
      (await futuresWallet(s)).reservedAmount.toFixed(8),
      placed.reservedAmount,
    );
    const changed = (
      await futuresLimits.modify(s.userId, s.accountId, placed.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 0,
        limitPrice: '90',
        quantity: '2',
      })
    ).data.order;
    assert.deepEqual(
      [changed.limitPrice, changed.quantity, changed.revision],
      ['90.00000000', '2.00000000', 1],
    );
    assert.ok(D(changed.reservedAmount).gt(placed.reservedAmount));
    assert.equal(
      (await futuresWallet(s)).reservedAmount.toFixed(8),
      changed.reservedAmount,
    );
    await rejects(
      futuresLimits.modify(s.userId, s.accountId, placed.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        limitPrice: '90',
        quantity: '5000',
      }),
      'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
    );
    assert.equal(
      (await futuresWallet(s)).reservedAmount.toFixed(8),
      changed.reservedAmount,
    );
    const lowered = (
      await futuresLimits.modify(s.userId, s.accountId, placed.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        limitPrice: '92',
        quantity: '0.5',
      })
    ).data.order;
    assert.equal(
      (await futuresWallet(s)).reservedAmount.toFixed(8),
      lowered.reservedAmount,
    );
    await futuresLimits.cancel(s.userId, s.accountId, placed.id);
    assert.equal(
      (await futuresWallet(s)).reservedAmount.toFixed(8),
      '0.00000000',
      'cancel releases the changed reservation',
    );
    pass(
      'Futures limit entry: collateral reservation up/down, shortage refused, cancel releases exactly',
    );
  });
}

/** Conditional SELL stop-loss: per-kind totals and prices against the OTHER live settings. */
async function conditionalSellChange() {
  await scenario('general', async (s) => {
    await spotPrice(s, '100', 0, 1000);
    await fxEvidence();
    await spotOrder(s, { side: 'buy', orderType: 'market', amount: '500' });
    const holding = await db.position.findUniqueOrThrow({
      where: {
        tradingAccountId_assetId: {
          tradingAccountId: s.accountId,
          assetId: s.instruments[0].asset.id,
        },
      },
    });
    const register = async (triggerPrice: string, quantity: string) =>
      (
        await conditionalSell.create(s.userId, s.accountId, {
          assetId: s.instruments[0].asset.id,
          kind: 'protection',
          stopLoss: { triggerPrice, executionType: 'market', quantity },
          idempotencyKey: randomUUID(),
        })
      ).data.conditionalOrders[0].id;
    const a = await register('90', '1');
    await register('85', '3');
    const change = (body: Record<string, unknown>) =>
      conditionalSell.modify(s.userId, s.accountId, a, {
        idempotencyKey: randomUUID(),
        executionType: 'market',
        ...body,
      });
    const over = holding.quantity.sub(3).add('0.5').toFixed(6);
    await rejects(
      change({ expectedRevision: 0, triggerPrice: '90', quantity: over }),
      'CONDITIONAL_SELL_TOTAL_EXCEEDS_HOLDING',
    );
    await rejects(
      change({ expectedRevision: 0, triggerPrice: '85', quantity: '1' }),
      'CONDITIONAL_SELL_DUPLICATE_PRICE',
    );
    await rejects(
      change({
        expectedRevision: 0,
        triggerPrice: '88',
        executionType: 'limit',
        limitPrice: '87',
        quantity: '1',
      }),
      'INVALID_CONDITIONAL_SELL',
    );
    const changed = (
      await change({ expectedRevision: 0, triggerPrice: '88', quantity: '1.5' })
    ).data.conditionalOrder;
    assert.deepEqual(
      [
        changed.triggerPrice,
        changed.quantity,
        changed.executionType,
        changed.revision,
      ],
      ['88.00000000', '1.50000000', 'market', 1],
    );
    pass(
      'conditional SELL stop-loss: totals and prices against the other live settings, still market only',
    );
  });
}

/** Entry plans: a plan change and an entry price change both keep the plan protective. */
async function entryPlanChange() {
  await scenario('general', async (s) => {
    await spotPrice(s, '100', 0, 1000);
    const orderId = await spotOrder(s, {
      side: 'buy',
      orderType: 'limit',
      amount: '100',
      limitPrice: '90',
    });
    const plan = (
      await plans.create(s.userId, s.accountId, {
        entryType: 'spot_limit_order',
        entryId: orderId,
        stopLoss: { triggerPrice: '80', ratio: 50 },
        idempotencyKey: randomUUID(),
      })
    ).data.plans[0];
    const change = (body: Record<string, unknown>) =>
      plans.modify(s.userId, s.accountId, plan.id, {
        idempotencyKey: randomUUID(),
        ...body,
      });
    await rejects(
      change({ expectedRevision: 0, triggerPrice: '95', ratio: 50 }),
      'ENTRY_TP_SL_INVALID_TRIGGER',
    );
    const changed = (
      await change({ expectedRevision: 0, triggerPrice: '85', ratio: 70 })
    ).data.plan;
    assert.deepEqual(
      [changed.triggerPrice, changed.ratioPercent, changed.revision],
      ['85.00000000', 70, 1],
    );
    // The entry cannot move below its pending stop-loss.
    await rejects(
      modifySpot(s, orderId, {
        expectedRevision: 0,
        limitPrice: '84',
        amount: '100',
      }),
      'PENDING_ORDER_ENTRY_PLAN_CONFLICT',
    );
    assert.equal((await order(orderId)).revision, 0);
    pass(
      'entry plans: plan side vs entry price, entry change refused when it would strand a plan',
    );
  });
}

/** Futures TP/SL and conditional entry: create rules on the new terms and the moved floor. */
async function futuresSettingsChange() {
  await scenario('general', async (s) => {
    await freshFutures(s, '100');
    await app.futures.execute(s.userId, s.accountId, {
      instrumentId: s.instruments[0].instrument.id,
      operation: 'open',
      direction: 'long' satisfies FuturesDirection,
      quantity: '2',
      leverage: 5,
      idempotencyKey: randomUUID(),
    });
    const position = await db.futuresPosition.findFirstOrThrow({
      where: { tradingAccountId: s.accountId, status: 'open' },
    });
    const setting = (
      await futuresTpSl.create(s.userId, s.accountId, {
        positionId: position.id,
        stopLoss: { triggerPrice: '90', quantity: '1' },
        idempotencyKey: randomUUID(),
      })
    ).data.settings[0];
    await rejects(
      futuresTpSl.modify(s.userId, s.accountId, setting.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 0,
        triggerPrice: '85',
        quantity: '3',
      }),
      'FUTURES_TP_SL_QUANTITY_EXCEEDS_POSITION',
    );
    await rejects(
      futuresTpSl.modify(s.userId, s.accountId, setting.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 0,
        triggerPrice: '101',
        quantity: '1',
      }),
      'FUTURES_TP_SL_ALREADY_MET',
    );
    const changed = (
      await futuresTpSl.modify(s.userId, s.accountId, setting.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: 0,
        triggerPrice: '85',
        quantity: '2',
      })
    ).data.setting;
    assert.deepEqual(
      [changed.triggerPrice, changed.quantity, changed.revision],
      ['85.00000000', '2.00000000', 1],
    );
    pass(
      'Futures stop-loss: position bound and already-met rules on the change',
    );
  });
  await scenario('general', async (s) => {
    await freshFutures(s, '100');
    const entry = (
      await futuresEntries.create(s.userId, s.accountId, {
        instrumentId: s.instruments[0].instrument.id,
        direction: 'long',
        marginMode: 'isolated',
        leverage: 5,
        quantity: '1',
        triggerCondition: 'at_or_below',
        triggerPrice: '95',
        executionType: 'market',
        idempotencyKey: randomUUID(),
      })
    ).data.entry;
    const change = (body: Record<string, unknown>) =>
      futuresEntries.modify(s.userId, s.accountId, entry.id, {
        idempotencyKey: randomUUID(),
        triggerCondition: 'at_or_below',
        executionType: 'market',
        ...body,
      });
    await rejects(
      change({ expectedRevision: 0, triggerPrice: '101', quantity: '1' }),
      'FUTURES_CONDITIONAL_ENTRY_ALREADY_MET',
    );
    const changed = (
      await change({ expectedRevision: 0, triggerPrice: '92', quantity: '2' })
    ).data.entry;
    assert.deepEqual(
      [changed.triggerPrice, changed.quantity, changed.revision],
      ['92.00000000', '2.00000000', 1],
    );
    const row = await db.futuresConditionalEntry.findUniqueOrThrow({
      where: { id: entry.id },
    });
    // A Futures Last from before the change never fires it.
    await db.futuresLastPriceSnapshot.create({
      data: {
        instrumentId: s.instruments[0].instrument.id,
        symbol: s.instruments[0].asset.symbol,
        price: '91',
        source: 'binance_usdm_agg_trade_ws',
        effectiveAt: new Date(row.revisedAt!.getTime() - 200),
        capturedAt: new Date(row.revisedAt!.getTime() - 100),
      },
    });
    assert.equal(
      (await futuresEntries.evaluate(entry.id)).state,
      'awaiting_price',
    );
    pass(
      'Futures conditional entry: already-met rule on the change, pre-change Last never fires it',
    );
  });
}

/**
 * Trigger/fill notices (docs/pending-order-events-contract.md) from committed
 * rows: no cursor lists nothing; a limit trigger is listed while its order
 * waits; a condition met and filled at once is ONE fill; a direct market
 * order and a canceled order are no event; another user's account is refused.
 */
async function eventFeed() {
  await scenario('general', async (s) => {
    await spotPrice(s, '100', 0, 1000);
    const first = (await events.list(s.userId, s.accountId, {})).data;
    assert.deepEqual([first.events.length, first.total], [0, 0]);
    const cursor = first.serverTime;
    const watch = async (executionType: 'market' | 'limit') =>
      (
        await conditionalBuy.create(s.userId, s.accountId, {
          assetId: s.instruments[0].asset.id,
          triggerCondition: 'at_or_below',
          triggerPrice: '95',
          executionType,
          ...(executionType === 'limit' ? { limitPrice: '94' } : {}),
          amount: '100',
          idempotencyKey: randomUUID(),
        })
      ).data.conditionalOrder.id;
    const limitWatch = await watch('limit');
    const marketWatch = await watch('market');
    await spotOrder(s, { side: 'buy', orderType: 'market', amount: '50' });
    const canceled = await spotOrder(s, {
      side: 'buy',
      orderType: 'limit',
      amount: '50',
      limitPrice: '80',
    });
    await orders.cancelOrderForTradingAccount(s.userId, s.accountId, canceled);
    await spotPrice(s, '95', 0, 0);
    await fxEvidence();
    assert.equal((await conditionalBuy.evaluate(limitWatch)).state, 'ordered');
    assert.equal((await conditionalBuy.evaluate(marketWatch)).state, 'ordered');
    const marketOrder = (
      await db.conditionalBuyOrder.findUniqueOrThrow({
        where: { id: marketWatch },
      })
    ).orderId!;
    const listed = (await events.list(s.userId, s.accountId, { after: cursor }))
      .data;
    assert.deepEqual(
      listed.events
        .map((event) => [
          event.key,
          event.type,
          event.origin,
          String(event.executionType),
        ])
        .sort(),
      [
        [`fill:spot_order:${marketOrder}`, 'fill', 'condition', 'null'],
        [
          `trigger:conditional_buy:${limitWatch}`,
          'trigger',
          'condition',
          'limit',
        ],
      ].sort(),
    );
    assert.equal(
      listed.total,
      2,
      'no event for the direct market order or the canceled order',
    );
    // The limit order fills later: its fill is listed; the trigger is no longer (its fill is known).
    await spotPrice(s, '93.5', 0, 0);
    await fxEvidence();
    await matcher.matchDueLimitOrders({ now: await now() });
    const limitOrder = (
      await db.conditionalBuyOrder.findUniqueOrThrow({
        where: { id: limitWatch },
      })
    ).orderId!;
    assert.equal((await order(limitOrder)).status, 'executed');
    const later = (
      await events.list(s.userId, s.accountId, { after: listed.serverTime })
    ).data;
    assert.equal(
      later.events.some(
        (event) => event.key === `fill:spot_order:${limitOrder}`,
      ),
      true,
    );
    assert.equal(
      later.events.some(
        (event) => event.key === `trigger:conditional_buy:${limitWatch}`,
      ),
      false,
    );
    await rejects(
      events.list(s.userId, s.accountId, { after: 'yesterday' }),
      'INVALID_EVENT_CURSOR',
    );
    const other = await fixture('general', '10000');
    try {
      await rejects(
        events.list(other.userId, s.accountId, { after: cursor }),
        'TRADING_ACCOUNT_NOT_FOUND',
      );
    } finally {
      await release(other);
    }
    pass(
      'event feed: cursor-only first read, trigger vs fill dedupe, direct/canceled orders excluded, owner only',
    );
  });
}

async function main() {
  await conditionalBuyChange('general');
  await conditionalBuyChange('season');
  await spotLimitBuyChange('general');
  await spotLimitBuyChange('season');
  await changeRacesCancel();
  await changeRacesFill();
  await spotGuards();
  await spotLimitSellChange();
  await futuresLimitChange();
  await conditionalSellChange();
  await entryPlanChange();
  await futuresSettingsChange();
  await eventFeed();
  console.log(`Pending order modification PostgreSQL PASS (${checks} checks)`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.fxRateSnapshot.deleteMany({
      where: { id: { in: fxEvidenceIds } },
    });
    await db.$disconnect();
  });
