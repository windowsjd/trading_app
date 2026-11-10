// Calendar fixture first: it must replace the session lookups before any
// product module loads them (test/support/trading-session-fixture.ts).
import { tradingSessions } from '../test/support/trading-session-fixture';
/**
 * PostgreSQL integration for US pre-market/after-hours limit fills
 * (2026-11-10). Real database, real transactions, the real matcher and fill
 * service: money, reservations, ledger, evidence links and equity snapshots
 * are asserted against committed rows. Opt-in via
 * US_EXTENDED_HOURS_DB_INTEGRATION=1.
 *
 * New York wall time cannot be faked here (every fill reads PostgreSQL's
 * clock_timestamp()), so each scenario places the US regular session around
 * the real instant with the calendar fixture: a session that opens in an hour
 * (now = pre-market of its date), one that closed 30 s ago (now =
 * after-hours), one that is open, and yesterday's (now = overnight). The
 * extended windows themselves are the production ones derived from that
 * session (04:00 New York → open, close → 20:00 New York).
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  SeasonStatus,
  WalletTransactionType,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { RankingRefreshService } from '../src/ranking/ranking-refresh.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { OrdersService } from '../src/orders/orders.service';
import { LimitOrderCandidateRepository } from '../src/orders/limit-order-candidate.repository';
import { reserveAvailablePositionQuantity } from '../src/orders/position-reservation-atomic';
import { LimitOrderCandleEvidenceService } from '../src/orders/limit-order-candle-evidence.service';
import { LimitOrderExecutionService } from '../src/orders/limit-order-execution.service';
import { LimitOrderMatchingService } from '../src/orders/limit-order-matching.service';
import type { UsdKrwRefreshService } from '../src/providers/usd-krw-refresh.service';
import { zeroCryptoCashWalletData } from '../src/wallets/canonical-cash-wallets';

const RUN = process.env.US_EXTENDED_HOURS_DB_INTEGRATION;
if (RUN !== '1') {
  console.log(
    'us extended hours integration skipped (set US_EXTENDED_HOURS_DB_INTEGRATION=1)',
  );
  process.exit(0);
}

// The switches under test (startup validation would refuse other combos).
process.env.US_STOCK_PRICE_PROVIDER = 'tiingo';
process.env.US_STOCK_EXTENDED_HOURS_PRICE_ENABLED = 'true';
process.env.US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED = 'true';

const PREFIX = `us-ext-${process.pid}-${Date.now()}`;
const EXTENDED = 'tiingo_us_extended_reference_price';
const REGULAR = 'tiingo_us_reference_price';
const ZERO = '0.00000000';
const FEE_RATE = '0.001000';
const START_BALANCE = '10000.00000000';
const HOUR = 3_600_000;

const prisma = new PrismaService();
const reservation = new OrderReservationService();
const createService = new LimitOrderCreateService(prisma, reservation);
const cancelService = new LimitOrderCancelService(prisma, reservation);
const portfolioValuation = new PortfolioValuationService(prisma);
const ranking = new RankingRefreshService(prisma, portfolioValuation);
const orders = new OrdersService(prisma, ranking, createService, cancelService);
const candidateRepo = new LimitOrderCandidateRepository(prisma);
const candleEvidence = new LimitOrderCandleEvidenceService(prisma);
const execution = new LimitOrderExecutionService(
  prisma,
  candleEvidence,
  orders,
);

/** A stand-in for UsdKrwRefreshService (its providers are external). */
type FxStub = {
  calls: number;
  mode: 'fresh_in_db' | 'unavailable' | 'insert';
};
function matcherWith(fx: FxStub = { calls: 0, mode: 'fresh_in_db' }) {
  const refresh = {
    prepare: async () => {
      fx.calls += 1;
      if (fx.mode === 'unavailable')
        return { attempted: true, result: 'unavailable', source: null };
      if (fx.mode === 'insert') {
        await createFx(new Date());
        return { attempted: true, result: 'refreshed', source: 'korea_exim' };
      }
      return { attempted: false, result: 'already_fresh', source: 'x' };
    },
  } as unknown as UsdKrwRefreshService;
  // Ranking refresh is fire-and-forget after commit; omitted so it cannot
  // race the cleanup (the money commits inside the fill transaction).
  return new LimitOrderMatchingService(
    prisma,
    candidateRepo,
    candleEvidence,
    execution,
    undefined,
    refresh,
  );
}

