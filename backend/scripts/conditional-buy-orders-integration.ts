import { tradingSessions } from '../test/support/trading-session-fixture';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance as monotonicClock } from 'node:perf_hooks';
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
import {
  markMarketSessionOverrideStoreRequired,
  resetMarketSessionOverrideStoreForTest,
} from '../src/orders/market-calendar/market-session-override.store';

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
    // A new watch may register while closed (2026-10-18): see
    // offSessionRegistration. This one keeps waiting either way.
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

/**
 * Off-session registration (2026-10-18). A confirmed-closed stock market
 * registers a watch without a price and with the direction exactly as sent —
 * including one an open session would refuse as already met. While closed it
 * is never evaluated against a price (off-hours trades included) and reserves
 * nothing. The next regular session's first eligible trade after its open
 * decides it, a gap past the watch price included, and the order goes
 * through the ordinary core. An undecidable calendar refuses registration.
 */
async function offSessionRegistration(kind: 'KRX' | 'US') {
  const previous = process.env.US_STOCK_PRICE_PROVIDER;
  if (kind === 'US') process.env.US_STOCK_PRICE_PROVIDER = 'tiingo';
  try {
    await scenario('season', async (s) => {
      tradingSessions.set(await now(), undefined, ['KRX', 'US']);
      const currency: 'KRW' | 'USD' = kind === 'KRX' ? 'KRW' : 'USD';
      const asset = await db.asset.update({
        where: { id: s.instruments[0].asset.id },
        data:
          kind === 'KRX'
            ? {
                market: 'KRX',
                assetType: 'domestic_stock',
                currencyCode: 'KRW',
                priceCurrency: 'KRW',
                settlementCurrency: 'KRW',
              }
            : {
                market: 'NAS',
                assetType: 'us_stock',
                currencyCode: 'USD',
                priceCurrency: 'USD',
                settlementCurrency: 'USD',
              },
      });
      const cash = {
        tradingAccountId: s.accountId,
        walletScope: 'securities' as const,
        currencyCode: currency,
      };
      // A realistic balance per currency (a 1,000,000 USD fixture would
      // overflow the season return-rate column of the equity snapshot).
      await db.cashWallet.updateMany({
        where: cash,
        data: { balanceAmount: kind === 'KRX' ? '1000000' : '10000' },
      });
      const trade = async (value: string) => {
        const at = await now();
        return db.assetPriceSnapshot.create({
          data: {
            assetId: asset.id,
            price: value,
            currencyCode: currency,
            sourceType: 'provider_api',
            sourceName:
              kind === 'KRX'
                ? 'koscom_krx_realtime_price'
                : 'tiingo_us_reference_price',
            effectiveAt: at,
            capturedAt: at,
          },
        });
      };
      const funds = async () => {
        const row = await db.cashWallet.findFirstOrThrow({ where: cash });
        return `${row.balanceAmount.toFixed(8)}/${row.reservedAmount.toFixed(8)}`;
      };
      // The last regular-session trade, then the market closes.
      await trade('100');
      const clock = await now();
      tradingSessions.set(clock, clock, ['KRX', 'US']);
      const before = await funds();
      const above = await register(s, {
        triggerCondition: 'at_or_above',
        triggerPrice: '105',
        executionType: 'market',
        quantity: '2',
      });
      // 100 already meets "at or below 200": an open session refuses it, a
      // closed one keeps the user's choice as sent.
      const below = await register(s, {
        triggerCondition: 'at_or_below',
        triggerPrice: '200',
        executionType: 'limit',
        limitPrice: '210',
        quantity: '1',
      });
      for (const id of [above, below]) {
        const row = await watch(id);
        assert.equal(row.status, 'watching');
        assert.equal(row.registrationSnapshotId, null);
        assert.equal(row.orderId, null);
      }
      assert.equal((await watch(below)).triggerCondition, 'at_or_below');
      const listed = await conditionalBuy.list(s.userId, s.accountId, {});
      assert.deepEqual(
        listed.data.capabilities.offSessionMarkets,
        kind === 'KRX' ? ['KRX'] : ['KRX', 'US'],
      );
      assert.deepEqual(
        listed.data.conditionalOrders.map((row) => row.registeredOffSession),
        [true, true],
      );
      // Nothing is reserved, and an off-hours trade (one that meets both
      // conditions) is not evidence while the market is closed.
      assert.equal(await funds(), before);
      await trade('300');
      for (const id of [above, below])
        assert.equal(
          (await conditionalBuy.evaluate(id)).state,
          'price_unavailable',
        );
      // An undecidable calendar is never taken for a closure.
      markMarketSessionOverrideStoreRequired();
      try {
        await rejects(
          register(s, {
            triggerCondition: 'at_or_above',
            triggerPrice: '150',
            executionType: 'market',
            quantity: '1',
          }),
          'MARKET_CALENDAR_UNAVAILABLE',
        );
      } finally {
        resetMarketSessionOverrideStoreForTest();
      }
      // The next regular session opens after those trades: neither the
      // off-hours trade nor the previous close is its evidence.
      const open = (await now()).getTime() + 300;
      tradingSessions.set(new Date(open + 86_400_000), undefined, [
        'KRX',
        'US',
      ]);
      await untilDb(open + 50);
      for (const id of [above, below])
        assert.equal(
          (await conditionalBuy.evaluate(id)).state,
          'price_unavailable',
        );
      assert.equal((await watch(above)).status, 'watching');
      // Its first eligible trade gaps past 105: met at once, bought at that
      // session price through the ordinary market core.
      await trade('110');
      assert.equal((await conditionalBuy.evaluate(above)).state, 'ordered');
      const bought = (await watch(above)).order;
      assert.equal(bought?.status, 'executed');
      assert.equal(bought?.executedPrice?.toFixed(0), '110');
      assert.equal(
        ((await watch(above)).triggerEvidenceJson as { price: string }).price,
        '110.00000000',
      );
      // The direction chosen off-session was never flipped: 110 ≤ 200.
      assert.equal((await conditionalBuy.evaluate(below)).state, 'ordered');
      const limit = (await watch(below)).order;
      assert.equal(limit?.status, 'submitted');
      assert.equal(limit?.limitPrice?.toFixed(0), '210');
      // One order per watch; a repeated evaluation creates nothing new.
      assert.equal((await conditionalBuy.evaluate(above)).state, 'terminal');
      assert.equal(await orderCount(s), 2);
      pass(
        `${kind} off-session registration: direction as sent, no reservation, no off-hours trigger, next-session first trade (gap) decides, calendar unavailable refused`,
      );
    });
  } finally {
    if (previous === undefined) delete process.env.US_STOCK_PRICE_PROVIDER;
    else process.env.US_STOCK_PRICE_PROVIDER = previous;
  }
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

/**
 * US stocks on the Tiingo provider (2026-10-17): a conditional BUY registers
 * like KRX, watches only the stored Tiingo price (a higher, newer KIS price
 * never fires it) and buys at the Tiingo price from the USD wallet.
 */
async function usOnTiingo() {
  const previous = process.env.US_STOCK_PRICE_PROVIDER;
  process.env.US_STOCK_PRICE_PROVIDER = 'tiingo';
  try {
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
      const usdWallet = {
        tradingAccountId: s.accountId,
        walletScope: 'securities' as const,
        currencyCode: 'USD' as const,
      };
      await db.cashWallet.updateMany({
        where: usdWallet,
        data: { balanceAmount: '10000' },
      });
      const usPrice = async (
        value: string,
        sourceName = 'tiingo_us_reference_price',
      ) => {
        const at = await now();
        return db.assetPriceSnapshot.create({
          data: {
            assetId: asset.id,
            price: value,
            currencyCode: 'USD',
            sourceType: 'provider_api',
            sourceName,
            effectiveAt: at,
            capturedAt: at,
          },
        });
      };
      const usd = async () =>
        (await db.cashWallet.findFirstOrThrow({ where: usdWallet }))
          .balanceAmount;
      await usPrice('100');
      const before = await usd();
      const id = await register(s, {
        triggerCondition: 'at_or_above',
        triggerPrice: '110',
        executionType: 'market',
        quantity: '2',
      });
      // A higher, newer KIS price is not this provider's: it never fires the
      // watch (the only eligible evidence still predates the registration).
      await usPrice('120', 'kis_us_delayed_trade');
      assert.equal((await conditionalBuy.evaluate(id)).state, 'awaiting_price');
      await usPrice('105');
      assert.equal((await conditionalBuy.evaluate(id)).state, 'watching');
      await usPrice('111');
      assert.equal((await conditionalBuy.evaluate(id)).state, 'ordered');
      const bought = (await watch(id)).order;
      assert.equal(bought?.status, 'executed');
      assert.equal(bought?.executedPrice?.toFixed(2), '111.00');
      assert.equal(bought?.currencyCode, 'USD');
      assert.equal(
        new Prisma.Decimal(before).minus(await usd()).toFixed(8),
        bought?.netAmount?.toFixed(8),
      );
      pass(
        'US stock on the Tiingo provider: conditional BUY registers, ignores a higher KIS price, and buys at the Tiingo price from the USD wallet',
      );
    });
  } finally {
    if (previous === undefined) delete process.env.US_STOCK_PRICE_PROVIDER;
    else process.env.US_STOCK_PRICE_PROVIDER = previous;
  }
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

