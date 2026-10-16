import { tradingSessions } from '../test/support/trading-session-fixture';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  db,
  fixture,
  now,
  untilDb,
  holdRowLock,
  untilLockWaiting,
  fxEvidence,
  fxEvidenceIds,
  cleanup,
  code,
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
import {
  LimitOnCloseEvidenceService,
  SessionCloseEvidenceError,
  type KoscomSessionCloseSource,
  type SessionCloseTarget,
} from '../src/orders/limit-on-close-evidence.service';
import { LimitOnCloseSettlementService } from '../src/orders/limit-on-close-settlement.service';
import { LimitOnCloseWorker } from '../src/orders/limit-on-close-worker.service';
import type { LimitOnCloseConfig } from '../src/orders/limit-on-close.config';
import { sessionDateText } from '../src/orders/limit-on-close.policy';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { lockSeasonTradingContext } from '../src/seasons/season-trading-lock';
import {
  applyMarketSessionOverrideSnapshot,
  markMarketSessionOverrideStoreRequired,
} from '../src/orders/market-calendar/market-session-override.store';

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.LIMIT_ON_CLOSE_DB_INTEGRATION !== '1'
)
  throw new Error('Explicit disposable Limit-on-Close PG opt-in required');
process.env.LOC_ORDERS_ENABLED = 'true';
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
const evidence = new LimitOnCloseEvidenceService(db);

/**
 * Deterministic dated-close provider double. It returns the SAME observation
 * contract as the KOSCOM source (exact symbol/date, receipt after close); the
 * KOSCOM request/validation itself is covered by unit tests with fixtures.
 */
