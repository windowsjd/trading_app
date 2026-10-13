import { tradingSessions } from '../test/support/trading-session-fixture';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  db,
  fixture,
  now,
  price as futuresLastPrice,
  spotPrice,
  fxEvidence,
  fxEvidenceIds,
  cleanup,
  code,
  untilDb,
  holdRowLock,
  untilLockWaiting,
  type Scenario,
} from './futures-integration';
import { Prisma } from '../src/generated/prisma/client';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { OrdersService } from '../src/orders/orders.service';
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
import { ConditionalBuyWorker } from '../src/conditional/conditional-buy-worker.service';
import {
  CONDITIONAL_BUY_EXECUTION_WINDOW_MS,
  isRetryableConditionalBuyFailure,
  type ConditionalBuyBody,
} from '../src/conditional/conditional-buy-policy';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { lockSeasonTradingContext } from '../src/seasons/season-trading-lock';

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.CONDITIONAL_BUY_DB_INTEGRATION !== '1'
)
  throw new Error('Explicit disposable conditional BUY PG opt-in required');
process.env.CONDITIONAL_BUY_ORDERS_ENABLED = 'true';
process.env.CONDITIONAL_ORDERS_ENABLED = 'false';
process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED = 'true';

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

let checks = 0;
function pass(label: string) {
  checks++;
  console.log(`PASS ConditionalBuy ${label}`);
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

/** KRX: convert the fixture asset to a domestic stock on an open session. */
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
async function quote(s: Scenario, kind: Market, value: string, ageMs = 0) {
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
function size(kind: Market) {
  return kind === 'BINANCE' ? { amount: '100' } : { quantity: '3' };
}
async function register(s: Scenario, body: ConditionalBuyBody) {
  const result = await conditionalBuy.create(s.userId, s.accountId, {
    assetId: s.instruments[0].asset.id,
    idempotencyKey: randomUUID(),
    ...body,
  });
  return result.data.conditionalOrder.id;
}
const watch = (id: string) =>
  db.conditionalBuyOrder.findUniqueOrThrow({
    where: { id },
    include: { order: true },
  });
async function wallet(s: Scenario, kind: Market) {
  const row = await db.cashWallet.findFirstOrThrow({
    where: {
      tradingAccountId: s.accountId,
      walletScope: kind === 'BINANCE' ? 'crypto_spot' : 'securities',
      currencyCode: kind === 'BINANCE' ? 'USD' : 'KRW',
    },
  });
  return {
    balance: row.balanceAmount.toFixed(8),
    reserved: row.reservedAmount.toFixed(8),
  };
}
const orderCount = (s: Scenario) =>
  db.order.count({ where: { tradingAccountId: s.accountId } });
const ledgerCount = (s: Scenario) =>
  db.walletTransaction.count({
    where: { tradingAccountId: s.accountId, txType: 'order_buy' },
  });

async function release(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  await db.conditionalBuyOrder.deleteMany({ where });
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
  mode: 'general' | 'season' | 'beginner',
  work: (s: Scenario) => Promise<void>,
  freshLearning = false,
) {
  const s = await fixture(mode, '10000', freshLearning);
  try {
    await fxEvidence();
    await work(s);
  } finally {
    tradingSessions.reset();
    await release(s);
  }
}

/** Market trigger → ordinary market execution at the verified execute price. */
async function marketTrigger(mode: 'general' | 'season', kind: Market) {
  await scenario(mode, async (s) => {
    await market(s, kind);
    await quote(s, kind, '100');
    const before = await wallet(s, kind);
    const id = await register(s, {
      triggerCondition: kind === 'KRX' ? 'at_or_above' : 'at_or_below',
      triggerPrice: kind === 'KRX' ? '105' : '95',
      executionType: 'market',
      ...size(kind),
    });
    assert.deepEqual(await wallet(s, kind), before); // nothing reserved
    await quote(s, kind, kind === 'KRX' ? '104' : '96');
    assert.equal((await conditionalBuy.evaluate(id)).state, 'watching');
    await quote(s, kind, kind === 'KRX' ? '105' : '95');
    assert.equal((await conditionalBuy.evaluate(id)).state, 'ordered');
    const row = await watch(id);
    assert.equal(row.status, 'ordered');
    assert.ok(row.order && row.triggeredAt && row.triggerSnapshotId);
    assert.equal(row.order.status, 'executed');
    assert.equal(row.order.orderType, 'market');
    assert.equal(
      row.order.executedPrice?.toFixed(2),
      kind === 'KRX' ? '105.00' : '95.00',
    );
    if (kind === 'BINANCE')
      // amount policy: floor6(amount / price) and gross never above amount
      assert.equal(row.order.quantity.toFixed(6), '1.052631');
    else assert.equal(row.order.quantity.toFixed(0), '3');
    assert.ok(row.order.grossAmount!.lte(kind === 'BINANCE' ? '100' : '315'));
    const after = await wallet(s, kind);
    assert.equal(
      new Prisma.Decimal(before.balance).sub(after.balance).toFixed(8),
      row.order.netAmount!.toFixed(8),
    );
    assert.equal(after.reserved, '0.00000000');
    // Repeated price events and evaluations never create a second order.
    await quote(s, kind, kind === 'KRX' ? '106' : '94');
    assert.equal((await conditionalBuy.evaluate(id)).state, 'terminal');
    assert.equal(await orderCount(s), 1);
    assert.equal(await ledgerCount(s), 1);
    const view = (await conditionalBuy.get(s.userId, s.accountId, id)).data
      .conditionalOrder;
    assert.equal(view.state, 'filled');
    assert.equal(view.order?.orderId, row.orderId);
    assert.equal(
      view.triggerPrice,
      kind === 'KRX' ? '105.00000000' : '95.00000000',
    );
    pass(
      `${mode} ${kind} market trigger → executed, no reservation while watching`,
    );
  });
}

/** Limit trigger → ordinary submitted limit, later filled by the real matcher. */
async function limitTrigger(mode: 'general' | 'season', kind: Market) {
  await scenario(mode, async (s) => {
    await market(s, kind);
    await quote(s, kind, '100');
    const before = await wallet(s, kind);
    const id = await register(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      executionType: 'limit',
      limitPrice: '94',
      ...size(kind),
    });
    await quote(s, kind, '95');
    assert.equal((await conditionalBuy.evaluate(id)).state, 'ordered');
    const row = await watch(id);
    assert.ok(row.order);
    assert.equal(row.order.status, 'submitted');
    assert.equal(row.order.limitPrice?.toFixed(2), '94.00');
    const reserved = await wallet(s, kind);
    assert.equal(reserved.balance, before.balance);
    assert.equal(reserved.reserved, row.order.reservedAmount!.toFixed(8));
    let view = (await conditionalBuy.get(s.userId, s.accountId, id)).data
      .conditionalOrder;
    assert.equal(view.state, 'order_pending');
    // The trigger price alone never fills the limit order.
    await fxEvidence();
    await quote(s, kind, '94.5');
    await matcher.matchDueLimitOrders({ now: await now() });
    assert.equal((await watch(id)).order?.status, 'submitted');
    await quote(s, kind, '93.5');
    const summary = await matcher.matchDueLimitOrders({ now: await now() });
    assert.equal(summary.filledPathA, 1);
    const filled = await watch(id);
    assert.equal(filled.order?.status, 'executed');
    assert.equal(filled.order?.executedPrice?.toFixed(2), '93.50');
    const after = await wallet(s, kind);
    assert.equal(after.reserved, '0.00000000');
    assert.equal(
      new Prisma.Decimal(before.balance).sub(after.balance).toFixed(8),
      filled.order?.netAmount?.toFixed(8),
    );
    view = (await conditionalBuy.get(s.userId, s.accountId, id)).data
      .conditionalOrder;
    assert.equal(view.state, 'filled');
    pass(
      `${mode} ${kind} limit trigger → submitted, existing matcher fill, reservation settled`,
    );
  });
}

async function registrationRules(kind: Market) {
  await scenario('season', async (s) => {
    await market(s, kind);
    // Stale or missing eligible evidence never validates a registration.
    await quote(s, kind, '100', 60_000);
    await rejects(
      register(s, {
        triggerCondition: 'at_or_above',
        triggerPrice: '120',
        executionType: 'market',
        ...size(kind),
      }),
      'CONDITIONAL_PRICE_UNAVAILABLE',
    );
    await quote(s, kind, '100');
    for (const [triggerCondition, triggerPrice] of [
      ['at_or_above', '100'],
      ['at_or_below', '100'],
      ['at_or_above', '99'],
    ] as const)
      await rejects(
        register(s, {
          triggerCondition,
          triggerPrice,
          executionType: 'market',
          ...size(kind),
        }),
        'CONDITIONAL_BUY_ALREADY_MET',
      );
    assert.equal(
      await db.conditionalBuyOrder.count({
        where: { tradingAccountId: s.accountId },
      }),
      0,
    );
    // Asset-specific order input policy is the existing one.
    await rejects(
      register(s, {
        triggerCondition: 'at_or_above',
        triggerPrice: '110',
        executionType: 'market',
        ...(kind === 'BINANCE' ? { quantity: '1' } : { amount: '100' }),
      }),
      'INVALID_ORDER_INPUT',
    );
    if (kind === 'KRX')
      await rejects(
        register(s, {
          triggerCondition: 'at_or_above',
          triggerPrice: '110',
          executionType: 'limit',
          limitPrice: '111',
          quantity: '1.5',
        }),
        'FRACTIONAL_LIMIT_ORDER_NOT_SUPPORTED',
      );
    // Idempotent create: same key/body replays, a different body conflicts.
    const body = {
      triggerCondition: 'at_or_above' as const,
      triggerPrice: '110',
      executionType: 'market' as const,
      ...size(kind),
      idempotencyKey: `cbuy-${randomUUID()}`,
    };
    const first = await conditionalBuy.create(s.userId, s.accountId, {
      assetId: s.instruments[0].asset.id,
      ...body,
    });
    const replay = await conditionalBuy.create(s.userId, s.accountId, {
      assetId: s.instruments[0].asset.id,
      ...body,
    });
    assert.equal(
      replay.data.conditionalOrder.id,
      first.data.conditionalOrder.id,
    );
    assert.equal(replay.data.duplicate, true);
    await rejects(
      conditionalBuy.create(s.userId, s.accountId, {
        assetId: s.instruments[0].asset.id,
        ...body,
        triggerPrice: '111',
      }),
      'CONDITIONAL_IDEMPOTENCY_CONFLICT',
    );
    pass(
      `${kind} registration: already-met, input policy, idempotency, stale evidence`,
    );
  });
}

async function evidenceAndSession() {
  await scenario('general', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    const id = await register(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      executionType: 'market',
      quantity: '2',
    });
    // Stale (beyond execute freshness), future-dated or pre-registration
    // trades never trigger.
    const old = new Date((await now()).getTime() - 60_000);
    await db.assetPriceSnapshot.updateMany({
      where: { assetId: s.instruments[0].asset.id },
      data: { effectiveAt: old, capturedAt: old },
    });
    assert.equal(
      (await conditionalBuy.evaluate(id)).state,
      'price_unavailable',
    );
    const future = new Date((await now()).getTime() + 60_000);
    const futureRow = await db.assetPriceSnapshot.create({
      data: {
        assetId: s.instruments[0].asset.id,
        price: '110',
        currencyCode: 'KRW',
        sourceType: 'provider_api',
        sourceName: 'koscom_krx_realtime_price',
        effectiveAt: future,
        capturedAt: future,
      },
    });
    assert.equal(
      (await conditionalBuy.evaluate(id)).state,
      'price_unavailable',
    );
    await db.assetPriceSnapshot.delete({ where: { id: futureRow.id } });
    await db.assetPriceSnapshot.create({
      data: {
        assetId: s.instruments[0].asset.id,
        price: '110',
        currencyCode: 'KRW',
        sourceType: 'provider_api',
        sourceName: 'koscom_krx_realtime_price',
        effectiveAt: new Date((await watch(id)).createdAt.getTime() - 1),
        capturedAt: await now(),
      },
    });
    assert.equal((await conditionalBuy.evaluate(id)).state, 'awaiting_price');
    // Ineligible sources never trigger.
    await db.assetPriceSnapshot.create({
      data: {
        assetId: s.instruments[0].asset.id,
        price: '110',
        currencyCode: 'KRW',
        sourceType: 'admin_manual',
        sourceName: 'operator',
        effectiveAt: await now(),
        capturedAt: await now(),
      },
    });
    assert.notEqual((await conditionalBuy.evaluate(id)).state, 'ordered');
    // Closed session: monitoring pauses; it resumes on the next open session.
    const clock = await now();
    tradingSessions.set(clock, clock, ['KRX']);
    await quote(s, 'KRX', '110');
    assert.equal(
      (await conditionalBuy.evaluate(id)).state,
      'price_unavailable',
    );
    await rejects(
      register(s, {
        triggerCondition: 'at_or_above',
        triggerPrice: '200',
        executionType: 'market',
        quantity: '1',
      }),
      'CONDITIONAL_PRICE_UNAVAILABLE',
    );
    assert.equal((await watch(id)).status, 'watching');
    tradingSessions.set(await now(), undefined, ['KRX']);
    await quote(s, 'KRX', '106');
    assert.equal((await conditionalBuy.evaluate(id)).state, 'ordered');
    assert.equal((await watch(id)).order?.executedPrice?.toFixed(0), '106');
    pass(
      'KRX freshness/source/registration-time gates and closed-session pause',
    );
  });
}

