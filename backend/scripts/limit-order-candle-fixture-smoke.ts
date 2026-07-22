/**
 * Path-B candle eligibility smoke against a REAL database.
 *
 * It complements the phase-3 integration runner by asserting the candle
 * contract from the CANDLE side: what the canonical finalizer actually writes
 * (a closed 5m row) is exactly what path B accepts, and the states the
 * finalizer deliberately does not commit as canonical (open buckets) are
 * exactly what path B refuses.
 *
 * No provider credentials, no external network, no Redis dependency.
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
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { LimitOrderCandidateRepository } from '../src/orders/limit-matching/limit-order-candidate.repository';
import { LimitOrderReconciliationCheckpointRepository } from '../src/orders/limit-matching/limit-order-reconciliation-checkpoint.repository';
import { LimitOrderCandleReconciliationService } from '../src/orders/limit-matching/limit-order-candle-reconciliation.service';
import {
  calculateCandleMatchingEligibleFrom,
  checkCanonicalClosedCandle,
} from '../src/orders/limit-matching/limit-order-candle-eligibility';
import { LimitOrderExecutionService } from '../src/orders/limit-matching/limit-order-execution.service';
import { LimitOrderMatchBoundaryService } from '../src/orders/limit-matching/limit-order-match-boundary.service';
import { MarketCandlesRepository } from '../src/assets/market-candles.repository';

const PREFIX = `limit-order-candle-fixture-${process.pid}-${Date.now()}`;
const ZERO = '0.00000000';
const FIVE_MINUTES_MS = 5 * 60_000;

const prisma = new PrismaService();
const boundary = new LimitOrderMatchBoundaryService();

const createdUserIds: string[] = [];
const createdParticipantIds: string[] = [];
let seasonId: string;
let assetId: string;

async function main(): Promise<void> {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  assert.equal(process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED, 'true');
  assert.equal(process.env.LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED, 'true');

  await prisma.$connect();
  const execution = new LimitOrderExecutionService(
    prisma,
    new PortfolioValuationService(prisma),
    {
      refreshCurrentRankingAfterParticipantChange: () =>
        Promise.resolve({ skipped: false }),
    } as never,
  );
  const reconciliation = new LimitOrderCandleReconciliationService(
    prisma,
    new LimitOrderCandidateRepository(prisma),
    execution,
    boundary,
    new LimitOrderReconciliationCheckpointRepository(prisma),
  );
  const repository = new MarketCandlesRepository(prisma);

  try {
    await seed();

    // 1) The canonical finalizer's own write path (MarketCandlesRepository
    //    upsert with isClosed=true) produces a row path B accepts.
    const eligibleFrom = alignWindow(new Date(Date.now() - 60 * 60_000));
    const scenario = await createSubmittedOrder('accepts', eligibleFrom);
    await repository.upsertMany([
      {
        assetId,
        interval: '5m',
        openTime: eligibleFrom,
        closeTime: new Date(eligibleFrom.getTime() + FIVE_MINUTES_MS),
        open: '100.00000000',
        high: '110.00000000',
        low: '90.00000000',
        close: '105.00000000',
        volume: '10.00000000',
        amount: '1000.00000000',
        isClosed: true,
        sourceProvider: 'binance_spot_ws_5m_kline',
        sourceUpdatedAt: new Date(eligibleFrom.getTime() + FIVE_MINUTES_MS),
      },
    ]);
    const canonical = await prisma.marketCandle.findFirstOrThrow({
      where: { assetId, interval: '5m', openTime: eligibleFrom },
    });
    assert.deepEqual(checkCanonicalClosedCandle(canonical), { ok: true });
    console.log('ok canonical closed 5m candle passes eligibility');

    await reconciliation.reconcile({
      now: new Date(eligibleFrom.getTime() + FIVE_MINUTES_MS + 60_000),
      lookbackMs: 86_400_000,
    });
    const filled = await prisma.order.findUniqueOrThrow({
      where: { id: scenario.orderId },
      select: {
        status: true,
        executedPrice: true,
        matchingSource: true,
        assetPriceSnapshotId: true,
        candleEvidence: {
          select: { triggerLowPrice: true, executionPricePolicy: true },
        },
      },
    });
    assert.equal(filled.status, OrderStatus.executed);
    assert.equal(filled.matchingSource, 'closed_5m_candle');
    // Fill price is the LIMIT price, and the candle low is only the trigger.
    assert.equal(filled.executedPrice?.toFixed(8), '100.00000000');
    assert.equal(
      filled.candleEvidence?.triggerLowPrice.toFixed(8),
      '90.00000000',
    );
    assert.equal(filled.candleEvidence?.executionPricePolicy, 'limit_price');
    assert.equal(filled.assetPriceSnapshotId, null);
    console.log('ok path B fills at the limit price with candle evidence');

    // 2) An unfinalized bucket (isClosed=false) is exactly what the finalizer
    //    refuses to treat as canonical, and path B refuses it too.
    const openWindow = new Date(eligibleFrom.getTime() + FIVE_MINUTES_MS);
    const openOrder = await createSubmittedOrder('rejects-open', openWindow);
    await prisma.marketCandle.create({
      data: {
        assetId,
        interval: '5m',
        openTime: openWindow,
        closeTime: new Date(openWindow.getTime() + FIVE_MINUTES_MS),
        open: '100.00000000',
        high: '110.00000000',
        low: '90.00000000',
        close: '105.00000000',
        volume: '10.00000000',
        amount: '1000.00000000',
        isClosed: false,
        sourceProvider: 'binance_spot_ws_5m_kline',
        sourceUpdatedAt: new Date(openWindow.getTime() + FIVE_MINUTES_MS),
      },
    });
    const incomplete = await prisma.marketCandle.findFirstOrThrow({
      where: { assetId, interval: '5m', openTime: openWindow },
    });
    assert.equal(checkCanonicalClosedCandle(incomplete).ok, false);
    await reconciliation.reconcile({
      now: new Date(openWindow.getTime() + FIVE_MINUTES_MS + 60_000),
      lookbackMs: 86_400_000,
    });
    assert.equal(
      (
        await prisma.order.findUniqueOrThrow({
          where: { id: openOrder.orderId },
          select: { status: true },
        })
      ).status,
      OrderStatus.submitted,
    );
    console.log('ok unfinalized candle never fills an order');

    console.log('limit order candle fixture smoke ok');
  } finally {
    await boundary.onModuleDestroy().catch(() => undefined);
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
  }
}

async function seed(): Promise<void> {
  const now = new Date();
  const season = await prisma.season.create({
    data: {
      name: PREFIX,
      status: SeasonStatus.active,
      startAt: new Date(now.getTime() - 12 * 3_600_000),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: '1300000.00000000',
      tradeFeeRate: '0.050000',
      fxFeeRate: '0.001000',
    },
    select: { id: true },
  });
  seasonId = season.id;
  const asset = await prisma.asset.create({
    data: {
      symbol: PREFIX.slice(0, 32),
      name: PREFIX,
      market: 'BINANCE',
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.USD,
      priceCurrency: CurrencyCode.USD,
      settlementCurrency: CurrencyCode.USD,
      isActive: true,
    },
    select: { id: true },
  });
  assetId = asset.id;
  // Path B records an equity snapshot like any other fill, which values the
  // new position from the ordinary market-price pipeline. It never writes a
  // price snapshot of its own.
  await prisma.assetPriceSnapshot.create({
    data: {
      assetId,
      price: '100.00000000',
      currencyCode: CurrencyCode.USD,
      sourceType: AssetPriceSourceType.provider_api,
      sourceName: 'binance_spot_ws_trade',
      sourceTimestamp: now,
      effectiveAt: now,
      capturedAt: now,
    },
  });
  // USD positions are valued in KRW, so the equity snapshot each fill records
  // needs a fresh USD/KRW rate. Production gets this from FX ingestion.
  await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      rate: '1300.00000000',
      sourceType: FxRateSourceType.provider_api,
      sourceName: 'exchange_rate_api',
      sourceTimestamp: now,
      effectiveAt: now,
      capturedAt: now,
    },
  });
}

async function createSubmittedOrder(
  label: string,
  submittedAt: Date,
): Promise<{ orderId: string; participantId: string }> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${label}@example.com`,
      passwordHash: 'fixture-smoke-only',
      nickname: `${label}-${process.pid}-${randomUUID()}`.slice(0, 40),
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  const participant = await prisma.seasonParticipant.create({
    data: {
      seasonId,
      userId: user.id,
      joinedAt: submittedAt,
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: '1300000.00000000',
      totalAssetKrw: '1300000.00000000',
      totalReturnRate: ZERO,
      maxDrawdown: ZERO,
    },
    select: { id: true },
  });
  createdParticipantIds.push(participant.id);
  await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: CurrencyCode.USD,
      balanceAmount: '1000.00000000',
      reservedAmount: '100.10000000',
    },
  });
  await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: ZERO,
      reservedAmount: ZERO,
    },
  });
  const orderId = randomUUID();
  await prisma.order.create({
    data: {
      id: orderId,
      seasonParticipantId: participant.id,
      assetId,
      side: OrderSide.buy,
      orderType: OrderType.limit,
      status: OrderStatus.submitted,
      quantity: '1.00000000',
      limitPrice: '100.00000000',
      currencyCode: CurrencyCode.USD,
      reservedAmount: '100.10000000',
      reservationFeeRate: '0.001000',
      candleMatchingEligibleFrom:
        calculateCandleMatchingEligibleFrom(submittedAt),
      idempotencyKey: `${PREFIX}-${label}`,
      requestHash: `${PREFIX}-${label}`,
      submittedAt,
      createdAt: submittedAt,
      updatedAt: submittedAt,
    },
  });
  return { orderId, participantId: participant.id };
}

function alignWindow(value: Date): Date {
  return new Date(
    Math.floor(value.getTime() / FIVE_MINUTES_MS) * FIVE_MINUTES_MS,
  );
}

async function cleanup(): Promise<void> {
  const candleIds = (
    await prisma.marketCandle.findMany({
      where: { assetId },
      select: { id: true },
    })
  ).map((row) => row.id);
  await prisma.limitOrderProcessedCandle.deleteMany({
    where: { marketCandleId: { in: candleIds } },
  });
  await prisma.equitySnapshot.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.walletTransaction.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.order.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.limitOrderCandleEvidence.deleteMany({
    where: { marketCandleId: { in: candleIds } },
  });
  await prisma.marketCandle.deleteMany({ where: { assetId } });
  await prisma.position.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: { in: createdParticipantIds } },
  });
  await prisma.assetPriceSnapshot.deleteMany({ where: { assetId } });
  await prisma.fxRateSnapshot.deleteMany({
    where: { sourceName: 'exchange_rate_api', rate: '1300.00000000' },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { id: { in: createdParticipantIds } },
  });
  await prisma.asset.deleteMany({ where: { id: assetId } });
  await prisma.season.deleteMany({ where: { id: seasonId } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