/** 16 nearby triggers, using the existing order/reservation/settlement core. */
async function smallConcurrentBatch(executionType: 'market' | 'limit') {
  await scenario('general', async (s) => {
    await market(s, 'BINANCE');
    await quote(s, 'BINANCE', '100');
    const ids: string[] = [];
    for (let i = 0; i < 16; i++)
      ids.push(
        await register(s, {
          triggerCondition: 'at_or_above',
          triggerPrice: '102',
          executionType,
          ...(executionType === 'limit' ? { limitPrice: '101' } : {}),
          amount: '10',
        }),
      );
    const before = await wallet(s, 'BINANCE');
    const triggerPrice = await quote(s, 'BINANCE', '102');
    const startedAt = monotonicClock.now();
    const workers = [0, 1].map(
      () =>
        new ConditionalBuyWorker(
          db,
          new OpsJobLockService(db),
          new OpsJobRunService(db),
          conditionalBuy,
        ),
    );
    const firstPass = await Promise.all([
      ...workers.map((worker) => worker.tick()),
      ...ids.map((id) => conditionalBuy.evaluate(id)),
    ]);
    const replay = await Promise.all(
      ids.map((id) => conditionalBuy.evaluate(id)),
    );
    const rows = await db.order.findMany({
      where: { tradingAccountId: s.accountId },
    });
    const outcomes = await db.conditionalBuyOrder.findMany({
      where: { tradingAccountId: s.accountId },
      select: {
        id: true,
        status: true,
        failureCode: true,
        terminalReason: true,
        attemptCount: true,
        createdAt: true,
        triggeredAt: true,
        lastAttemptAt: true,
        order: { select: { status: true } },
      },
    });
    const observedAt = await now();
    // Counts, codes and relative clocks only: no account/order IDs, prices,
    // wallet amounts, credentials or large Prisma objects in failure output.
    const diagnostics = JSON.stringify({
      executionType,
      elapsedMs: Math.round(monotonicClock.now() - startedAt),
      nodeMinusDbMs: Date.now() - observedAt.getTime(),
      triggerEvidenceAgeMs:
        observedAt.getTime() - triggerPrice.capturedAt.getTime(),
      workerStates: firstPass.slice(0, workers.length),
      directStates: firstPass.slice(workers.length),
      replayStates: replay,
      watches: ids.map((id, index) => {
        const row = outcomes.find((item) => item.id === id);
        return {
          index,
          status: row?.status ?? 'missing',
          failureCode: row?.failureCode ?? null,
          terminalReason: row?.terminalReason ?? null,
          attempts: row?.attemptCount ?? null,
          evidenceAfterRegistrationMs: row
            ? triggerPrice.effectiveAt.getTime() - row.createdAt.getTime()
            : null,
          triggerAgeMs: row?.triggeredAt
            ? observedAt.getTime() - row.triggeredAt.getTime()
            : null,
          lastAttemptAgeMs: row?.lastAttemptAt
            ? observedAt.getTime() - row.lastAttemptAt.getTime()
            : null,
          orderStatus: row?.order?.status ?? null,
        };
      }),
    });
    console.log(`Conditional BUY batch evidence ${diagnostics}`);
    assert.equal(rows.length, 16, diagnostics);
    assert.equal(new Set(rows.map((row) => row.id)).size, 16);
    for (const id of ids)
      assert.equal((await watch(id)).status, 'ordered', diagnostics);
    if (executionType === 'limit') {
      assert.equal(rows.filter((row) => row.status === 'submitted').length, 16);
      const pending = await wallet(s, 'BINANCE');
      assert.equal(pending.balance, before.balance);
      assert.equal(
        pending.reserved,
        rows
          .reduce(
            (sum, row) => sum.add(row.reservedAmount ?? 0),
            new Prisma.Decimal(0),
          )
          .toFixed(8),
      );
      await quote(s, 'BINANCE', '100');
      assert.equal(
        (await matcher.matchDueLimitOrders({ now: await now() })).filledPathA,
        16,
      );
    }
    await new ConditionalBuyWorker(
      db,
      new OpsJobLockService(db),
      new OpsJobRunService(db),
      conditionalBuy,
    ).tick();
    const executed = await db.order.findMany({
      where: { tradingAccountId: s.accountId, status: 'executed' },
    });
    assert.equal(executed.length, 16);
    assert.equal(await ledgerCount(s), 16);
    const after = await wallet(s, 'BINANCE');
    assert.equal(after.reserved, '0.00000000');
    assert.equal(
      new Prisma.Decimal(before.balance).sub(after.balance).toFixed(8),
      executed
        .reduce(
          (sum, row) => sum.add(row.netAmount ?? 0),
          new Prisma.Decimal(0),
        )
        .toFixed(8),
    );
    const position = await db.position.findFirstOrThrow({
      where: {
        tradingAccountId: s.accountId,
        assetId: s.instruments[0].asset.id,
      },
    });
    assert.equal(
      position.quantity.toFixed(8),
      executed
        .reduce(
          (sum, row) => sum.add(row.executedQuantity ?? row.quantity),
          new Prisma.Decimal(0),
        )
        .toFixed(8),
    );
    assert.equal(await orderCount(s), 16);
    pass(
      `16 ${executionType} triggers + two workers + replay/restart: unique orders, cash/reservation/holding conserved`,
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
  await offSessionRegistration('KRX');
  await offSessionRegistration('US');
  await cryptoSourceSeparation();
  await staleTrigger();
  await lifecycle();
  await flagsAndScope();
  await listStates();
  await usStockScope();
  await usOnTiingo();
  await beginner();
  await workerLease();
  await smallConcurrentBatch('market');
  await smallConcurrentBatch('limit');
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