async function cryptoSourceSeparation() {
  await scenario('general', async (s) => {
    await quote(s, 'BINANCE', '100');
    const id = await register(s, {
      triggerCondition: 'at_or_below',
      triggerPrice: '90',
      executionType: 'market',
      amount: '50',
    });
    // Futures Last/Mark at the trigger never satisfies a Spot watch.
    await futuresLastPrice(s, '80', 0, 0);
    await db.futuresMarkSnapshot.create({
      data: {
        instrumentId: s.instruments[0].instrument.id,
        symbol: s.instruments[0].asset.symbol,
        price: '80',
        source: 'binance_usdm_mark_ws',
        effectiveAt: await now(),
        capturedAt: await now(),
      },
    });
    await quote(s, 'BINANCE', '91');
    assert.equal((await conditionalBuy.evaluate(id)).state, 'watching');
    await quote(s, 'BINANCE', '90');
    assert.equal((await conditionalBuy.evaluate(id)).state, 'ordered');
    const row = await watch(id);
    assert.equal(row.order?.cashWalletScope, 'crypto_spot');
    assert.equal(
      (row.triggerEvidenceJson as { sourceName?: string }).sourceName,
      'binance_spot_ws_ticker',
    );
    pass(
      'crypto Spot evidence only; Futures Last/Mark separated; crypto_spot wallet',
    );
  });
}