const closes: Array<string | Error> = [];
let observeCalls = 0;
const source = {
  async observe(target: SessionCloseTarget) {
    observeCalls++;
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
      closePrice: new Prisma.Decimal(next),
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
const config: LimitOnCloseConfig = {
  enabled: true,
  sellEnabled: false,
  evidenceMinDelayMs: 0,
  evidenceConfirmMs: CONFIRM_MS,
  evidenceDeadlineMs: 10_800_000,
  // US LOC (2026-10-17) has its own flags and suite; off here.
  us: {
    enabled: false,
    sellEnabled: false,
    evidenceEarliestMinute: 21 * 60 + 10,
    evidenceConfirmMs: 300_000,
    evidenceDeadlineMinute: 23 * 60,
  },
};
// Fills record the existing equity snapshot, which values the account's USD
// wallets with fresh provider FX exactly like any other limit fill.
const cycle = async () => {
  await fxEvidence();
  return settlement.runCycle({ config });
};

let checks = 0;
function pass(label: string) {
  checks++;
  console.log(`PASS LOC ${label}`);
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
async function waitDb(ms: number) {
  await untilDb((await now()).getTime() + ms);
}

type Loc = Scenario & { assetId: string; closeAt: Date };

async function locScenario(
  mode: 'general' | 'season' | 'beginner',
  work: (s: Loc) => Promise<void>,
  options: { closeInMs?: number; freshLearning?: boolean } = {},
) {
  const base = await fixture(mode, '10000', options.freshLearning ?? false);
  closes.length = 0;
  try {
    const clock = await now();
    const closeAt = new Date(clock.getTime() + (options.closeInMs ?? 2500));
    tradingSessions.set(clock, closeAt, ['KRX', 'US']);
    const asset = await db.asset.update({
      where: { id: base.instruments[0].asset.id },
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
        tradingAccountId: base.accountId,
        walletScope: 'securities',
        currencyCode: 'KRW',
      },
      data: { balanceAmount: '100000' },
    });
    // An in-session trade, as KOSCOM collection provides in production; the
    // existing post-fill equity snapshot values the new position with it.
    await realtime({ ...base, assetId: asset.id, closeAt }, '100');
    await work({ ...base, assetId: asset.id, closeAt });
  } finally {
    tradingSessions.reset();
    await release(base);
  }
}
async function release(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  const assetIds = s.instruments.map((row) => row.asset.id);
  await db.limitOnCloseOrder.deleteMany({ where });
  await db.order.deleteMany({ where });
  await db.position.deleteMany({ where });
  await db.seasonRanking.deleteMany({ where });
  await db.dailyPortfolioSnapshot.deleteMany({ where });
  await db.sessionClosePriceEvidence.deleteMany({
    where: { assetId: { in: assetIds } },
  });
  await db.marketCandle.deleteMany({ where: { assetId: { in: assetIds } } });
  await cleanup(s);
}

function locBody(s: Loc, patch: OrderRequestBody = {}): OrderRequestBody {
  return {
    assetId: s.assetId,
    side: 'buy',
    orderType: 'limit',
    quantity: '10',
    limitPrice: '100',
    limitOnClose: true,
    ...patch,
  };
}
async function place(s: Loc, patch: OrderRequestBody = {}, key = randomUUID()) {
  const body = locBody(s, patch);
  const quote = await orders.quoteOrderForTradingAccount(
    s.userId,
    s.accountId,
    body,
  );
  const created = await orders.createOrderForTradingAccount(
    s.userId,
    s.accountId,
    { ...body, quoteId: quote.data.quoteId, idempotencyKey: key },
  );
  return { quote, created, orderId: created.data.order.orderId };
}
async function krwWallet(s: Scenario) {
  const row = await db.cashWallet.findFirstOrThrow({
    where: {
      tradingAccountId: s.accountId,
      walletScope: 'securities',
      currencyCode: 'KRW',
    },
  });
  return {
    balance: row.balanceAmount.toFixed(8),
    reserved: row.reservedAmount.toFixed(8),
  };
}
const order = (id: string) =>
  db.order.findUniqueOrThrow({
    where: { id },
    include: { limitOnClose: { include: { closeEvidence: true } } },
  });
const ledger = (s: Scenario) =>
  db.walletTransaction.count({
    where: { tradingAccountId: s.accountId, txType: 'order_buy' },
  });
async function realtime(s: Loc, value: string, at?: Date) {
  const clock = at ?? (await now());
  return db.assetPriceSnapshot.create({
    data: {
      assetId: s.assetId,
      price: value,
      currencyCode: 'KRW',
      sourceType: 'provider_api',
      sourceName: 'koscom_krx_realtime_price',
      effectiveAt: clock,
      capturedAt: clock,
    },
  });
}
/** Final evidence without running settlement (for deterministic races). */
async function finalEvidence(s: Loc, close: string) {
  const row = await db.limitOnCloseOrder.findFirstOrThrow({
    where: { tradingAccountId: s.accountId },
  });
  const target: SessionCloseTarget = {
    assetId: s.assetId,
    symbol: s.instruments[0].asset.symbol,
    assetMarket: 'KRX',
    market: 'KRX',
    sessionDate: row.sessionDate,
    sessionCloseAt: s.closeAt,
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
  return { target, final };
}

/** Close ≤ limit: fill at the final close; pinned fee; price improvement kept. */
async function fillAtClose(mode: 'general' | 'season', close: string) {
  await locScenario(mode, async (s) => {
    const before = await krwWallet(s);
    const { quote, created, orderId } = await place(s);
    assert.equal(
      (quote.data as { limitOnClose?: { market: string } }).limitOnClose
        ?.market,
      'KRX',
    );
    assert.equal(created.data.order.status, 'submitted');
    assert.equal(created.data.order.limitOnClose?.status, 'pending');
    assert.equal(created.data.order.limitOnClose?.sessionDate, '2026-07-10');
    assert.equal(
      (created.data as { executionPolicy?: { autoExecutionEnabled: boolean } })
        .executionPolicy?.autoExecutionEnabled,
      false,
    );
    const placed = await order(orderId);
    const reservedAmount = placed.reservedAmount!.toFixed(8);
    assert.equal((await krwWallet(s)).reserved, reservedAmount);
    assert.equal((await krwWallet(s)).balance, before.balance);
    // The continuous matcher and realtime prices never fill a LOC order.
    await realtime(s, '90');
    await matcher.matchDueLimitOrders({ now: await now() });
    const direct = await fill.fillLimitOrder({
      orderId,
      plan: {
        path: 'snapshot',
        assetPriceSnapshotId: (await realtime(s, '90')).id,
        executedPrice: new Prisma.Decimal('90'),
      },
    });
    assert.equal(direct.state, 'skipped');
    assert.equal(
      direct.state === 'skipped' ? direct.reason : '',
      'limit_on_close_order',
    );
    assert.equal((await order(orderId)).status, 'submitted');
    assert.equal((await cycle()).candidates, 0); // session still open
    await untilDb(s.closeAt.getTime());
    closes.push(close, close);
    let summary = await cycle();
    assert.equal(summary.observations, 1);
    assert.equal((await order(orderId)).status, 'submitted');
    const callsAfterFirst = observeCalls;
    summary = await cycle(); // confirmation interval not elapsed: no request
    assert.equal(observeCalls, callsAfterFirst);
    await waitDb(CONFIRM_MS + 50);
    summary = await cycle();
    assert.equal(summary.filled, 1, JSON.stringify(summary));
    const filled = await order(orderId);
    assert.equal(filled.status, 'executed');
    assert.equal(
      filled.executedPrice?.toFixed(8),
      new Prisma.Decimal(close).toFixed(8),
    );
    const gross = new Prisma.Decimal(close).mul(10);
    assert.equal(filled.grossAmount?.toFixed(8), gross.toFixed(8));
    assert.equal(
      filled.feeAmount?.toFixed(8),
      gross
        .mul(placed.reservationFeeRate!)
        .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP)
        .toFixed(8),
    );
    const after = await krwWallet(s);
    assert.equal(after.reserved, '0.00000000');
    assert.equal(
      new Prisma.Decimal(before.balance).sub(after.balance).toFixed(8),
      filled.netAmount!.toFixed(8),
    );
    assert.ok(filled.netAmount!.lte(placed.reservedAmount!));
    assert.equal(await ledger(s), 1);
    const position = await db.position.findUniqueOrThrow({
      where: {
        tradingAccountId_assetId: {
          tradingAccountId: s.accountId,
          assetId: s.assetId,
        },
      },
    });
    assert.equal(position.quantity.toFixed(0), '10');
    const loc = filled.limitOnClose!;
    assert.equal(loc.status, 'filled');
    assert.equal(loc.decisionReason, 'loc_close_reached');
    assert.equal(loc.closePrice?.toFixed(8), filled.executedPrice?.toFixed(8));
    assert.equal(loc.closeEvidence?.status, 'final');
    assert.equal(loc.closeEvidence?.observationCount, 2);
    assert.ok(loc.closeEvidence.firstObservedAt >= s.closeAt);
    assert.ok(loc.closeEvidence?.confirmRawJson);
    assert.ok(
      (await db.equitySnapshot.count({
        where: { tradingAccountId: s.accountId },
      })) > 0,
    );
    const detail = await orders.getOrderForTradingAccount(
      s.userId,
      s.accountId,
      orderId,
    );
    assert.equal(detail.data.order.limitOnClose?.status, 'filled');
    assert.equal(
      detail.data.order.limitOnClose?.closeEvidence?.status,
      'final',
    );
    // Evidence is immutable once final and settled orders are never revisited.
    const changed = await evidence.recordObservation(
      {
        assetId: s.assetId,
        symbol: s.instruments[0].asset.symbol,
        assetMarket: 'KRX',
        market: 'KRX',
        sessionDate: loc.sessionDate,
        sessionCloseAt: s.closeAt,
      },
      {
        provider: 'koscom',
        sourceName: 'koscom_history',
        providerSymbol: s.instruments[0].asset.symbol,
        providerTradingDate: '20260710',
        closePrice: new Prisma.Decimal('1'),
        currencyCode: 'KRW',
        observedAt: await now(),
        raw: { fixture: 'late revision' },
      },
      CONFIRM_MS,
    );
    assert.equal(
      changed?.closePrice.toFixed(8),
      loc.closeEvidence.closePrice.toFixed(8),
    );
    assert.equal((await cycle()).candidates, 0);
    assert.equal(
      (await order(orderId)).executedPrice?.toFixed(8),
      filled.executedPrice?.toFixed(8),
    );
    pass(
      `${mode} close ${close} vs limit 100: final close fill, reservation settle, immutable evidence`,
    );
  });
}

async function closeAboveLimit(mode: 'general' | 'season') {
  await locScenario(mode, async (s) => {
    const before = await krwWallet(s);
    const { orderId } = await place(s);
    await untilDb(s.closeAt.getTime());
    closes.push('100.5', '100.5');
    await cycle();
    await waitDb(CONFIRM_MS + 50);
    const summary = await cycle();
    assert.equal(summary.unfilled, 1);
    const row = await order(orderId);
    assert.equal(row.status, 'canceled');
    assert.equal(row.cancelReason, 'loc_close_not_reached');
    assert.equal(row.executedPrice, null);
    assert.ok(row.reservationReleasedAt);
    assert.equal(row.limitOnClose?.status, 'unfilled');
    assert.equal(row.limitOnClose?.closePrice?.toFixed(1), '100.5');
    assert.ok(row.limitOnClose?.closeEvidenceId);
    assert.deepEqual(await krwWallet(s), before);
    assert.equal(await ledger(s), 0);
    pass(`${mode} close above limit → unfilled, full reservation release`);
  });
}

async function evidenceUnavailable() {
  await locScenario('season', async (s) => {
    const before = await krwWallet(s);
    const { orderId } = await place(s);
    await untilDb(s.closeAt.getTime());
    // Prices that are NOT final dated close evidence are never substituted.
    await realtime(s, '50', new Date(s.closeAt.getTime() - 1));
    const open5m = new Date(
      Math.floor(s.closeAt.getTime() / 300_000) * 300_000 - 300_000,
    );
    for (const [interval, openTime, closeTime] of [
      ['5m', open5m, new Date(open5m.getTime() + 300_000)],
      ['1d', new Date(open5m.getTime() - 86_400_000), open5m],
    ] as const)
      await db.marketCandle.create({
        data: {
          assetId: s.assetId,
          interval,
          openTime,
          closeTime,
          open: '60',
          high: '60',
          low: '50',
          close: '50',
          volume: '1',
          isClosed: true,
          sourceProvider: 'koscom_history',
          sourceUpdatedAt: closeTime,
        },
      });
    let summary = await cycle();
    assert.equal(summary.observationFailures.KOSCOM_CLOSE_EVIDENCE_MISSING, 1);
    let row = await order(orderId);
    assert.equal(row.status, 'submitted');
    assert.equal(
      row.limitOnClose?.lastCheckCode,
      'KOSCOM_CLOSE_EVIDENCE_MISSING',
    );
    // Delayed collection keeps waiting inside the bounded window …
    summary = await cycle();
    assert.equal(summary.waiting, 1);
    // … and the deadline releases instead of waiting forever.
    await db.limitOnCloseOrder.update({
      where: { orderId },
      data: { evidenceDeadlineAt: new Date((await now()).getTime() - 1) },
    });
    summary = await cycle();
    assert.equal(summary.expired.loc_close_evidence_unavailable, 1);
    row = await order(orderId);
    assert.equal(row.status, 'canceled');
    assert.equal(row.cancelReason, 'loc_close_evidence_unavailable');
    assert.equal(row.executedPrice, null);
    assert.equal(row.limitOnClose?.status, 'expired');
    assert.deepEqual(await krwWallet(s), before);
    assert.equal(await ledger(s), 0);
    pass(
      'missing/delayed close evidence: realtime/5m/1d never substituted; deadline expiry releases',
    );
  });
}

async function unstableEvidence() {
  await locScenario('general', async (s) => {
    const { orderId } = await place(s);
    await untilDb(s.closeAt.getTime());
    closes.push('95', '96');
    await cycle();
    await waitDb(CONFIRM_MS + 50);
    await cycle(); // different value: confirmation restarts
    assert.equal((await order(orderId)).status, 'submitted');
    const row = await db.sessionClosePriceEvidence.findFirstOrThrow({
      where: { assetId: s.assetId },
    });
    assert.equal(row.status, 'observing');
    assert.equal(row.mismatchCount, 1);
    closes.push('96');
    await waitDb(CONFIRM_MS + 50);
    const summary = await cycle();
    assert.equal(summary.filled, 1, JSON.stringify(summary));
    assert.equal((await order(orderId)).executedPrice?.toFixed(0), '96');
    pass(
      'changing provider close restarts confirmation; only a stable close fills',
    );
  });
}

/** The fill reuses the equity snapshot, which needs an eligible valuation
 * price; without one the fill rolls back and the deadline releases cash. */
async function valuationGap() {
  await locScenario('general', async (s) => {
    const before = await krwWallet(s);
    await db.assetPriceSnapshot.deleteMany({ where: { assetId: s.assetId } });
    const { orderId } = await place(s);
    await untilDb(s.closeAt.getTime());
    await finalEvidence(s, '95');
    let summary = await cycle();
    assert.equal(summary.errors.LOC_FILL_FAILED, 1, JSON.stringify(summary));
    let row = await order(orderId);
    assert.equal(row.status, 'submitted');
    assert.equal(row.limitOnClose?.lastCheckCode, 'LOC_FILL_FAILED');
    assert.equal(await ledger(s), 0);
    await db.limitOnCloseOrder.update({
      where: { orderId },
      data: { evidenceDeadlineAt: new Date((await now()).getTime() - 1) },
    });
    summary = await cycle();
    assert.equal(
      summary.expired.loc_fill_not_permitted,
      1,
      JSON.stringify(summary),
    );
    row = await order(orderId);
    assert.equal(row.cancelReason, 'loc_fill_not_permitted');
    assert.equal(row.limitOnClose?.status, 'expired');
    assert.ok(row.limitOnClose?.closeEvidenceId);
    assert.deepEqual(await krwWallet(s), before);
    pass(
      'blocked fill (no valuation price) rolls back atomically; deadline releases',
    );
  });
}

async function cancelBeforeClose() {
  await locScenario('season', async (s) => {
    const before = await krwWallet(s);
    const { orderId } = await place(s);
    const canceled = await orders.cancelOrderForTradingAccount(
      s.userId,
      s.accountId,
      orderId,
    );
    assert.equal(canceled.data.order.status, 'canceled');
    const row = await order(orderId);
    assert.equal(row.cancelReason, 'user_canceled');
    assert.equal(row.limitOnClose?.status, 'canceled');
    assert.deepEqual(await krwWallet(s), before);
    await untilDb(s.closeAt.getTime());
    assert.equal((await cycle()).candidates, 0);
    pass(
      'user cancel before close releases the reservation; settlement ignores it',
    );
  });
}

async function cancelVersusSettlement() {
  for (let round = 0; round < 3; round++)
    await locScenario('season', async (s) => {
      const before = await krwWallet(s);
      const { orderId } = await place(s);
      await untilDb(s.closeAt.getTime());
      await finalEvidence(s, '99');
      const [, canceled] = await Promise.allSettled([
        cycle(),
        orders.cancelOrderForTradingAccount(s.userId, s.accountId, orderId),
      ]);
      const row = await order(orderId);
      const after = await krwWallet(s);
      assert.equal(after.reserved, '0.00000000');
      if (row.status === 'executed') {
        assert.equal(row.limitOnClose?.status, 'filled');
        assert.equal(canceled.status, 'rejected');
        assert.equal(await ledger(s), 1);
      } else {
        assert.equal(row.status, 'canceled');
        assert.equal(row.limitOnClose?.status, 'canceled');
        assert.deepEqual(after, before);
        assert.equal(await ledger(s), 0);
      }
    });
  pass('LOC settlement vs user cancel → exactly one winner (3 rounds)');
}

async function duplicateWorkers() {
  await locScenario('season', async (s) => {
    const { orderId } = await place(s);
    await untilDb(s.closeAt.getTime());
    await finalEvidence(s, '98');
    await Promise.all([cycle(), cycle(), cycle()]);
    assert.equal((await order(orderId)).status, 'executed');
    assert.equal(await ledger(s), 1);
    assert.equal(
      (
        await db.seasonParticipant.findUniqueOrThrow({
          where: { tradingAccountId: s.accountId },
        })
      ).totalFillCount,
      1,
    );
    pass(
      'concurrent settlement cycles → one fill, one ledger row, one fill count',
    );
  });
  await locScenario('general', async (s) => {
    const { orderId } = await place(s);
    await untilDb(s.closeAt.getTime());
    await finalEvidence(s, '98');
    const workers = [0, 1].map(
      () =>
        new LimitOnCloseWorker(
          new OpsJobLockService(db),
          new OpsJobRunService(db),
          settlement,
        ),
    );
    await fxEvidence();
    const results = await Promise.all(workers.map((worker) => worker.tick()));
    assert.equal(
      results.filter((result) => (result?.filled ?? 0) > 0).length,
      1,
    );
    assert.equal((await order(orderId)).status, 'executed');
    assert.equal(await ledger(s), 1);
    pass('two worker instances share one OpsJobLock lease');
  });
}

async function lifecycleRaces() {
  await locScenario('season', async (s) => {
    const before = await krwWallet(s);
    const { orderId } = await place(s);
    await untilDb(s.closeAt.getTime());
    await finalEvidence(s, '97');
    // The Season ends between the close and settlement: no fill after endAt.
    await db.season.update({
      where: { id: s.season!.id },
      data: { status: 'ended', endAt: new Date((await now()).getTime() - 1) },
    });
    const summary = await cycle();
    assert.equal(summary.skipped.season_not_active, 1);
    assert.equal((await order(orderId)).status, 'submitted');
    await cancel.cleanupEndedSeasonLimitReservations({ now: await now() });
    const row = await order(orderId);
    assert.equal(row.status, 'canceled');
    assert.equal(row.cancelReason, 'season_ended');
    assert.equal(row.limitOnClose?.status, 'canceled');
    assert.deepEqual(await krwWallet(s), before);
    pass(
      'Season end races LOC settlement → no fill, lifecycle cleanup releases',
    );
  });
  await locScenario('season', async (s) => {
    const { orderId } = await place(s);
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
    const row = await order(orderId);
    assert.equal(row.cancelReason, 'participant_excluded');
    assert.equal(row.limitOnClose?.status, 'canceled');
    assert.equal((await krwWallet(s)).reserved, '0.00000000');
    pass('participant exclusion cleanup cancels LOC and releases');
  });
  await locScenario('season', async (s) => {
    await db.season.update({
      where: { id: s.season!.id },
      data: { endAt: s.closeAt },
    });
    await rejects(place(s), 'LOC_SESSION_AFTER_SEASON_END');
    assert.equal((await krwWallet(s)).reserved, '0.00000000');
    pass('a session closing at Season end is refused at registration');
  });
  await locScenario('general', async (s) => {
    const before = await krwWallet(s);
    const { orderId } = await place(s);
    const submittedAt = (await order(orderId)).submittedAt;
    // Operator early close/closure published after acceptance: the session
    // no longer contains the submission.
    tradingSessions.set(
      new Date(submittedAt.getTime() - 60_000),
      new Date(submittedAt.getTime() - 1),
      ['KRX', 'US'],
    );
    await untilDb(s.closeAt.getTime());
    closes.push('90', '90');
    const summary = await cycle();
    assert.equal(summary.expired.loc_session_invalid, 1);
    const row = await order(orderId);
    assert.equal(row.cancelReason, 'loc_session_invalid');
    assert.equal(row.limitOnClose?.status, 'expired');
    assert.deepEqual(await krwWallet(s), before);
    closes.length = 0;
    pass('calendar override after acceptance invalidates the session → expiry');
  });
}

async function registrationRules() {
  await locScenario('season', async (s) => {
    // Boundary: quote while open, create after the DB-clock close.
    const body = locBody(s);
    const quote = await orders.quoteOrderForTradingAccount(
      s.userId,
      s.accountId,
      body,
    );
    await untilDb(s.closeAt.getTime());
    await rejects(
      orders.createOrderForTradingAccount(s.userId, s.accountId, {
        ...body,
        quoteId: quote.data.quoteId,
        idempotencyKey: randomUUID(),
      }),
      'LOC_SESSION_NOT_OPEN',
    );
    assert.equal(
      await db.order.count({ where: { tradingAccountId: s.accountId } }),
      0,
    );
    assert.equal((await krwWallet(s)).reserved, '0.00000000');
    await rejects(
      orders.quoteOrderForTradingAccount(s.userId, s.accountId, body),
      'LOC_SESSION_NOT_OPEN',
    );
    // An ordinary limit remains registrable while confirmed CLOSED.
    const ordinary = { ...body, limitOnClose: undefined };
    const ordinaryQuote = await orders.quoteOrderForTradingAccount(
      s.userId,
      s.accountId,
      ordinary,
    );
    assert.equal(
      (ordinaryQuote.data as { limitOnClose?: unknown }).limitOnClose ===
        undefined,
      true,
    );
    pass(
      'close boundary re-checked at the post-lock DB clock; closed session refused',
    );
  });
  await locScenario('season', async (s) => {
    for (const [patch, expected] of [
      // LOC SELL has its own flag (off here); the BUY flag never opens it.
      [{ side: 'sell' }, 'LOC_SELL_ORDERS_DISABLED'],
      [
        { orderType: 'market', limitPrice: undefined },
        'INVALID_LIMIT_ON_CLOSE',
      ],
      [{ limitOnClose: 'yes' }, 'INVALID_LIMIT_ON_CLOSE'],
      [
        {
          attachedProtection: [
            { kind: 'stop_loss', triggerPrice: '90', childOrderType: 'market' },
          ],
        },
        'LOC_ATTACHED_PROTECTION_NOT_SUPPORTED',
      ],
      [{ quantity: '1.5' }, 'FRACTIONAL_LIMIT_ORDER_NOT_SUPPORTED'],
      [{ quantity: '100000' }, 'INSUFFICIENT_AVAILABLE_BALANCE'],
    ] as Array<[OrderRequestBody, string]>)
      await rejects(
        orders.quoteOrderForTradingAccount(
          s.userId,
          s.accountId,
          locBody(s, patch),
        ),
        expected,
      );
    // Idempotent create: one order, one reservation; a different intent conflicts.
    const key = `loc-${randomUUID()}`;
    const body = locBody(s);
    const quote = await orders.quoteOrderForTradingAccount(
      s.userId,
      s.accountId,
      body,
    );
    const request = {
      ...body,
      quoteId: quote.data.quoteId,
      idempotencyKey: key,
    };
    const first = await orders.createOrderForTradingAccount(
      s.userId,
      s.accountId,
      request,
    );
    const replay = await orders.createOrderForTradingAccount(
      s.userId,
      s.accountId,
      request,
    );
    assert.equal(replay.data.order.orderId, first.data.order.orderId);
    assert.equal(
      (await krwWallet(s)).reserved,
      (await order(first.data.order.orderId)).reservedAmount!.toFixed(8),
    );
    await rejects(
      orders.createOrderForTradingAccount(s.userId, s.accountId, {
        ...request,
        limitOnClose: undefined,
      }),
      'ORDER_IDEMPOTENCY_CONFLICT',
    );
    // Flag off: no new LOC; committed replay, read and cancel still work.
    process.env.LOC_ORDERS_ENABLED = 'false';
    try {
      await rejects(
        orders.quoteOrderForTradingAccount(s.userId, s.accountId, body),
        'LOC_ORDERS_DISABLED',
      );
      const again = await orders.createOrderForTradingAccount(
        s.userId,
        s.accountId,
        request,
      );
      assert.equal(again.data.order.orderId, first.data.order.orderId);
      const canceled = await orders.cancelOrderForTradingAccount(
        s.userId,
        s.accountId,
        first.data.order.orderId,
      );
      assert.equal(canceled.data.order.status, 'canceled');
    } finally {
      process.env.LOC_ORDERS_ENABLED = 'true';
    }
    assert.equal((await krwWallet(s)).reserved, '0.00000000');
    // Calendar unavailable fails closed.
    markMarketSessionOverrideStoreRequired();
    try {
      await rejects(
        orders.quoteOrderForTradingAccount(s.userId, s.accountId, body),
        'MARKET_CALENDAR_UNAVAILABLE',
      );
    } finally {
      applyMarketSessionOverrideSnapshot([], new Date());
    }
    pass(
      'input/side/attachment/funds rules, idempotent replay, flag-off drain, calendar outage',
    );
  });
  for (const kind of ['NAS', 'BINANCE'] as const)
    await locScenario('season', async (s) => {
      await db.asset.update({
        where: { id: s.assetId },
        data:
          kind === 'NAS'
            ? {
                market: 'NAS',
                assetType: 'us_stock',
                currencyCode: 'USD',
                priceCurrency: 'USD',
                settlementCurrency: 'USD',
              }
            : {
                market: 'BINANCE',
                assetType: 'crypto',
                currencyCode: 'USD',
                priceCurrency: 'USD',
                settlementCurrency: 'USD',
              },
      });
      await fxEvidence();
      await rejects(
        orders.quoteOrderForTradingAccount(
          s.userId,
          s.accountId,
          locBody(
            s,
            kind === 'BINANCE' ? { quantity: undefined, amount: '100' } : {},
          ),
        ),
        'LOC_MARKET_NOT_SUPPORTED',
      );
      pass(
        `${kind}: LOC refused (US LOC flags off here, its own suite covers US; no crypto LOC)`,
      );
    });
  await locScenario(
    'beginner',
    async (s) => {
      await rejects(
        orders.quoteOrderForTradingAccount(s.userId, s.accountId, locBody(s)),
        'BEGINNER_FEATURE_LOCKED',
      );
      pass('beginner learning lock applies to LOC');
    },
    { freshLearning: true },
  );
}

async function ordinaryLimitUnaffected() {
  await locScenario('general', async (s) => {
    const { orderId: locId } = await place(s);
    const ordinaryBody = { ...locBody(s), limitOnClose: undefined };
    const quote = await orders.quoteOrderForTradingAccount(
      s.userId,
      s.accountId,
      ordinaryBody,
    );
    const ordinary = await orders.createOrderForTradingAccount(
      s.userId,
      s.accountId,
      {
        ...ordinaryBody,
        quoteId: quote.data.quoteId,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal('limitOnClose' in ordinary.data.order, false);
    await realtime(s, '95');
    await fxEvidence();
    const summary = await matcher.matchDueLimitOrders({ now: await now() });
    assert.equal(summary.filledPathA, 1);
    assert.equal((await order(ordinary.data.order.orderId)).status, 'executed');
    assert.equal((await order(locId)).status, 'submitted');
    pass('ordinary limit still fills via path A next to a pending LOC');
  });
}

async function databaseConstraints() {
  await locScenario('general', async (s) => {
    const { orderId } = await place(s);
    const other = await fixture('general');
    await assert.rejects(
      db.limitOnCloseOrder.update({
        where: { orderId },
        data: { status: 'filled', decidedAt: await now() },
      }),
    );
    try {
      await assert.rejects(
        db.limitOnCloseOrder.update({
          where: { orderId },
          data: { tradingAccountId: other.accountId },
        }),
      );
    } finally {
      await release(other);
    }
    const snapshot = await realtime(s, '90');
    await assert.rejects(
      db.conditionalBuyOrder.create({
        data: {
          tradingAccountId: s.accountId,
          assetId: s.assetId,
          triggerCondition: 'at_or_above',
          triggerPrice: '1',
          executionType: 'market',
          limitPrice: '1',
          quantity: '1',
          currencyCode: 'KRW',
          registrationSnapshotId: snapshot.id,
          idempotencyKey: randomUUID(),
          requestHash: 'x',
        },
      }),
    );
    await assert.rejects(
      db.conditionalBuyOrder.create({
        data: {
          tradingAccountId: s.accountId,
          assetId: s.assetId,
          triggerCondition: 'at_or_above',
          triggerPrice: '1',
          executionType: 'market',
          quantity: '1',
          currencyCode: 'KRW',
          status: 'ordered',
          idempotencyKey: randomUUID(),
          requestHash: 'x',
        },
      }),
    );
    await assert.rejects(
      db.sessionClosePriceEvidence.create({
        data: {
          assetId: s.assetId,
          market: 'KRX',
          sessionDate: new Date('2026-07-10T00:00:00.000Z'),
          sessionCloseAt: s.closeAt,
          provider: 'koscom',
          sourceName: 'koscom_history',
          providerSymbol: 'X',
          providerTradingDate: '20260710',
          closePrice: '1',
          currencyCode: 'KRW',
          status: 'final',
          firstObservedAt: s.closeAt,
          lastObservedAt: s.closeAt,
          firstRawJson: {},
          policyVersion: 1,
        },
      }),
    );
    pass(
      'DB CHECK/FK constraints reject inconsistent LOC, watch and evidence rows',
    );
  });
}

// ── The evidence deadline bounds the fill itself ─────────────────────────────

const locPlan = (final: { id: string; closePrice: Prisma.Decimal }) => ({
  path: 'session_close' as const,
  executedPrice: final.closePrice,
  closeEvidenceId: final.id,
});
const outcomeOf = (outcome: Awaited<ReturnType<typeof fill.fillLimitOrder>>) =>
  outcome.state === 'skipped' ? outcome.reason : outcome.state;
async function setDeadline(orderId: string, at: Date) {
  await db.limitOnCloseOrder.update({
    where: { orderId },
    data: { evidenceDeadlineAt: at },
  });
  return at;
}
/** A deadline already passed by more than this host's backward clock steps
 * (and, as the schema requires, after the session close). */
async function passDeadline(s: Loc, orderId: string) {
  await untilDb(s.closeAt.getTime() + 3000);
  return setDeadline(orderId, new Date((await now()).getTime() - 2000));
}
const krwWalletId = async (s: Scenario) =>
  (
    await db.cashWallet.findFirstOrThrow({
      where: {
        tradingAccountId: s.accountId,
        walletScope: 'securities',
        currencyCode: 'KRW',
      },
    })
  ).id;
/** Nothing of a refused fill remains: submitted, pending, reservation held. */
async function assertNotFilled(
  s: Loc,
  orderId: string,
  before: { balance: string; reserved: string },
) {
  const row = await order(orderId);
  assert.equal(row.status, 'submitted');
  assert.equal(row.executedAt, null);
  assert.equal(row.sessionCloseEvidenceId, null);
  assert.equal(row.limitOnClose?.status, 'pending');
  const wallet = await krwWallet(s);
  assert.equal(wallet.balance, before.balance);
  assert.equal(wallet.reserved, row.reservedAmount!.toFixed(8));
  assert.equal(await ledger(s), 0);
  assert.equal(
    await db.position.count({ where: { tradingAccountId: s.accountId } }),
    0,
  );
}
/** Concurrent cycles after the deadline expire it once and release exactly
 * the reservation; nothing moves afterwards. */
async function assertExpiredOnce(
  s: Loc,
  orderId: string,
  before: { balance: string; reserved: string },
) {
  const summaries = await Promise.all([cycle(), cycle()]);
  const total = (pick: (x: (typeof summaries)[number]) => number) =>
    summaries.reduce((sum, x) => sum + pick(x), 0);
  assert.equal(
    total((x) => x.expired.loc_fill_not_permitted ?? 0),
    1,
    JSON.stringify(summaries),
  );
  assert.equal(
    total((x) => x.filled),
    0,
  );
  const row = await order(orderId);
  assert.equal(row.status, 'canceled');
  assert.equal(row.cancelReason, 'loc_fill_not_permitted');
  assert.equal(row.executedPrice, null);
  assert.equal(row.limitOnClose?.status, 'expired');
  assert.ok(row.limitOnClose?.closeEvidenceId);
  assert.deepEqual(await krwWallet(s), before);
  assert.equal(await ledger(s), 0);
  assert.equal((await cycle()).candidates, 0);
}

/** At the deadline (the DB instant observed just before the fill; the clock
 * only moves on) and after it, valid final close evidence never fills. */
async function fillAtOrAfterDeadline() {
  for (const late of ['at', 'after'] as const)
    await locScenario('general', async (s) => {
      const before = await krwWallet(s);
      const { orderId } = await place(s);
      await untilDb(s.closeAt.getTime());
      const { final } = await finalEvidence(s, '95');
      await fxEvidence();
      if (late === 'at') await setDeadline(orderId, await now());
      else await passDeadline(s, orderId);
      const outcome = await fill.fillLimitOrder({
        orderId,
        plan: locPlan(final!),
      });
      assert.equal(outcomeOf(outcome), 'limit_on_close_deadline_passed');
      await assertNotFilled(s, orderId, before);
      await assertExpiredOnce(s, orderId, before);
      pass(
        `fill ${late} the deadline refused despite final close evidence; expiry releases once`,
      );
    });
}

/** A fill that failed before the deadline is never retried into a fill after
 * it, even once its cause has cleared. */
async function retryAfterDeadline() {
  await locScenario('general', async (s) => {
    const before = await krwWallet(s);
    await db.assetPriceSnapshot.deleteMany({ where: { assetId: s.assetId } });
    const { orderId } = await place(s);
    await untilDb(s.closeAt.getTime());
    const { final } = await finalEvidence(s, '95');
    const summary = await cycle(); // no valuation price: the fill rolls back
    assert.equal(summary.errors.LOC_FILL_FAILED, 1, JSON.stringify(summary));
    await assertNotFilled(s, orderId, before);
    await realtime(s, '95', new Date(s.closeAt.getTime() - 1000));
    await passDeadline(s, orderId);
    await fxEvidence();
    const retried = await fill.fillLimitOrder({
      orderId,
      plan: locPlan(final!),
    });
    assert.equal(outcomeOf(retried), 'limit_on_close_deadline_passed');
    await assertNotFilled(s, orderId, before);
    await assertExpiredOnce(s, orderId, before);
    pass(
      'a fill failing before the deadline is never retried into a fill after it',
    );
  });
}

/** Started before the deadline, then waiting for a lock past it: refused at
 * the post-lock DB clock — on the Order row before any write, and on the
 * wallet row during the writes (the whole fill rolls back). */
async function lockWaitPastDeadline() {
  for (const lock of ['order', 'wallet'] as const)
    await locScenario('general', async (s) => {
      const before = await krwWallet(s);
      const { orderId } = await place(s);
      await untilDb(s.closeAt.getTime());
      const { final } = await finalEvidence(s, '95');
      const walletId = await krwWalletId(s);
      await fxEvidence();
      // Short lead and lag keep the waiting fill inside Prisma's 5 s
      // interactive-transaction timeout even across a backward clock step.
      const deadline = await setDeadline(
        orderId,
        new Date((await now()).getTime() + 300),
      );
      const holder = await holdRowLock((tx) =>
        lock === 'order'
          ? tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`
          : tx.$queryRaw`SELECT "id" FROM "cash_wallets" WHERE "id" = ${walletId} FOR UPDATE`,
      );
      const pending = fill.fillLimitOrder({ orderId, plan: locPlan(final!) });
      await untilLockWaiting();
      assert.ok((await now()) < deadline, 'the fill waits before the deadline');
      // Past the deadline by more than this host's backward clock steps.
      await untilDb(deadline.getTime() + 2000);
      await fxEvidence();
      await holder.release();
      assert.equal(outcomeOf(await pending), 'limit_on_close_deadline_passed');
      await assertNotFilled(s, orderId, before);
      await assertExpiredOnce(s, orderId, before);
      pass(`fill waiting on the ${lock} row lock past the deadline is refused`);
    });
}

/** Fill, deadline expiry and user cancel race: one terminal outcome, the
 * reservation settled or released once, never a fill at or after the deadline. */
async function deadlineRaces() {
  for (const offsetMs of [150, 300, -2000])
    await locScenario('general', async (s) => {
      const before = await krwWallet(s);
      const { orderId } = await place(s);
      await untilDb(s.closeAt.getTime());
      const { final } = await finalEvidence(s, '97');
      await fxEvidence();
      const deadline =
        offsetMs < 0
          ? await passDeadline(s, orderId)
          : await setDeadline(
              orderId,
              new Date((await now()).getTime() + offsetMs),
            );
      await Promise.allSettled([
        fill.fillLimitOrder({ orderId, plan: locPlan(final!) }),
        untilDb(deadline.getTime()).then(() => settlement.runCycle({ config })),
        orders.cancelOrderForTradingAccount(s.userId, s.accountId, orderId),
      ]);
      const row = await order(orderId);
      const after = await krwWallet(s);
      assert.equal(after.reserved, '0.00000000');
      if (row.status === 'executed') {
        assert.ok(offsetMs > 0, 'no fill once the deadline has passed');
        assert.ok(row.executedAt! < row.limitOnClose!.evidenceDeadlineAt);
        assert.equal(row.limitOnClose?.status, 'filled');
        assert.equal(await ledger(s), 1);
      } else {
        assert.equal(row.status, 'canceled');
        assert.ok(['canceled', 'expired'].includes(row.limitOnClose!.status));
        assert.deepEqual(after, before);
        assert.equal(await ledger(s), 0);
      }
      await cycle();
      const settled = await order(orderId);
      assert.equal(settled.status, row.status);
      assert.equal(settled.limitOnClose?.status, row.limitOnClose?.status);
      assert.deepEqual(await krwWallet(s), after);
    });
  pass(
    'fill vs deadline expiry vs user cancel → one terminal outcome (3 rounds)',
  );
}

/** A fill completed before the deadline stays: after it, re-reads, settlement,
 * the fill itself and the create replay change nothing. */
async function filledThenDeadline() {
  await locScenario('general', async (s) => {
    const key = randomUUID();
    const { quote, orderId } = await place(s, {}, key);
    await untilDb(s.closeAt.getTime());
    const { final } = await finalEvidence(s, '96');
    assert.equal((await cycle()).filled, 1);
    const filled = await order(orderId);
    const wallet = await krwWallet(s);
    await passDeadline(s, orderId);
    assert.equal((await cycle()).candidates, 0);
    const again = await fill.fillLimitOrder({ orderId, plan: locPlan(final!) });
    assert.equal(outcomeOf(again), 'not_submitted_limit');
    const replay = await orders.createOrderForTradingAccount(
      s.userId,
      s.accountId,
      { ...locBody(s), quoteId: quote.data.quoteId, idempotencyKey: key },
    );
    assert.equal(replay.data.order.orderId, orderId);
    const detail = await orders.getOrderForTradingAccount(
      s.userId,
      s.accountId,
      orderId,
    );
    assert.equal(detail.data.order.status, 'executed');
    assert.equal(detail.data.order.limitOnClose?.status, 'filled');
    const row = await order(orderId);
    assert.equal(row.executedAt?.getTime(), filled.executedAt?.getTime());
    assert.equal(row.executedPrice?.toFixed(8), '96.00000000');
    assert.deepEqual(await krwWallet(s), wallet);
    assert.equal(await ledger(s), 1);
    assert.equal(
      await db.order.count({ where: { tradingAccountId: s.accountId } }),
      1,
    );
    pass(
      'a fill before the deadline is kept: re-read, settlement, fill and create replay after it change nothing',
    );
  });
}

async function main() {
  await db.$connect();
  try {
    for (const mode of ['general', 'season'] as const) {
      await fillAtClose(mode, '95');
      await fillAtClose(mode, '100');
      await closeAboveLimit(mode);
    }
    await evidenceUnavailable();
    await unstableEvidence();
    await valuationGap();
    await cancelBeforeClose();
    await cancelVersusSettlement();
    await duplicateWorkers();
    await lifecycleRaces();
    await registrationRules();
    await ordinaryLimitUnaffected();
    await databaseConstraints();
    await fillAtOrAfterDeadline();
    await retryAfterDeadline();
    await lockWaitPastDeadline();
    await deadlineRaces();
    await filledThenDeadline();
    console.log(`Limit-on-Close PostgreSQL PASS (${checks} scenarios)`);
  } finally {
    await db.fxRateSnapshot.deleteMany({
      where: { id: { in: fxEvidenceIds } },
    });
    await db.$disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