const createdUserIds: string[] = [];
const createdSeasonIds: string[] = [];
const createdAssetIds: string[] = [];
const createdFxSnapshotIds: string[] = [];

async function main(): Promise<void> {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be configured.');
  await prisma.$connect();
  try {
    // Global USD/KRW: no provider row may be execution-fresh before the FX
    // scenario (another suite's row in a shared database ages out first).
    await waitUntilNoExecutionFreshFx();
    await run(
      'missing fill-time USD/KRW defers the fill with the reservation kept; one bounded preparation per cycle lets it fill',
      testFxPreparation,
    );
    await run(
      'pre-market BUY fills at the extended price with exact money, ledger, evidence and equity snapshot',
      testPreMarketBuy,
    );
    await run(
      'after-hours SELL of a regular-session order fills and books realized PnL',
      testAfterHoursSell,
    );
    await run(
      'an order registered inside after-hours fills only on a later tick',
      testRegisteredInsideWindow,
    );
    await run(
      'pre-submission, stale, regular-source and earlier-window evidence never fills',
      testRejectedEvidence,
    );
    await run(
      'regular open, overnight and the switch off never accept extended evidence',
      testSessionBoundaries,
    );
    await run(
      'cancel racing a fill: exactly one wins, reservation and ledger consistent',
      testCancelRace,
    );
    await run(
      'ended or suspended season and suspended account never fill',
      testLifecycleBlocks,
    );
    await run('repeated cycles never fill an order twice', testRepeatedCycles);
    console.log('us extended hours integration ok');
  } finally {
    tradingSessions.reset();
    await cleanup().catch((error: unknown) =>
      console.error('cleanup failed', error),
    );
    await prisma.$disconnect();
  }
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } finally {
    tradingSessions.reset();
  }
  console.log(`ok ${name}`);
}

// ── Sessions around the real instant ───────────────────────────────────────

function newYorkDate(at: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
/** `now` is in the pre-market: 04:00 New York of the date ≤ now < open. */
function preMarket(now: Date) {
  tradingSessions.set(now, new Date(now.getTime() + 2 * HOUR), ['US'], {
    localDate: newYorkDate(new Date(now.getTime() - 4 * HOUR)),
    openAt: new Date(now.getTime() + HOUR),
  });
}
/** `now` is in the after-hours: close (30 s ago) ≤ now < 20:00 New York. */
function afterHours(now: Date) {
  tradingSessions.set(now, new Date(now.getTime() - 30_000), ['US'], {
    localDate: newYorkDate(new Date(now.getTime() + 4 * HOUR)),
    openAt: new Date(now.getTime() - 2 * HOUR),
  });
}
function regularOpen(now: Date) {
  tradingSessions.set(now, new Date(now.getTime() + HOUR), ['US'], {
    localDate: newYorkDate(now),
    openAt: new Date(now.getTime() - HOUR),
  });
}
/** Yesterday's session: its after-hours ended long ago. */
function overnight(now: Date) {
  tradingSessions.set(now, new Date(now.getTime() - 30_000), ['US'], {
    localDate: newYorkDate(new Date(now.getTime() - 24 * HOUR)),
    openAt: new Date(now.getTime() - 2 * HOUR),
  });
}

// ── Scenarios ───────────────────────────────────────────────────────────────

async function testFxPreparation(): Promise<void> {
  const s = await createScenario('fx');
  preMarket(s.now);
  // Display-fresh (5 min), but too old for a fill (60 s).
  await createFx(new Date(s.now.getTime() - 5 * 60_000));
  const order = await createBuy(s, { limitPrice: '100', reserved: '200.20' });
  await createSnapshot(s, '99.50000000', ago(2_000));

  const fx: FxStub = { calls: 0, mode: 'unavailable' };
  const matcher = matcherWith(fx);
  const first = await matcher.matchDueLimitOrders({ now: new Date() });
  assert.equal(first.filledPathA, 0);
  assert.equal(fx.calls, 1, 'one preparation before the first US fill');
  assert.deepEqual(first.diagnostics.execution.fxPreparation, {
    unavailable: 1,
  });
  assert.equal(
    first.diagnostics.execution.skipReasons.fx_evidence_unavailable,
    1,
  );
  assert.equal((await readOrder(order.id)).status, OrderStatus.submitted);
  assert.deepEqual(await readWallet(s), {
    balance: START_BALANCE,
    reserved: '200.20000000',
  });

  // The next cycle inside the retry window never asks the providers again.
  const second = await matcher.matchDueLimitOrders({ now: new Date() });
  assert.equal(second.filledPathA, 0);
  assert.equal(fx.calls, 1);
  assert.deepEqual(second.diagnostics.execution.fxPreparation, {
    cooling_down: 1,
  });

  // A later run whose preparation commits a fresh rate fills at once.
  await createSnapshot(s, '99.40000000', ago(1_000));
  const refreshed: FxStub = { calls: 0, mode: 'insert' };
  const third = await matcherWith(refreshed).matchDueLimitOrders({
    now: new Date(),
  });
  assert.equal(third.filledPathA, 1);
  assert.equal(refreshed.calls, 1);
  const filled = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    select: { status: true, executedPrice: true, fxRateSnapshotId: true },
  });
  assert.equal(filled.status, OrderStatus.executed);
  assert.equal(filled.executedPrice?.toFixed(8), '99.40000000');
  assert.equal(
    filled.fxRateSnapshotId,
    createdFxSnapshotIds[createdFxSnapshotIds.length - 1],
    'the fill pins the evidence it selected at its own clock',
  );
}