async function insufficientFunds(kind: Market) {
  await scenario('season', async (s) => {
    await market(s, kind);
    await quote(s, kind, '100');
    const id = await register(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '101',
      executionType: kind === 'KRX' ? 'limit' : 'market',
      ...(kind === 'KRX'
        ? { limitPrice: '101', quantity: '3' }
        : { amount: '100' }),
    });
    // Another spend after registration: the watch reserved nothing.
    await db.cashWallet.updateMany({
      where: {
        tradingAccountId: s.accountId,
        walletScope: kind === 'BINANCE' ? 'crypto_spot' : 'securities',
        currencyCode: kind === 'BINANCE' ? 'USD' : 'KRW',
      },
      data: { balanceAmount: '10' },
    });
    const before = await wallet(s, kind);
    await quote(s, kind, '101');
    const state = (await conditionalBuy.evaluate(id)).state;
    assert.ok(
      ['INSUFFICIENT_BALANCE', 'INSUFFICIENT_AVAILABLE_BALANCE'].includes(
        state,
      ),
    );
    const row = await watch(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.failureCode, state);
    assert.equal(row.attemptCount, 1);
    assert.equal(row.orderId, null);
    assert.deepEqual(await wallet(s, kind), before);
    assert.equal(await orderCount(s), 0);
    // No endless retry: a failed watch is terminal.
    assert.equal((await conditionalBuy.evaluate(id)).state, 'terminal');
    pass(`${kind} insufficient funds at trigger → failed once, nothing forced`);
  });
}

