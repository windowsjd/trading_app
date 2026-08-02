/**
 * PostgreSQL integration for the scheduler-based limit-order matcher (paths
 * A/B). Real database, real transactions — asserts money exactness against
 * committed rows. Opt-in via LIMIT_ORDER_MATCHING_DB_INTEGRATION=1.
 *
 * Uses a crypto (Binance, USD-settled) asset so nothing depends on stock market
 * hours: path A is 24h, and a fresh USD/KRW snapshot supplies the fill-time FX
 * evidence and the equity-snapshot valuation.
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
import { LimitOrderCandleEvidenceService } from '../src/orders/limit-order-candle-evidence.service';
import { LimitOrderExecutionService } from '../src/orders/limit-order-execution.service';
import { LimitOrderMatchingService } from '../src/orders/limit-order-matching.service';

const RUN = process.env.LIMIT_ORDER_MATCHING_DB_INTEGRATION;
if (RUN !== '1') {
  console.log(
    'limit order matching integration skipped (set LIMIT_ORDER_MATCHING_DB_INTEGRATION=1)',
  );
  process.exit(0);
}

const PREFIX = `lo-match-${process.pid}-${Date.now()}`;
const ZERO = '0.00000000';
const FEE_RATE = '0.001000';
const START_BALANCE = '10000.00000000';

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
// Ranking refresh is the fire-and-forget POST-commit step; it is deliberately
// omitted here so it cannot race cleanup by writing season_rankings rows after
// the run. It never affects fill correctness (the money commits in the fill
// transaction), which is what this suite asserts.
const matching = new LimitOrderMatchingService(
  prisma,
  candidateRepo,
  candleEvidence,
  execution,
  undefined,
);
void ranking;

const createdUserIds: string[] = [];
const createdSeasonIds: string[] = [];
const createdAssetIds: string[] = [];
const createdFxSnapshotIds: string[] = [];

async function main(): Promise<void> {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be configured.');
  await prisma.$connect();
  try {
    await run('path A fills at the snapshot price with improvement', testPathAImprovement);
    await run('path A does not fill above the limit', testPathANoFillAboveLimit);
    await run('path B fills at the limit price off a candle touch', testPathBFillAtLimit);
    await run('path B never uses the partial submit candle', testPathBPartialCandleExcluded);
    await run('fill uses the pinned reservation fee rate, not the season rate', testReservationFeeRateUsed);
    await run('a canceled order is skipped by the matcher', testCancelThenMatch);
    await run('an ended season is not filled', testEndedSeasonNotFilled);
    await run('candle evidence never becomes a price snapshot', testEvidenceIsolation);
    console.log('limit order matching integration ok');
  } finally {
    await cleanup().catch((error: unknown) =>
      console.error('cleanup failed', error),
    );
    await prisma.$disconnect();
  }
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  console.log(`ok ${name}`);
}

const FIVE_MIN = 300_000;
/** A 5-minute boundary `minutesAgo` before now (relative to real time). */
function boundary5mAgo(now: Date, minutesAgo: number): Date {
  const floored = Math.floor(now.getTime() / FIVE_MIN) * FIVE_MIN;
  return new Date(floored - minutesAgo * 60_000);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function testPathAImprovement(): Promise<void> {
  const s = await createScenario('a-improve');
  // limit 100, qty 2 → reserve 200.20 (gross 200 + fee 0.2).
  const order = await createSubmittedLimitOrder(s, {
    limitPrice: '100.00000000',
    quantity: '2.000000',
    reservedAmount: '200.20000000',
  });
  const snapshot = await createAssetPriceSnapshot(s, '90.00000000', s.now);
  await createFreshFxSnapshot(s.now);

  const summary = await matching.matchDueLimitOrders({ now: s.now });
  assert.equal(summary.filledPathA, 1, 'exactly one path-A fill');
  assert.equal(summary.filledPathB, 0);

  const filled = await readOrder(order.id);
  assert.equal(filled.status, OrderStatus.executed);
  // Executed at the SNAPSHOT price (90), not the limit (100).
  assert.equal(filled.executedPrice, '90.00000000');
  assert.equal(filled.grossAmount, '180.00000000');
  assert.equal(filled.feeAmount, '0.18000000');
  assert.equal(filled.netAmount, '180.18000000');
  assert.equal(filled.assetPriceSnapshotId, snapshot.id);
  assert.equal(filled.limitOrderCandleEvidenceId, null);
  assert.ok(filled.executedAt);
  assert.ok(filled.reservationReleasedAt);

  const wallet = await readWallet(s);
  // balance -= actual net (180.18); reservation fully released.
  assert.equal(wallet.balance, '9819.82000000');
  assert.equal(wallet.reserved, ZERO);
  // Price-improvement difference (200.20 - 180.18 = 20.02) is available again.
  assert.equal(available(wallet), '9819.82000000');

  const position = await readPosition(s);
  assert.equal(position?.quantity, '2.00000000');
  assert.equal(position?.averageCost, '90.09000000');

  const txCount = await prisma.walletTransaction.count({
    where: { referenceId: order.id, txType: WalletTransactionType.order_buy },
  });
  assert.equal(txCount, 1, 'exactly one order_buy ledger row');
}

async function testPathANoFillAboveLimit(): Promise<void> {
  const s = await createScenario('a-above');
  const order = await createSubmittedLimitOrder(s, {
    limitPrice: '100.00000000',
    quantity: '1.000000',
    reservedAmount: '100.10000000',
  });
  await createAssetPriceSnapshot(s, '101.00000000', s.now);
  await createFreshFxSnapshot(s.now);

  const summary = await matching.matchDueLimitOrders({ now: s.now });
  assert.equal(summary.filledPathA, 0);
  assert.equal(summary.filledPathB, 0);

  const still = await readOrder(order.id);
  assert.equal(still.status, OrderStatus.submitted);
  const wallet = await readWallet(s);
  assert.equal(wallet.balance, START_BALANCE);
  assert.equal(wallet.reserved, '100.10000000');
}

async function testPathBFillAtLimit(): Promise<void> {
  const s = await createScenario('b-fill');
  // Submitted on a 5m boundary 10m ago; the candle that OPENED at that boundary
  // is therefore eligible (window opened at/after submission).
  const submittedAt = boundary5mAgo(s.now, 10);
  const order = await createSubmittedLimitOrder(s, {
    limitPrice: '100.00000000',
    quantity: '2.000000',
    reservedAmount: '200.20000000',
    submittedAt,
  });
  // Fresh snapshot ABOVE the limit → path A won't fill, but it is valid for
  // the equity-snapshot valuation.
  await createAssetPriceSnapshot(s, '101.00000000', s.now);
  await createFreshFxSnapshot(s.now);
  // Closed 5m candle whose window opened at the submit boundary and whose low
  // reached the limit; it closed ~5m ago (within the 15m lookback).
  await createClosedCandle(s, { openTime: submittedAt, low: '90.00000000' });

  const summary = await matching.matchDueLimitOrders({ now: s.now });
  assert.equal(summary.filledPathB, 1, 'exactly one path-B fill');
  assert.equal(summary.filledPathA, 0);

  const filled = await readOrder(order.id);
  assert.equal(filled.status, OrderStatus.executed);
  // Executed at the LIMIT price (100), NOT the candle low (90).
  assert.equal(filled.executedPrice, '100.00000000');
  assert.equal(filled.netAmount, '200.20000000');
  assert.equal(filled.assetPriceSnapshotId, null);
  assert.ok(filled.limitOrderCandleEvidenceId);

  const evidence = await prisma.limitOrderCandleEvidence.findUniqueOrThrow({
    where: { id: filled.limitOrderCandleEvidenceId! },
    select: {
      triggerLowPrice: true,
      executionPricePolicy: true,
      interval: true,
    },
  });
  assert.equal(evidence.triggerLowPrice.toFixed(8), '90.00000000');
  assert.equal(evidence.executionPricePolicy, 'limit_price');
  assert.equal(evidence.interval, '5m');

  const wallet = await readWallet(s);
  // Whole reservation debited at the limit price (no improvement here).
  assert.equal(wallet.balance, '9799.80000000');
  assert.equal(wallet.reserved, ZERO);
}

async function testPathBPartialCandleExcluded(): Promise<void> {
  const s = await createScenario('b-partial');
  const windowOpen = boundary5mAgo(s.now, 10);
  const order = await createSubmittedLimitOrder(s, {
    limitPrice: '100.00000000',
    quantity: '1.000000',
    reservedAmount: '100.10000000',
    // Submitted 0.5s into the window → that candle was already running.
    submittedAt: new Date(windowOpen.getTime() + 500),
  });
  await createAssetPriceSnapshot(s, '101.00000000', s.now);
  await createFreshFxSnapshot(s.now);
  // The only closed candle is the partial one the order was submitted into.
  await createClosedCandle(s, { openTime: windowOpen, low: '90.00000000' });

  const summary = await matching.matchDueLimitOrders({ now: s.now });
  assert.equal(summary.filledPathB, 0, 'partial submit candle must not fill');

  const still = await readOrder(order.id);
  assert.equal(still.status, OrderStatus.submitted);
}

async function testReservationFeeRateUsed(): Promise<void> {
  const s = await createScenario('fee-rate', { seasonFeeRate: '0.005000' });
  // Order pinned at 0.1% even though the season now charges 0.5%.
  const order = await createSubmittedLimitOrder(s, {
    limitPrice: '100.00000000',
    quantity: '2.000000',
    reservedAmount: '200.20000000',
    reservationFeeRate: '0.001000',
  });
  await createAssetPriceSnapshot(s, '90.00000000', s.now);
  await createFreshFxSnapshot(s.now);

  await matching.matchDueLimitOrders({ now: s.now });
  const filled = await readOrder(order.id);
  // fee = 180 * 0.001 = 0.18 (pinned), NOT 180 * 0.005 = 0.90.
  assert.equal(filled.feeAmount, '0.18000000');
  assert.equal(filled.netAmount, '180.18000000');
}

async function testCancelThenMatch(): Promise<void> {
  const s = await createScenario('cancel');
  const order = await createSubmittedLimitOrder(s, {
    limitPrice: '100.00000000',
    quantity: '1.000000',
    reservedAmount: '100.10000000',
  });
  await createAssetPriceSnapshot(s, '90.00000000', s.now);
  await createFreshFxSnapshot(s.now);

  await cancelService.cancelOwnedLimitBuyOrder({
    userId: s.userId,
    orderId: order.id,
    canceledAt: s.now,
  });

  const summary = await matching.matchDueLimitOrders({ now: s.now });
  assert.equal(summary.filledPathA, 0, 'a canceled order must not fill');

  const after = await readOrder(order.id);
  assert.equal(after.status, OrderStatus.canceled);
  const wallet = await readWallet(s);
  // Cancel released the reservation; the matcher touched nothing.
  assert.equal(wallet.balance, START_BALANCE);
  assert.equal(wallet.reserved, ZERO);
}

async function testEndedSeasonNotFilled(): Promise<void> {
  const s = await createScenario('ended');
  const order = await createSubmittedLimitOrder(s, {
    limitPrice: '100.00000000',
    quantity: '1.000000',
    reservedAmount: '100.10000000',
  });
  await createAssetPriceSnapshot(s, '90.00000000', s.now);
  await createFreshFxSnapshot(s.now);
  await prisma.season.update({
    where: { id: s.seasonId },
    data: {
      status: SeasonStatus.ended,
      endAt: new Date(s.now.getTime() - 60_000),
    },
  });

  const summary = await matching.matchDueLimitOrders({ now: s.now });
  assert.equal(summary.filledPathA, 0);
  const still = await readOrder(order.id);
  assert.equal(still.status, OrderStatus.submitted);
}

async function testEvidenceIsolation(): Promise<void> {
  const s = await createScenario('isolation');
  const submittedAt = boundary5mAgo(s.now, 10);
  await createSubmittedLimitOrder(s, {
    limitPrice: '100.00000000',
    quantity: '1.000000',
    reservedAmount: '100.10000000',
    submittedAt,
  });
  await createAssetPriceSnapshot(s, '101.00000000', s.now);
  await createFreshFxSnapshot(s.now);
  await createClosedCandle(s, { openTime: submittedAt, low: '90.00000000' });

  const snapshotsBefore = await prisma.assetPriceSnapshot.count({
    where: { assetId: s.assetId },
  });
  await matching.matchDueLimitOrders({ now: s.now });
  const snapshotsAfter = await prisma.assetPriceSnapshot.count({
    where: { assetId: s.assetId },
  });
  // The path-B fill created NO synthetic AssetPriceSnapshot.
  assert.equal(snapshotsAfter, snapshotsBefore);
  const evidenceCount = await prisma.limitOrderCandleEvidence.count({
    where: { assetId: s.assetId },
  });
  assert.equal(evidenceCount, 1, 'exactly one evidence row for the candle');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Scenario = {
  userId: string;
  seasonId: string;
  participantId: string;
  tradingAccountId: string;
  walletId: string;
  assetId: string;
  now: Date;
};

async function createScenario(
  label: string,
  options: { seasonFeeRate?: string } = {},
): Promise<Scenario> {
  const suffix = `${label}-${randomUUID()}`;
  const now = new Date();
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${suffix}@example.com`,
      passwordHash: 'integration-test-only',
      nickname: `lm-${randomUUID()}`.slice(0, 40),
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);

  const season = await prisma.season.create({
    data: {
      name: `${PREFIX}-${suffix}`,
      status: SeasonStatus.active,
      startAt: new Date(now.getTime() - 3_600_000),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: '13500000.00000000',
      tradeFeeRate: options.seasonFeeRate ?? FEE_RATE,
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

  const participant = await prisma.seasonParticipant.create({
    data: {
      seasonId: season.id,
      userId: user.id,
      joinedAt: now,
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: '13500000.00000000',
      totalAssetKrw: '10000000.00000000',
      totalReturnRate: ZERO,
      maxDrawdown: ZERO,
      tradingAccountId: tradingAccount.id,
    },
    select: { id: true },
  });

  const wallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      tradingAccountId: tradingAccount.id,
      currencyCode: CurrencyCode.USD,
      balanceAmount: START_BALANCE,
      reservedAmount: ZERO,
    },
    select: { id: true },
  });
  // Portfolio valuation requires both currency wallets; a zero-balance KRW
  // wallet is enough (this asset settles in USD).
  await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      tradingAccountId: tradingAccount.id,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: ZERO,
      reservedAmount: ZERO,
    },
    select: { id: true },
  });

  const asset = await prisma.asset.create({
    data: {
      symbol: `LM${randomUUID().replace(/-/gu, '').slice(0, 20)}`,
      name: `${PREFIX}-${label}`,
      market: 'BINANCE',
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.USD,
      priceCurrency: CurrencyCode.USD,
      settlementCurrency: CurrencyCode.USD,
      isActive: true,
    },
    select: { id: true },
  });
  createdAssetIds.push(asset.id);

  return {
    userId: user.id,
    seasonId: season.id,
    participantId: participant.id,
    tradingAccountId: tradingAccount.id,
    walletId: wallet.id,
    assetId: asset.id,
    now,
  };
}

async function createSubmittedLimitOrder(
  s: Scenario,
  input: {
    limitPrice: string;
    quantity: string;
    reservedAmount: string;
    reservationFeeRate?: string;
    submittedAt?: Date;
  },
): Promise<{ id: string }> {
  const reserved = await reservation.reserveForLimitBuy(prisma, {
    seasonParticipantId: s.participantId,
    tradingAccountId: s.tradingAccountId,
    currencyCode: CurrencyCode.USD,
    amount: input.reservedAmount,
  });
  void reserved;
  return prisma.order.create({
    data: {
      seasonParticipantId: s.participantId,
      tradingAccountId: s.tradingAccountId,
      assetId: s.assetId,
      side: OrderSide.buy,
      orderType: OrderType.limit,
      status: OrderStatus.submitted,
      quantity: input.quantity,
      limitPrice: input.limitPrice,
      currencyCode: CurrencyCode.USD,
      reservedAmount: input.reservedAmount,
      reservationFeeRate: input.reservationFeeRate ?? FEE_RATE,
      submittedAt: input.submittedAt ?? s.now,
    },
    select: { id: true },
  });
}

async function createAssetPriceSnapshot(
  s: Scenario,
  price: string,
  capturedAt: Date,
): Promise<{ id: string }> {
  return prisma.assetPriceSnapshot.create({
    data: {
      assetId: s.assetId,
      price,
      currencyCode: CurrencyCode.USD,
      sourceType: AssetPriceSourceType.provider_api,
      sourceName: 'binance_spot_ws_ticker',
      effectiveAt: capturedAt,
      capturedAt,
    },
    select: { id: true },
  });
}

async function createFreshFxSnapshot(capturedAt: Date): Promise<void> {
  // Global USD/KRW state — tracked so cleanup removes it and it cannot pollute
  // other suites' valuations.
  const row = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      rate: '1350.00000000',
      sourceType: FxRateSourceType.provider_api,
      sourceName: 'korea_exim_exchange_rate',
      effectiveAt: capturedAt,
      capturedAt,
    },
    select: { id: true },
  });
  createdFxSnapshotIds.push(row.id);
}

async function createClosedCandle(
  s: Scenario,
  input: { openTime: Date; low: string },
): Promise<void> {
  await prisma.marketCandle.create({
    data: {
      assetId: s.assetId,
      interval: '5m',
      openTime: input.openTime,
      closeTime: new Date(input.openTime.getTime() + 300_000),
      open: '100.00000000',
      high: '105.00000000',
      low: input.low,
      close: '100.00000000',
      volume: '10.00000000',
      isClosed: true,
      sourceProvider: 'binance',
      sourceUpdatedAt: new Date(input.openTime.getTime() + 300_000),
    },
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function readOrder(id: string) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      executedPrice: true,
      grossAmount: true,
      feeAmount: true,
      netAmount: true,
      assetPriceSnapshotId: true,
      limitOrderCandleEvidenceId: true,
      executedAt: true,
      reservationReleasedAt: true,
    },
  });
  return {
    status: order.status,
    executedPrice: order.executedPrice?.toFixed(8) ?? null,
    grossAmount: order.grossAmount?.toFixed(8) ?? null,
    feeAmount: order.feeAmount?.toFixed(8) ?? null,
    netAmount: order.netAmount?.toFixed(8) ?? null,
    assetPriceSnapshotId: order.assetPriceSnapshotId,
    limitOrderCandleEvidenceId: order.limitOrderCandleEvidenceId,
    executedAt: order.executedAt,
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

function available(wallet: { balance: string; reserved: string }): string {
  return (Number(wallet.balance) - Number(wallet.reserved)).toFixed(8);
}

async function readPosition(s: Scenario) {
  const position = await prisma.position.findUnique({
    where: {
      seasonParticipantId_assetId: {
        seasonParticipantId: s.participantId,
        assetId: s.assetId,
      },
    },
    select: { quantity: true, averageCost: true },
  });
  return position
    ? {
        quantity: position.quantity.toFixed(8),
        averageCost: position.averageCost.toFixed(8),
      }
    : null;
}

async function cleanup(): Promise<void> {
  const participantIds = (
    await prisma.seasonParticipant.findMany({
      where: { seasonId: { in: createdSeasonIds } },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.walletTransaction.deleteMany({
    where: { seasonParticipantId: { in: participantIds } },
  });
  // The post-commit ranking refresh may have written rankings referencing the
  // participant; remove them before the participant.
  await prisma.seasonRanking.deleteMany({
    where: { seasonId: { in: createdSeasonIds } },
  });
  await prisma.equitySnapshot.deleteMany({
    where: { seasonParticipantId: { in: participantIds } },
  });
  await prisma.position.deleteMany({
    where: { seasonParticipantId: { in: participantIds } },
  });
  await prisma.order.deleteMany({
    where: { seasonParticipantId: { in: participantIds } },
  });
  await prisma.limitOrderCandleEvidence.deleteMany({
    where: { assetId: { in: createdAssetIds } },
  });
  await prisma.marketCandle.deleteMany({
    where: { assetId: { in: createdAssetIds } },
  });
  await prisma.assetPriceSnapshot.deleteMany({
    where: { assetId: { in: createdAssetIds } },
  });
  await prisma.fxRateSnapshot.deleteMany({
    where: { id: { in: createdFxSnapshotIds } },
  });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: { in: participantIds } },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { seasonId: { in: createdSeasonIds } },
  });
  await prisma.asset.deleteMany({ where: { id: { in: createdAssetIds } } });
  await prisma.season.deleteMany({ where: { id: { in: createdSeasonIds } } });
  await prisma.tradingAccount.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