async function testPreMarketBuy(): Promise<void> {
  const s = await createScenario('pre-buy');
  preMarket(s.now);
  await createFx(s.now);
  const order = await createBuy(s, { limitPrice: '100', reserved: '200.20' });
  const tick = await createSnapshot(s, '99.50000000', ago(2_000));

  const summary = await matcherWith().matchDueLimitOrders({ now: new Date() });
  assert.equal(summary.filledPathA, 1);
  const filled = await readOrder(order.id);
  assert.equal(filled.status, OrderStatus.executed);
  assert.equal(filled.executedPrice, '99.50000000');
  assert.equal(filled.assetPriceSnapshotId, tick.id);
  // 2 × 99.5 = 199, fee 0.199 → net 199.199 (pinned 0.1 % reservation rate).
  assert.equal(filled.grossAmount, '199.00000000');
  assert.equal(filled.feeAmount, '0.19900000');
  assert.equal(filled.netAmount, '199.19900000');
  assert.ok(filled.fxRateSnapshotId);
  assert.ok(filled.reservationReleasedAt);
  assert.deepEqual(await readWallet(s), {
    balance: '9800.80100000',
    reserved: ZERO,
  });
  assert.deepEqual(await readPosition(s), {
    quantity: '2.00000000',
    reserved: ZERO,
    averageCost: '99.59950000',
  });
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: order.id, txType: WalletTransactionType.order_buy },
    }),
    1,
  );
  // The fill-time equity snapshot values the new holding at the same
  // extended-hours price (live valuation) and commits with the fill.
  assert.equal(
    await prisma.equitySnapshot.count({
      where: { tradingAccountId: s.tradingAccountId },
    }),
    1,
  );
}

async function testAfterHoursSell(): Promise<void> {
  const s = await createScenario('after-sell', { holding: '3' });
  afterHours(s.now);
  await createFx(s.now);
  // Registered during the regular session, still pending after the close.
  const order = await createSell(s, {
    limitPrice: '120',
    quantity: '2',
    submittedAt: new Date(s.now.getTime() - HOUR),
  });
  // The last regular-session tick (before the close) crossed too, but a
  // regular-source row is never after-hours evidence.
  await createSnapshot(s, '121.00000000', ago(31_000), REGULAR);
  const tick = await createSnapshot(s, '120.50000000', ago(2_000));

  const summary = await matcherWith().matchDueLimitOrders({ now: new Date() });
  assert.equal(summary.filledPathA, 1);
  const filled = await readOrder(order.id);
  assert.equal(filled.status, OrderStatus.executed);
  assert.equal(filled.executedPrice, '120.50000000');
  assert.equal(filled.assetPriceSnapshotId, tick.id);
  // 2 × 120.5 = 241, fee 0.241 → net 240.759; cost 2 × 90 = 180.
  assert.equal(filled.netAmount, '240.75900000');
  assert.equal(filled.realizedPnl, '60.75900000');
  assert.deepEqual(await readWallet(s), {
    balance: '10240.75900000',
    reserved: ZERO,
  });
  assert.deepEqual(await readPosition(s), {
    quantity: '1.00000000',
    reserved: ZERO,
    averageCost: '90.00000000',
  });
}