async function staleTrigger() {
  await scenario('general', async (s) => {
    await quote(s, 'BINANCE', '100');
    const id = await register(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '110',
      executionType: 'market',
      amount: '50',
    });
    // A trigger committed before a crash/outage longer than the window.
    const trigger = await quote(s, 'BINANCE', '110');
    await db.conditionalBuyOrder.update({
      where: { id },
      data: {
        status: 'triggered',
        triggeredAt: new Date((await now()).getTime() - 31_000),
        triggerSnapshotId: trigger.id,
        triggerEvidenceJson: { snapshotId: trigger.id },
      },
    });
    assert.equal((await conditionalBuy.evaluate(id)).state, 'failed');
    const row = await watch(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.failureCode, 'CONDITIONAL_BUY_EXECUTION_WINDOW_EXPIRED');
    assert.equal(await orderCount(s), 0);
    pass('restart safety: a stale trigger never becomes an order');
  });
}

async function races(kind: Market) {
  // Duplicate workers: concurrent evaluations of one met watch → one order.
  await scenario('season', async (s) => {
    await market(s, kind);
    await quote(s, kind, '100');
    const id = await register(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '102',
      executionType: 'market',
      ...size(kind),
    });
    await quote(s, kind, '102');
    await Promise.all([
      conditionalBuy.evaluate(id),
      conditionalBuy.evaluate(id),
      conditionalBuy.evaluate(id),
    ]);
    assert.equal((await watch(id)).status, 'ordered');
    assert.equal(await orderCount(s), 1);
    assert.equal(await ledgerCount(s), 1);
    pass(`${kind} duplicate workers → single order`);
  });
  // Trigger vs user cancel: exactly one winner, no partial state.
  for (let round = 0; round < 3; round++)
    await scenario('general', async (s) => {
      await market(s, kind);
      await quote(s, kind, '100');
      const id = await register(s, {
        triggerCondition: 'at_or_above',
        triggerPrice: '102',
        executionType: 'market',
        ...size(kind),
      });
      await quote(s, kind, '102');
      const [, canceled] = await Promise.allSettled([
        conditionalBuy.evaluate(id),
        conditionalBuy.cancel(s.userId, s.accountId, id),
      ]);
      const row = await watch(id);
      if (row.status === 'ordered') {
        assert.equal(await orderCount(s), 1);
        assert.equal(canceled.status, 'rejected');
        assert.equal(
          canceled.status === 'rejected' ? code(canceled.reason) : '',
          'CONDITIONAL_BUY_ALREADY_ORDERED',
        );
      } else {
        assert.equal(row.status, 'canceled');
        assert.equal(row.terminalReason, 'user_canceled');
        assert.equal(await orderCount(s), 0);
        assert.equal((await wallet(s, kind)).reserved, '0.00000000');
      }
    });
  pass(`${kind} trigger vs cancel race → single winner (3 rounds)`);
}

async function lifecycle() {
  await scenario('season', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    const ended = await register(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      executionType: 'market',
      quantity: '1',
    });
    const excluded = await register(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '106',
      executionType: 'market',
      quantity: '1',
    });
    // Participant exclusion: the existing exclusion cleanup terminalizes watches.
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
    assert.equal(
      (await watch(excluded)).terminalReason,
      'participant_excluded',
    );
    assert.equal((await watch(ended)).status, 'canceled');
    pass('participant exclusion cleanup cancels live watches');
  });
  await scenario('season', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    const id = await register(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      executionType: 'market',
      quantity: '1',
    });
    // Season ends: the met condition never fills after endAt.
    await db.season.update({
      where: { id: s.season!.id },
      data: { endAt: new Date((await now()).getTime() - 1000) },
    });
    await quote(s, 'KRX', '106');
    assert.equal(
      (await conditionalBuy.evaluate(id)).state,
      'lifecycle_canceled',
    );
    assert.equal((await watch(id)).terminalReason, 'season_ended');
    assert.equal(await orderCount(s), 0);
    pass('season end → watch canceled, no fill after endAt');
  });
  await scenario('season', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    const id = await register(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      executionType: 'market',
      quantity: '1',
    });
    await db.season.update({
      where: { id: s.season!.id },
      data: {
        status: 'ended',
        endAt: new Date((await now()).getTime() - 1000),
      },
    });
    await cancel.cleanupEndedSeasonLimitReservations({ now: await now() });
    assert.equal((await watch(id)).terminalReason, 'season_ended');
    pass('season lifecycle cleanup cancels live watches of ended seasons');
  });
  await scenario('general', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    const id = await register(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      executionType: 'market',
      quantity: '1',
    });
    await db.tradingAccount.update({
      where: { id: s.accountId },
      data: { status: 'suspended' },
    });
    await quote(s, 'KRX', '106');
    assert.equal(
      (await conditionalBuy.evaluate(id)).state,
      'lifecycle_canceled',
    );
    assert.equal((await watch(id)).terminalReason, 'account_not_tradable');
    await db.tradingAccount.update({
      where: { id: s.accountId },
      data: { status: 'active' },
    });
    const inactive = await register(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '120',
      executionType: 'market',
      quantity: '1',
    });
    await db.asset.update({
      where: { id: s.instruments[0].asset.id },
      data: { isActive: false },
    });
    assert.equal(
      (await conditionalBuy.evaluate(inactive)).state,
      'lifecycle_canceled',
    );
    assert.equal((await watch(inactive)).terminalReason, 'asset_not_tradable');
    await db.asset.update({
      where: { id: s.instruments[0].asset.id },
      data: { isActive: true },
    });
    pass('account restriction and asset deactivation terminate watches');
  });
}