async function testRegisteredInsideWindow(): Promise<void> {
  const s = await createScenario('inside-window');
  afterHours(s.now);
  await createFx(s.now);
  await createSnapshot(s, '95.00000000', ago(3_000));
  // Registered inside after-hours (limit registration of a closed market).
  const order = await createBuy(s, {
    limitPrice: '100',
    reserved: '200.20',
    submittedAt: ago(1_500),
  });
  const first = await matcherWith().matchDueLimitOrders({ now: new Date() });
  assert.equal(first.filledPathA, 0, 'a tick before submission never fills');
  assert.equal(first.diagnostics.planning.pathA.before_submission, 1);
  const after = await createSnapshot(s, '96.00000000', ago(500));
  const second = await matcherWith().matchDueLimitOrders({ now: new Date() });
  assert.equal(second.filledPathA, 1);
  assert.equal((await readOrder(order.id)).assetPriceSnapshotId, after.id);
}

async function testRejectedEvidence(): Promise<void> {
  const cases: Array<{
    label: string;
    window: (now: Date) => void;
    evidence: (s: Scenario) => Promise<unknown>;
  }> = [
    {
      label: 'stale (received 11.9 s ago)',
      window: preMarket,
      evidence: (s) => createSnapshot(s, '99.00000000', ago(12_000)),
    },
    {
      label: 'regular source',
      window: preMarket,
      evidence: (s) => createSnapshot(s, '99.00000000', ago(1_000), REGULAR),
    },
    {
      label: 'before the window',
      window: afterHours,
      // Tiingo time 40 s ago — before the after-hours window began (close =
      // 30 s ago) — though received just now: a regular-session tick.
      evidence: (s) =>
        createSnapshot(s, '99.00000000', ago(40_000), EXTENDED, ago(500)),
    },
    {
      label: 'above a BUY limit',
      window: preMarket,
      evidence: (s) => createSnapshot(s, '100.01000000', ago(1_000)),
    },
  ];
  for (const item of cases) {
    const s = await createScenario(`reject-${item.label}`);
    item.window(s.now);
    await createFx(s.now);
    const order = await createBuy(s, {
      limitPrice: '100',
      reserved: '200.20',
      submittedAt: new Date(s.now.getTime() - 5 * 60_000),
    });
    await item.evidence(s);
    const summary = await matcherWith().matchDueLimitOrders({
      now: new Date(),
    });
    assert.equal(summary.filledPathA, 0, item.label);
    assert.equal((await readOrder(order.id)).status, OrderStatus.submitted);
    assert.deepEqual(await readWallet(s), {
      balance: START_BALANCE,
      reserved: '200.20000000',
    });
    await retire(s, order.id);
    tradingSessions.reset();
  }
}