async function flagsAndScope() {
  await scenario('general', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    const id = await register(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '105',
      executionType: 'market',
      quantity: '1',
    });
    process.env.CONDITIONAL_BUY_ORDERS_ENABLED = 'false';
    process.env.CONDITIONAL_ORDERS_ENABLED = 'true'; // protection on ≠ buy on
    try {
      await rejects(
        register(s, {
          triggerCondition: 'at_or_above',
          triggerPrice: '110',
          executionType: 'market',
          quantity: '1',
        }),
        'CONDITIONAL_BUY_DISABLED',
      );
      await quote(s, 'KRX', '106');
      assert.equal((await conditionalBuy.evaluate(id)).state, 'disabled');
      assert.equal((await watch(id)).status, 'watching');
      const list = await conditionalBuy.list(s.userId, s.accountId, {});
      assert.equal(list.data.capabilities.enabled, false);
      assert.equal(list.data.conditionalOrders.length, 1);
      const canceled = await conditionalBuy.cancel(s.userId, s.accountId, id);
      assert.equal(canceled.data.conditionalOrder.status, 'canceled');
      const again = await conditionalBuy.cancel(s.userId, s.accountId, id);
      assert.equal(again.data.duplicate, true);
    } finally {
      process.env.CONDITIONAL_BUY_ORDERS_ENABLED = 'true';
      process.env.CONDITIONAL_ORDERS_ENABLED = 'false';
    }
    process.env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED = 'false';
    try {
      await rejects(
        register(s, {
          triggerCondition: 'at_or_above',
          triggerPrice: '110',
          executionType: 'limit',
          limitPrice: '110',
          quantity: '1',
        }),
        'CONDITIONAL_LIMIT_UNAVAILABLE',
      );
    } finally {
      process.env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED = 'true';
    }
    // Another user's account is the same 404.
    const other = await fixture('general');
    try {
      await rejects(
        conditionalBuy.get(other.userId, s.accountId, id),
        'TRADING_ACCOUNT_NOT_FOUND',
      );
    } finally {
      await release(other);
    }
    pass(
      'flag off: no create/trigger, cancel/read kept; protection flag independent; limit needs matcher; ownership',
    );
  });
}