async function testSessionBoundaries(): Promise<void> {
  // A fresh extended row is offered to the fill service directly in each
  // state; only an extended window with the switch on may accept it.
  const attempt = async (
    label: string,
    window: (now: Date) => void,
    expected: string,
  ) => {
    const s = await createScenario(`boundary-${label}`);
    window(s.now);
    await createFx(s.now);
    const order = await createBuy(s, {
      limitPrice: '100',
      reserved: '200.20',
      submittedAt: new Date(s.now.getTime() - 60_000),
    });
    const tick = await createSnapshot(s, '99.00000000', ago(1_000));
    const outcome = await execution.fillLimitOrder({
      orderId: order.id,
      plan: {
        path: 'snapshot',
        executedPrice: tick.price,
        assetPriceSnapshotId: tick.id,
      },
    });
    assert.equal(
      outcome.state === 'skipped' ? outcome.reason : outcome.state,
      expected,
      label,
    );
    if (expected !== 'filled') {
      assert.equal((await readOrder(order.id)).status, OrderStatus.submitted);
      assert.equal((await readWallet(s)).reserved, '200.20000000');
      await retire(s, order.id);
    }
    tradingSessions.reset();
  };
  // At the regular open the last pre-market price is no longer evidence.
  await attempt('regular', regularOpen, 'price_evidence_unavailable');
  await attempt('overnight', overnight, 'market_not_open');
  process.env.US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED = 'false';
  try {
    await attempt('switch-off', preMarket, 'market_not_open');
    const s = await createScenario('switch-off-matcher');
    preMarket(s.now);
    await createFx(s.now);
    const order = await createBuy(s, { limitPrice: '100', reserved: '200.20' });
    await createSnapshot(s, '99.00000000', ago(1_000));
    const summary = await matcherWith().matchDueLimitOrders({
      now: new Date(),
    });
    assert.equal(summary.filledPathA, 0);
    assert.equal(
      summary.diagnostics.planning.snapshotSelections.market_closed,
      1,
    );
    assert.equal((await readOrder(order.id)).status, OrderStatus.submitted);
    await retire(s, order.id);
  } finally {
    process.env.US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED = 'true';
  }
  await attempt('pre-market', preMarket, 'filled');
}

async function testCancelRace(): Promise<void> {
  const s = await createScenario('race');
  afterHours(s.now);
  await createFx(s.now);
  const order = await createBuy(s, {
    limitPrice: '100',
    reserved: '200.20',
    submittedAt: new Date(s.now.getTime() - 60_000),
  });
  const tick = await createSnapshot(s, '99.00000000', ago(1_000));
  const [fill, cancel] = await Promise.allSettled([
    execution.fillLimitOrder({
      orderId: order.id,
      plan: {
        path: 'snapshot',
        executedPrice: tick.price,
        assetPriceSnapshotId: tick.id,
      },
    }),
    cancelService.cancelOwnedLimitBuyOrder({
      userId: s.userId,
      orderId: order.id,
      canceledAt: new Date(),
    }),
  ]);
  const final = await readOrder(order.id);
  const wallet = await readWallet(s);
  const ledger = await prisma.walletTransaction.count({
    where: { referenceId: order.id, txType: WalletTransactionType.order_buy },
  });
  assert.equal(wallet.reserved, ZERO, 'the reservation is released once');
  if (final.status === OrderStatus.executed) {
    assert.equal(fill.status, 'fulfilled');
    assert.equal(cancel.status, 'rejected', 'cancel lost to the fill');
    assert.equal(ledger, 1);
    // 2 × 99 = 198, fee 0.198 → net 198.198.
    assert.equal(wallet.balance, '9801.80200000');
  } else {
    assert.equal(final.status, OrderStatus.canceled);
    assert.equal(cancel.status, 'fulfilled');
    assert.ok(
      fill.status === 'fulfilled' && fill.value.state === 'skipped',
      'fill lost to the cancel',
    );
    assert.equal(ledger, 0);
    assert.equal(wallet.balance, START_BALANCE);
  }
}

async function testLifecycleBlocks(): Promise<void> {
  const blocked = async (
    label: string,
    change: (s: Scenario) => Promise<unknown>,
    expected: string,
  ) => {
    const s = await createScenario(`lifecycle-${label}`);
    preMarket(s.now);
    await createFx(s.now);
    const order = await createBuy(s, {
      limitPrice: '100',
      reserved: '200.20',
      submittedAt: new Date(s.now.getTime() - 60_000),
    });
    const tick = await createSnapshot(s, '99.00000000', ago(1_000));
    await change(s);
    let result: string;
    try {
      const outcome = await execution.fillLimitOrder({
        orderId: order.id,
        plan: {
          path: 'snapshot',
          executedPrice: tick.price,
          assetPriceSnapshotId: tick.id,
        },
      });
      result = outcome.state === 'skipped' ? outcome.reason : outcome.state;
    } catch (error) {
      // A refused authorization lock rolls the whole fill back.
      const code = (error as { response?: { error?: { code?: string } } })
        .response?.error?.code;
      result = `refused:${code ?? 'unknown'}`;
    }
    assert.equal(result, expected, label);
    assert.equal((await readOrder(order.id)).status, OrderStatus.submitted);
    assert.equal((await readWallet(s)).reserved, '200.20000000');
    assert.equal(
      await prisma.walletTransaction.count({
        where: { referenceId: order.id },
      }),
      0,
    );
    tradingSessions.reset();
  };
  await blocked(
    'ended',
    (s) =>
      prisma.season.update({
        where: { id: s.seasonId },
        data: { endAt: new Date(Date.now() - 1_000) },
      }),
    'season_not_active',
  );
  // The season authorization lock itself refuses a suspended season.
  await blocked(
    'suspended',
    (s) =>
      prisma.season.update({
        where: { id: s.seasonId },
        data: { suspendedAt: new Date() },
      }),
    'refused:SEASON_NOT_ACTIVE',
  );
  await blocked(
    'account',
    (s) =>
      prisma.tradingAccount.update({
        where: { id: s.tradingAccountId },
        data: { status: 'suspended' },
      }),
    'account_not_active',
  );
}