/** US stocks: new conditional orders refused; existing market/limit intact. */
async function usStockScope() {
  await scenario('season', async (s) => {
    tradingSessions.set(await now(), undefined, ['KRX', 'US']);
    const asset = await db.asset.update({
      where: { id: s.instruments[0].asset.id },
      data: {
        market: 'NAS',
        assetType: 'us_stock',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
      },
    });
    await db.cashWallet.updateMany({
      where: {
        tradingAccountId: s.accountId,
        walletScope: 'securities',
        currencyCode: 'USD',
      },
      data: { balanceAmount: '10000' },
    });
    const usPrice = async (value: string) => {
      const at = await now();
      return db.assetPriceSnapshot.create({
        data: {
          assetId: asset.id,
          price: value,
          currencyCode: 'USD',
          sourceType: 'provider_api',
          sourceName: 'kis_us_delayed_trade',
          effectiveAt: at,
          capturedAt: at,
        },
      });
    };
    await usPrice('100');
    await rejects(
      register(s, {
        triggerCondition: 'at_or_above',
        triggerPrice: '110',
        executionType: 'market',
        quantity: '1',
      }),
      'CONDITIONAL_BUY_MARKET_NOT_SUPPORTED',
    );
    const marketBody = {
      assetId: asset.id,
      side: 'buy' as const,
      orderType: 'market' as const,
      quantity: '2',
    };
    const marketQuote = await orders.quoteOrderForTradingAccount(
      s.userId,
      s.accountId,
      marketBody,
    );
    const executed = await orders.createOrderForTradingAccount(
      s.userId,
      s.accountId,
      {
        ...marketBody,
        quoteId: marketQuote.data.quoteId,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(executed.data.order.status, 'executed');
    const limitBody = {
      assetId: asset.id,
      side: 'buy' as const,
      orderType: 'limit' as const,
      quantity: '1',
      limitPrice: '90',
    };
    const limitQuote = await orders.quoteOrderForTradingAccount(
      s.userId,
      s.accountId,
      limitBody,
    );
    const submitted = await orders.createOrderForTradingAccount(
      s.userId,
      s.accountId,
      {
        ...limitBody,
        quoteId: limitQuote.data.quoteId,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(submitted.data.order.status, 'submitted');
    assert.equal('limitOnClose' in submitted.data.order, false);
    pass(
      'US stock: new conditional BUY refused; existing market/limit unchanged',
    );
  });
}

async function beginner() {
  await scenario(
    'beginner',
    async (s) => {
      await quote(s, 'BINANCE', '100');
      await rejects(
        register(s, {
          triggerCondition: 'at_or_above',
          triggerPrice: '110',
          executionType: 'market',
          amount: '10',
        }),
        'BEGINNER_FEATURE_LOCKED',
      );
      pass('beginner learning lock is not bypassed');
    },
    true,
  );
}

async function workerLease() {
  await scenario('general', async (s) => {
    await quote(s, 'BINANCE', '100');
    const id = await register(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '110',
      executionType: 'market',
      amount: '50',
    });
    await quote(s, 'BINANCE', '110');
    const workers = [0, 1].map(
      () =>
        new ConditionalBuyWorker(
          db,
          new OpsJobLockService(db),
          new OpsJobRunService(db),
          conditionalBuy,
        ),
    );
    await Promise.all(workers.map((worker) => worker.tick()));
    for (let i = 0; i < 5 && (await watch(id)).status !== 'ordered'; i++)
      await workers[0].tick();
    assert.equal((await watch(id)).status, 'ordered');
    assert.equal(await orderCount(s), 1);
    pass('two worker instances share one OpsJobLock lease → one order');
  });
}

// ── The 30 s execution window holds at the create transaction's DB clock ────

const WINDOW_MS = CONDITIONAL_BUY_EXECUTION_WINDOW_MS;
type ExecutionType = 'market' | 'limit';
const watchBody = (executionType: ExecutionType): ConditionalBuyBody => ({
  triggerCondition: 'at_or_above',
  triggerPrice: '110',
  executionType,
  ...(executionType === 'limit' ? { limitPrice: '100' } : {}),
  ...size('KRX'),
});
/** The create request the worker adapter builds for this watch. */
const watchRequest = (s: Scenario, executionType: ExecutionType) => ({
  assetId: s.instruments[0].asset.id,
  side: 'buy' as const,
  orderType: executionType,
  quantity: '3.000000',
  ...(executionType === 'limit' ? { limitPrice: '100.00000000' } : {}),
});
/** The worker's trigger write, back-dated `ageMs` on the DB clock, with a
 * fresh price for the order core. */
async function triggerAged(s: Scenario, id: string, ageMs: number) {
  const trigger = await quote(s, 'KRX', '100');
  const triggeredAt = new Date((await now()).getTime() - ageMs);
  await db.conditionalBuyOrder.update({
    where: { id },
    data: {
      status: 'triggered',
      triggeredAt,
      triggerSnapshotId: trigger.id,
      triggerEvidenceJson: { snapshotId: trigger.id },
    },
  });
  return triggeredAt;
}
/** A refused create leaves nothing: no Order, reservation, ledger or link. */
async function assertNoOrder(
  s: Scenario,
  id: string,
  before: { balance: string; reserved: string },
) {
  assert.equal(await orderCount(s), 0);
  assert.deepEqual(await wallet(s, 'KRX'), before);
  assert.equal(await ledgerCount(s), 0);
  assert.equal((await watch(id)).orderId, null);
}
async function assertWindowExpired(s: Scenario, id: string) {
  const row = await watch(id);
  assert.equal(row.status, 'failed');
  assert.equal(row.terminalReason, 'execution_window_expired');
  assert.equal(row.failureCode, 'CONDITIONAL_BUY_EXECUTION_WINDOW_EXPIRED');
  assert.equal(await orderCount(s), 0);
}
async function windowScenario(
  work: (
    s: Scenario,
    before: { balance: string; reserved: string },
  ) => Promise<void>,
) {
  await scenario('general', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    await work(s, await wallet(s, 'KRX'));
  });
}

async function executionWindow(executionType: ExecutionType) {
  // 25 s after the trigger: the worker still orders it.
  await windowScenario(async (s) => {
    const id = await register(s, watchBody(executionType));
    await triggerAged(s, id, 25_000);
    assert.equal((await conditionalBuy.evaluate(id)).state, 'ordered');
    assert.equal(
      (await watch(id)).order?.status,
      executionType === 'market' ? 'executed' : 'submitted',
    );
    assert.equal(await orderCount(s), 1);
  });
  // Exactly 30 s (the DB instant observed just before the create; the clock
  // only moves on) and past it: the create refuses although the worker's own
  // check already passed.
  for (const ageMs of [WINDOW_MS, WINDOW_MS + 3000])
    await windowScenario(async (s, before) => {
      const id = await register(s, watchBody(executionType));
      await triggerAged(s, id, ageMs);
      await rejects(
        orders.executeConditionalBuy(s.userId, s.accountId, id),
        'CONDITIONAL_BUY_EXECUTION_WINDOW_EXPIRED',
      );
      await assertNoOrder(s, id, before);
      assert.equal((await watch(id)).status, 'triggered');
      assert.equal((await conditionalBuy.evaluate(id)).state, 'failed');
      await assertWindowExpired(s, id);
    });
  // Quoted inside the window, created after it.
  await windowScenario(async (s, before) => {
    const id = await register(s, watchBody(executionType));
    const triggeredAt = await triggerAged(s, id, 29_000);
    const request = watchRequest(s, executionType);
    const quoted = await orders.quoteOrderForTradingAccount(
      s.userId,
      s.accountId,
      request,
      undefined,
      id,
    );
    await untilDb(triggeredAt.getTime() + WINDOW_MS + 2000);
    await rejects(
      orders.createOrderForTradingAccount(
        s.userId,
        s.accountId,
        {
          ...request,
          quoteId: quoted.data.quoteId,
          idempotencyKey: `conditional-buy:${id}`,
        },
        undefined,
        id,
      ),
      'CONDITIONAL_BUY_EXECUTION_WINDOW_EXPIRED',
    );
    await assertNoOrder(s, id, before);
    assert.equal(
      (
        await db.quote.findUniqueOrThrow({
          where: { id: quoted.data.quoteId! },
        })
      ).status,
      'active',
    );
  });
  // Lock waits past the window: on the account fence (before the watch check,
  // after the worker's check passed) and on the cash wallet (after the watch
  // check, during the writes; through the real worker path).
  for (const lock of ['account', 'wallet'] as const)
    await windowScenario(async (s, before) => {
      const id = await register(s, watchBody(executionType));
      const walletId = (
        await db.cashWallet.findFirstOrThrow({
          where: {
            tradingAccountId: s.accountId,
            walletScope: 'securities',
            currencyCode: 'KRW',
          },
        })
      ).id;
      // Close to the window, so the waiting create stays inside Prisma's 5 s
      // interactive-transaction timeout even across a backward clock step.
      const triggeredAt = await triggerAged(s, id, 29_500);
      const holder = await holdRowLock((tx) =>
        lock === 'account'
          ? tx.$queryRaw`SELECT "id" FROM "trading_accounts" WHERE "id" = ${s.accountId} FOR UPDATE`
          : tx.$queryRaw`SELECT "id" FROM "cash_wallets" WHERE "id" = ${walletId} FOR UPDATE`,
      );
      const pending =
        lock === 'account'
          ? orders.executeConditionalBuy(s.userId, s.accountId, id)
          : conditionalBuy.evaluate(id);
      await untilLockWaiting();
      assert.ok(
        (await now()).getTime() - triggeredAt.getTime() < WINDOW_MS,
        'the create waits inside the window',
      );
      // Past the window by more than this host's backward clock steps; the
      // execution price stays fresh, only the window ends.
      await untilDb(triggeredAt.getTime() + WINDOW_MS + 2000);
      await quote(s, 'KRX', '100');
      await holder.release();
      if (lock === 'account')
        await rejects(pending, 'CONDITIONAL_BUY_EXECUTION_WINDOW_EXPIRED');
      else
        assert.equal(
          ((await pending) as { state: string }).state,
          'CONDITIONAL_BUY_EXECUTION_WINDOW_EXPIRED',
        );
      await assertNoOrder(s, id, before);
      if (lock === 'account')
        assert.equal((await conditionalBuy.evaluate(id)).state, 'failed');
      await assertWindowExpired(s, id);
    });
  // An order committed inside the window replays after it, never a second one.
  await windowScenario(async (s) => {
    const id = await register(s, watchBody(executionType));
    await triggerAged(s, id, 0);
    assert.equal((await conditionalBuy.evaluate(id)).state, 'ordered');
    const ordered = await watch(id);
    const walletAfter = await wallet(s, 'KRX');
    const ledgerAfter = await ledgerCount(s);
    await db.conditionalBuyOrder.update({
      where: { id },
      data: { triggeredAt: new Date((await now()).getTime() - 120_000) },
    });
    const replay = await orders.createOrderForTradingAccount(
      s.userId,
      s.accountId,
      {
        ...watchRequest(s, executionType),
        quoteId: ordered.order!.quoteId!,
        idempotencyKey: `conditional-buy:${id}`,
      },
      undefined,
      id,
    );
    assert.equal(replay.data.order.orderId, ordered.orderId);
    assert.equal(await orderCount(s), 1);
    assert.deepEqual(await wallet(s, 'KRX'), walletAfter);
    assert.equal(await ledgerCount(s), ledgerAfter);
    assert.equal((await watch(id)).status, 'ordered');
  });
  pass(
    `${executionType}: window <30 s orders; at/after 30 s, quote-then-late create and lock waits refuse with no partial state; replay kept`,
  );
}

/** Concurrent creates, the worker and a user cancel: at most one Order. */
async function windowRaces() {
  for (let round = 0; round < 3; round++)
    await windowScenario(async (s, before) => {
      const id = await register(s, watchBody('market'));
      await triggerAged(s, id, 0);
      await Promise.allSettled([
        orders.executeConditionalBuy(s.userId, s.accountId, id),
        orders.executeConditionalBuy(s.userId, s.accountId, id),
        conditionalBuy.evaluate(id),
        conditionalBuy.cancel(s.userId, s.accountId, id),
      ]);
      const row = await watch(id);
      if (row.status === 'ordered') {
        assert.equal(await orderCount(s), 1);
        assert.equal(await ledgerCount(s), 1);
      } else {
        assert.ok(['canceled', 'failed'].includes(row.status), row.status);
        await assertNoOrder(s, id, before);
      }
    });
  pass('concurrent creates, worker and cancel → at most one Order (3 rounds)');
}

/** Transient failures still retry inside the window, at most 3 attempts. */
async function retryAttempts() {
  await scenario('general', async (s) => {
    await quote(s, 'BINANCE', '100');
    const id = await register(s, {
      triggerCondition: 'at_or_above',
      triggerPrice: '110',
      executionType: 'market',
      amount: '50',
    });
    const trigger = await quote(s, 'BINANCE', '110');
    await db.conditionalBuyOrder.update({
      where: { id },
      data: {
        status: 'triggered',
        triggeredAt: await now(),
        triggerSnapshotId: trigger.id,
        triggerEvidenceJson: { snapshotId: trigger.id },
      },
    });
    // Every execution price is stale: a transient evidence failure.
    const old = new Date((await now()).getTime() - 600_000);
    await db.assetPriceSnapshot.updateMany({
      where: { assetId: s.instruments[0].asset.id },
      data: { effectiveAt: old, capturedAt: old },
    });
    for (const attempt of [1, 2, 3]) {
      await conditionalBuy.evaluate(id);
      const row = await watch(id);
      assert.equal(row.attemptCount, attempt);
      assert.ok(
        isRetryableConditionalBuyFailure(row.failureCode ?? ''),
        row.failureCode ?? '',
      );
      assert.equal(row.status, attempt < 3 ? 'triggered' : 'failed');
    }
    assert.equal((await watch(id)).terminalReason, 'execution_failed');
    assert.equal(await orderCount(s), 0);
    pass('transient failures retry inside the window, at most 3 attempts');
  });
}

/**
 * Read filters: an old row the owner can still cancel is never hidden behind
 * newer ended rows. `state=open` = watching/triggered/order_pending,
 * `state=ended` = its complement; each open row keeps its own cancel path.
 */
async function listStates() {
  await scenario('general', async (s) => {
    await market(s, 'KRX');
    await quote(s, 'KRX', '100');
    const far = {
      triggerCondition: 'at_or_above',
      triggerPrice: '200',
      executionType: 'market',
      quantity: '1',
    } as const;
    const limit = {
      triggerCondition: 'at_or_below',
      triggerPrice: '95',
      executionType: 'limit',
      limitPrice: '94',
      quantity: '3',
    } as const;
    // Oldest first: watching, triggered, two linked pending limit orders.
    const watching = await register(s, far);
    const triggered = await register(s, far);
    await triggerAged(s, triggered, 0);
    const filledLater = await register(s, limit);
    const canceledLater = await register(s, limit);
    await quote(s, 'KRX', '95');
    for (const id of [filledLater, canceledLater])
      assert.equal((await conditionalBuy.evaluate(id)).state, 'ordered');
    // 32 newer ended rows push every open row off a 30-row history page.
    for (let i = 0; i < 32; i++)
      await conditionalBuy.cancel(
        s.userId,
        s.accountId,
        await register(s, far),
      );
    const list = (query: Record<string, string>) =>
      conditionalBuy.list(s.userId, s.accountId, query);
    const ids = (page: Awaited<ReturnType<typeof list>>) =>
      page.data.conditionalOrders.map((row) => row.id);
    const history = await list({ history: 'true', limit: '30' });
    for (const id of [watching, triggered, filledLater, canceledLater])
      assert.equal(ids(history).includes(id), false);
    let open = await list({ state: 'open', limit: '100' });
    assert.deepEqual(
      open.data.conditionalOrders.map((row) => [row.id, row.state]),
      [
        [canceledLater, 'order_pending'],
        [filledLater, 'order_pending'],
        [triggered, 'triggered'],
        [watching, 'watching'],
      ],
    );
    assert.equal(open.data.pagination.total, 4);
    assert.equal(open.data.pagination.nextOffset, null);
    const first = await list({ state: 'ended', limit: '30' });
    const second = await list({ state: 'ended', limit: '30', offset: '30' });
    assert.equal(first.data.pagination.total, 32);
    assert.equal(first.data.pagination.nextOffset, 30);
    assert.equal(second.data.pagination.nextOffset, null);
    const ended = [...ids(first), ...ids(second)];
    assert.equal(new Set(ended).size, 32);
    assert.ok(ended.every((id) => !ids(open).includes(id)));
    assert.ok(
      [...first.data.conditionalOrders, ...second.data.conditionalOrders].every(
        (row) => row.state === 'canceled',
      ),
    );
    await rejects(
      list({ state: 'open', history: 'true' }),
      'INVALID_PAGINATION',
    );
    // Cancel paths: a linked pending order is not a watch cancel; it is the
    // ordinary order cancel. A triggered watch is still a watch cancel.
    await rejects(
      conditionalBuy.cancel(s.userId, s.accountId, filledLater),
      'CONDITIONAL_BUY_ALREADY_ORDERED',
    );
    const linked = (await watch(canceledLater)).orderId!;
    await orders.cancelOrderForTradingAccount(s.userId, s.accountId, linked);
    const canceledWatch = await conditionalBuy.cancel(
      s.userId,
      s.accountId,
      triggered,
    );
    assert.equal(canceledWatch.data.conditionalOrder.state, 'canceled');
    // The other linked order fills through the existing matcher.
    await fxEvidence();
    await quote(s, 'KRX', '93.5');
    const summary = await matcher.matchDueLimitOrders({ now: await now() });
    assert.equal(summary.filledPathA, 1);
    open = await list({ state: 'open', limit: '100' });
    assert.deepEqual(ids(open), [watching]);
    const after = await list({ state: 'ended', limit: '100' });
    assert.equal(after.data.pagination.total, 35);
    const state = (id: string) =>
      after.data.conditionalOrders.find((row) => row.id === id)?.state;
    assert.equal(state(filledLater), 'filled');
    assert.equal(state(canceledLater), 'order_canceled');
    assert.equal(state(triggered), 'canceled');
    // Flag off: the open list and its cancel keep working.
    process.env.CONDITIONAL_BUY_ORDERS_ENABLED = 'false';
    try {
      open = await list({ state: 'open', limit: '100' });
      assert.equal(open.data.capabilities.enabled, false);
      assert.deepEqual(ids(open), [watching]);
      await conditionalBuy.cancel(s.userId, s.accountId, watching);
      assert.equal(
        (await list({ state: 'open', limit: '100' })).data.pagination.total,
        0,
      );
    } finally {
      process.env.CONDITIONAL_BUY_ORDERS_ENABLED = 'true';
    }
    // Another user's account is the same 404 for the filtered read.
    const other = await fixture('general');
    try {
      await rejects(
        conditionalBuy.list(other.userId, s.accountId, { state: 'open' }),
        'TRADING_ACCOUNT_NOT_FOUND',
      );
    } finally {
      await release(other);
    }
    pass(
      'state=open lists old watching/triggered/order_pending past 32 newer ended rows; ended is its complement',
    );
  });
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

async function run() {
  for (const mode of ['general', 'season'] as const)
    for (const kind of ['KRX', 'BINANCE'] as const) {
      await marketTrigger(mode, kind);
      await limitTrigger(mode, kind);
    }
  for (const kind of ['KRX', 'BINANCE'] as const) {
    await registrationRules(kind);
    await insufficientFunds(kind);
    await races(kind);
  }
  await evidenceAndSession();
  await cryptoSourceSeparation();
  await staleTrigger();
  await lifecycle();
  await flagsAndScope();
  await listStates();
  await usStockScope();
  await beginner();
  await workerLease();
  await executionWindow('market');
  await executionWindow('limit');
  await windowRaces();
  await retryAttempts();
  console.log(`Conditional BUY PostgreSQL PASS (${checks} scenarios)`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