async function testRepeatedCycles(): Promise<void> {
  const s = await createScenario('repeat');
  afterHours(s.now);
  await createFx(s.now);
  const order = await createBuy(s, {
    limitPrice: '100',
    reserved: '200.20',
    submittedAt: new Date(s.now.getTime() - 60_000),
  });
  await createSnapshot(s, '99.00000000', ago(1_000));
  const matcher = matcherWith();
  const first = await matcher.matchDueLimitOrders({ now: new Date() });
  const second = await matcher.matchDueLimitOrders({ now: new Date() });
  assert.equal(first.filledPathA + second.filledPathA, 1);
  assert.equal(
    await prisma.walletTransaction.count({
      where: { referenceId: order.id, txType: WalletTransactionType.order_buy },
    }),
    1,
  );
  assert.deepEqual(await readWallet(s), {
    balance: '9801.80200000',
    reserved: ZERO,
  });
}

// ── Fixture ─────────────────────────────────────────────────────────────────

type Scenario = {
  userId: string;
  seasonId: string;
  tradingAccountId: string;
  walletId: string;
  assetId: string;
  now: Date;
};

const ago = (ms: number) => new Date(Date.now() - ms);

/**
 * The matcher scans every fillable order in the database, and each scenario
 * re-places the (global) session window: an order a scenario left pending
 * could fill in a later one. Cancel it through the real cancel path (which
 * releases its reservation) once its scenario has asserted.
 */
async function retire(s: Scenario, orderId: string): Promise<void> {
  await cancelService.cancelOwnedLimitBuyOrder({
    userId: s.userId,
    orderId,
    canceledAt: new Date(),
  });
  assert.equal((await readOrder(orderId)).status, OrderStatus.canceled);
  assert.equal((await readWallet(s)).reserved, ZERO);
}

async function createScenario(
  label: string,
  options: { holding?: string } = {},
): Promise<Scenario> {
  const suffix = `${label}-${randomUUID()}`;
  const now = new Date();
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${suffix}@example.com`.replace(/\s+/gu, '-'),
      passwordHash: 'integration-test-only',
      nickname: `ux-${randomUUID()}`.slice(0, 40),
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  const season = await prisma.season.create({
    data: {
      name: `${PREFIX}-${suffix}`,
      status: SeasonStatus.active,
      startAt: new Date(now.getTime() - HOUR),
      endAt: new Date(now.getTime() + 24 * HOUR),
      initialCapitalKrw: '13500000.00000000',
      tradeFeeRate: FEE_RATE,
      fxFeeRate: FEE_RATE,
    },
    select: { id: true },
  });
  createdSeasonIds.push(season.id);
  const tradingAccount = await prisma.tradingAccount.create({
    data: {
      userId: user.id,
      mode: 'season',
      initialCapitalKrw: '13500000.00000000',
      openedAt: now,
    },
    select: { id: true },
  });
  await prisma.seasonParticipant.create({
    data: {
      seasonId: season.id,
      userId: user.id,
      joinedAt: now,
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: '13500000.00000000',
      totalAssetKrw: '13500000.00000000',
      totalReturnRate: ZERO,
      maxDrawdown: ZERO,
      tradingAccountId: tradingAccount.id,
    },
  });
  const wallet = await prisma.cashWallet.create({
    data: {
      tradingAccountId: tradingAccount.id,
      currencyCode: CurrencyCode.USD,
      balanceAmount: START_BALANCE,
      reservedAmount: ZERO,
    },
    select: { id: true },
  });
  await prisma.cashWallet.createMany({
    data: [
      {
        tradingAccountId: tradingAccount.id,
        currencyCode: CurrencyCode.KRW,
        balanceAmount: ZERO,
        reservedAmount: ZERO,
      },
      ...zeroCryptoCashWalletData(tradingAccount.id),
    ],
  });
  const asset = await prisma.asset.create({
    data: {
      symbol: `UX${randomUUID().replace(/-/gu, '').slice(0, 12).toUpperCase()}`,
      name: `${PREFIX}-${label}`,
      market: 'NAS',
      assetType: AssetType.us_stock,
      currencyCode: CurrencyCode.USD,
      priceCurrency: CurrencyCode.USD,
      settlementCurrency: CurrencyCode.USD,
      isActive: true,
    },
    select: { id: true },
  });
  createdAssetIds.push(asset.id);
  if (options.holding)
    await prisma.position.create({
      data: {
        tradingAccountId: tradingAccount.id,
        assetId: asset.id,
        quantity: options.holding,
        reservedQuantity: ZERO,
        averageCost: '90.00000000',
        currencyCode: CurrencyCode.USD,
      },
    });
  return {
    userId: user.id,
    seasonId: season.id,
    tradingAccountId: tradingAccount.id,
    walletId: wallet.id,
    assetId: asset.id,
    now,
  };
}

async function createBuy(
  s: Scenario,
  input: { limitPrice: string; reserved: string; submittedAt?: Date },
): Promise<{ id: string }> {
  await reservation.reserveForLimitBuy(prisma, {
    walletScope: 'securities' as const,
    tradingAccountId: s.tradingAccountId,
    currencyCode: CurrencyCode.USD,
    amount: input.reserved,
  });
  return prisma.order.create({
    data: {
      cashWalletScope: 'securities' as const,
      tradingAccountId: s.tradingAccountId,
      assetId: s.assetId,
      side: OrderSide.buy,
      orderType: OrderType.limit,
      status: OrderStatus.submitted,
      quantity: '2.00000000',
      limitPrice: input.limitPrice,
      currencyCode: CurrencyCode.USD,
      reservedAmount: input.reserved,
      reservationFeeRate: FEE_RATE,
      submittedAt: input.submittedAt ?? new Date(s.now.getTime() - 60_000),
    },
    select: { id: true },
  });
}

async function createSell(
  s: Scenario,
  input: { limitPrice: string; quantity: string; submittedAt: Date },
): Promise<{ id: string }> {
  const position = await prisma.position.findUniqueOrThrow({
    where: {
      tradingAccountId_assetId: {
        tradingAccountId: s.tradingAccountId,
        assetId: s.assetId,
      },
    },
    select: { id: true },
  });
  assert.equal(
    await reserveAvailablePositionQuantity(prisma, {
      positionId: position.id,
      tradingAccountId: s.tradingAccountId,
      assetId: s.assetId,
      quantity: input.quantity,
    }),
    1,
  );
  return prisma.order.create({
    data: {
      cashWalletScope: 'securities' as const,
      tradingAccountId: s.tradingAccountId,
      assetId: s.assetId,
      side: OrderSide.sell,
      orderType: OrderType.limit,
      status: OrderStatus.submitted,
      quantity: input.quantity,
      limitPrice: input.limitPrice,
      currencyCode: CurrencyCode.USD,
      reservedQuantity: input.quantity,
      reservationFeeRate: FEE_RATE,
      submittedAt: input.submittedAt,
    },
    select: { id: true },
  });
}

/** A collector row: Tiingo time = effectiveAt, receipt = capturedAt. */
async function createSnapshot(
  s: Scenario,
  price: string,
  effectiveAt: Date,
  sourceName = EXTENDED,
  capturedAt = new Date(effectiveAt.getTime() + 100),
) {
  return prisma.assetPriceSnapshot.create({
    data: {
      assetId: s.assetId,
      price,
      currencyCode: CurrencyCode.USD,
      sourceType: AssetPriceSourceType.provider_api,
      sourceName,
      effectiveAt,
      capturedAt,
    },
    select: { id: true, price: true },
  });
}

async function createFx(capturedAt: Date): Promise<void> {
  const row = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      rate: '1400.00000000',
      sourceType: FxRateSourceType.provider_api,
      sourceName: 'korea_exim_exchange_rate',
      effectiveAt: capturedAt,
      capturedAt,
    },
    select: { id: true },
  });
  createdFxSnapshotIds.push(row.id);
}

async function waitUntilNoExecutionFreshFx(): Promise<void> {
  const newest = await prisma.fxRateSnapshot.findFirst({
    where: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      sourceType: FxRateSourceType.provider_api,
    },
    orderBy: { capturedAt: 'desc' },
    select: { capturedAt: true },
  });
  if (!newest) return;
  const waitMs = newest.capturedAt.getTime() + 62_000 - Date.now();
  if (waitMs <= 0) return;
  assert.ok(waitMs <= 62_000, 'a future-dated USD/KRW row blocks this suite');
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function readOrder(id: string) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      executedPrice: true,
      grossAmount: true,
      feeAmount: true,
      netAmount: true,
      realizedPnl: true,
      assetPriceSnapshotId: true,
      fxRateSnapshotId: true,
      reservationReleasedAt: true,
    },
  });
  return {
    status: order.status,
    executedPrice: order.executedPrice?.toFixed(8) ?? null,
    grossAmount: order.grossAmount?.toFixed(8) ?? null,
    feeAmount: order.feeAmount?.toFixed(8) ?? null,
    netAmount: order.netAmount?.toFixed(8) ?? null,
    realizedPnl: order.realizedPnl?.toFixed(8) ?? null,
    assetPriceSnapshotId: order.assetPriceSnapshotId,
    fxRateSnapshotId: order.fxRateSnapshotId,
    reservationReleasedAt: order.reservationReleasedAt,
  };
}

async function readWallet(s: Scenario) {
  const wallet = await prisma.cashWallet.findUniqueOrThrow({
    where: { id: s.walletId },
    select: { balanceAmount: true, reservedAmount: true },
  });
  return {
    balance: wallet.balanceAmount.toFixed(8),
    reserved: wallet.reservedAmount.toFixed(8),
  };
}

async function readPosition(s: Scenario) {
  const position = await prisma.position.findUnique({
    where: {
      tradingAccountId_assetId: {
        tradingAccountId: s.tradingAccountId,
        assetId: s.assetId,
      },
    },
    select: { quantity: true, reservedQuantity: true, averageCost: true },
  });
  return position
    ? {
        quantity: position.quantity.toFixed(8),
        reserved: position.reservedQuantity.toFixed(8),
        averageCost: position.averageCost.toFixed(8),
      }
    : null;
}

async function cleanup(): Promise<void> {
  const tradingAccountIds = (
    await prisma.tradingAccount.findMany({
      where: { userId: { in: createdUserIds } },
      select: { id: true },
    })
  ).map((row) => row.id);
  await prisma.walletTransaction.deleteMany({
    where: { tradingAccountId: { in: tradingAccountIds } },
  });
  await prisma.seasonRanking.deleteMany({
    where: { seasonId: { in: createdSeasonIds } },
  });
  await prisma.equitySnapshot.deleteMany({
    where: { tradingAccountId: { in: tradingAccountIds } },
  });
  await prisma.position.deleteMany({
    where: { tradingAccountId: { in: tradingAccountIds } },
  });
  await prisma.order.deleteMany({
    where: { tradingAccountId: { in: tradingAccountIds } },
  });
  await prisma.limitOrderCandleEvidence.deleteMany({
    where: { assetId: { in: createdAssetIds } },
  });
  await prisma.assetPriceSnapshot.deleteMany({
    where: { assetId: { in: createdAssetIds } },
  });
  await prisma.fxRateSnapshot.deleteMany({
    where: { id: { in: createdFxSnapshotIds } },
  });
  await prisma.cashWallet.deleteMany({
    where: { tradingAccountId: { in: tradingAccountIds } },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { seasonId: { in: createdSeasonIds } },
  });
  await prisma.asset.deleteMany({ where: { id: { in: createdAssetIds } } });
  await prisma.season.deleteMany({ where: { id: { in: createdSeasonIds } } });
  await prisma.tradingAccount.deleteMany({
    where: { userId: { in: createdUserIds } },
  });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
