/** Read-only operator check before/after enabling Futures: contract coverage,
 * Futures Last and Mark freshness per instrument, pending work and workers.
 * Runs inside a READ ONLY transaction; it never repairs, refreshes or writes. */
import {
  evaluateFuturesReadiness,
  FUTURES_WORKER_REPORT_MAX_AGE_MS,
  type FuturesSettlementReadiness,
} from './lib/futures-readiness';
import { loadRuntimeEnv } from './lib/load-runtime-env';
import { PrismaService } from '../src/prisma/prisma.service';
import { verifiedFuturesInstrument } from '../src/futures/futures-instrument-coverage';
import {
  FUTURES_LAST_MAX_CAPTURE_AGE_MS,
  FUTURES_LAST_MAX_TRADE_AGE_MS,
  validFuturesLastPrice,
  validFuturesFinalLastPrice,
} from '../src/futures/futures-last-price';
import { MARK_MAX_AGE_MS, readFuturesMark } from '../src/futures/futures-mark';
import {
  futuresLastPriceConfig,
  futuresRiskConfig,
  futuresTradingMode,
} from '../src/futures/futures.config';
import { validLegacySpotFinalPrice } from '../src/futures/futures-price';
import { conditionalEnabled } from '../src/conditional/conditional.config';

loadRuntimeEnv();
const requireReady = process.argv.includes('--require-ready');
const unknown = process.argv
  .slice(2)
  .filter((arg) => arg !== '--require-ready');
if (unknown.length)
  throw new Error('Usage: pnpm futures:price-readiness [--require-ready]');
const db = new PrismaService();

type ReadinessRow = {
  symbol: string;
  instrumentId: string;
  active: boolean;
  coverage: string;
  last: {
    valid: boolean;
    price: string;
    source: string;
    effectiveAt: string;
    capturedAt: string;
    tradeAgeMs: number;
    receiptAgeMs: number;
  } | null;
  mark: {
    valid: boolean;
    receiptAgeMs?: number;
    price?: string;
    source?: string;
    effectiveAt?: string;
    capturedAt?: string;
  };
  openPositions: number;
  pendingEntries: number;
  liveProtections: number;
  ready: boolean;
};
type WorkerRun = {
  jobName: string;
  status: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  dryRun: boolean;
  resultJson: unknown;
};

function target() {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return `${url.hostname}:${url.port || '5432'}/${url.pathname.slice(1)}`;
  } catch {
    return 'unparseable DATABASE_URL';
  }
}

async function main() {
  const report = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const now = (
        await tx.$queryRaw<
          Array<{ now: Date }>
        >`SELECT clock_timestamp() AS now`
      )[0].now;
      const instruments = await tx.futuresInstrument.findMany({
        include: { underlyingAsset: true },
        orderBy: { id: 'asc' },
      });
      const rows: ReadinessRow[] = [];
      for (const instrument of instruments) {
        const last = await tx.futuresLastPriceSnapshot.findFirst({
          where: {
            instrumentId: instrument.id,
            capturedAt: { lte: now },
            effectiveAt: { lte: now },
          },
          orderBy: [
            { effectiveAt: 'desc' },
            { capturedAt: 'desc' },
            { id: 'desc' },
          ],
        });
        const mark = await readFuturesMark(tx, instrument, now, false);
        // Show rejected evidence too, so stale/future Mark failures have ages
        // and a source. Only the existing reader decides validity/priority.
        const observedMark =
          mark ??
          (await tx.futuresMarkSnapshot.findFirst({
            where: { instrumentId: instrument.id },
            orderBy: [
              { effectiveAt: 'desc' },
              { capturedAt: 'desc' },
              { id: 'desc' },
            ],
          }));
        const verified = verifiedFuturesInstrument(instrument, now);
        const lastValid =
          !!last && validFuturesLastPrice(last, instrument, now);
        const [openPositions, pendingEntries, liveProtections] =
          await Promise.all([
            tx.futuresPosition.count({
              where: { instrumentId: instrument.id, status: 'open' },
            }),
            tx.futuresLimitOrder.count({
              where: { instrumentId: instrument.id, status: 'submitted' },
            }),
            tx.protectionGroup.count({
              where: {
                domain: 'futures',
                assetId: instrument.underlyingAssetId,
                status: { in: ['holding', 'active'] },
              },
            }),
          ]);
        rows.push({
          symbol: instrument.underlyingAsset.symbol,
          instrumentId: instrument.id,
          active: instrument.isActive && instrument.underlyingAsset.isActive,
          coverage: verified
            ? 'verified'
            : instrument.markVerifiedAt
              ? 'expired_or_invalid'
              : 'unverified',
          last: last
            ? {
                valid: lastValid,
                price: last.price.toFixed(8),
                source: last.source,
                effectiveAt: last.effectiveAt.toISOString(),
                capturedAt: last.capturedAt.toISOString(),
                tradeAgeMs: +now - +last.effectiveAt,
                receiptAgeMs: +now - +last.capturedAt,
              }
            : null,
          mark: observedMark
            ? {
                valid: !!mark,
                receiptAgeMs: +now - +observedMark.capturedAt,
                price: observedMark.price.toFixed(8),
                source: observedMark.source,
                effectiveAt: observedMark.effectiveAt.toISOString(),
                capturedAt: observedMark.capturedAt.toISOString(),
              }
            : { valid: false },
          openPositions,
          pendingEntries,
          liveProtections,
          // Catalog/open need coverage; every fill/exit needs Last; open/risk need Mark.
          ready: verified && lastValid && !!mark,
        });
      }
      const workers: WorkerRun[] = [];
      for (const jobName of [
        'futures_limit_matching',
        'conditional_orders',
        'futures_liquidation',
        'futures_mark_retention',
        'futures_last_price_retention',
      ] as const) {
        const run = await tx.opsJobRun.findFirst({
          where: { jobName },
          orderBy: { startedAt: 'desc' },
          select: {
            status: true,
            startedAt: true,
            finishedAt: true,
            dryRun: true,
            resultJson: true,
          },
        });
        workers.push({
          jobName,
          status: run?.status ?? null,
          startedAt: run?.startedAt?.toISOString() ?? null,
          finishedAt: run?.finishedAt?.toISOString() ?? null,
          dryRun: run?.dryRun ?? false,
          resultJson: run?.resultJson ?? null,
        });
      }
      // Fresh live prices cannot repair an ended season's missing historical
      // evidence. Check all remaining lifetimes, including inactive instruments.
      const finalPositions = await tx.futuresPosition.findMany({
        where: {
          status: 'open',
          tradingAccount: {
            seasonParticipant: {
              season: {
                OR: [
                  { endAt: { lte: now } },
                  { status: { in: ['ended', 'settled'] } },
                ],
              },
            },
          },
        },
        include: {
          instrument: { include: { underlyingAsset: true } },
          tradingAccount: {
            include: { seasonParticipant: { include: { season: true } } },
          },
        },
      });
      const settlements: FuturesSettlementReadiness[] = [];
      for (const position of finalPositions) {
        const season = position.tradingAccount.seasonParticipant!.season;
        if (
          settlements.some(
            (s) =>
              s.seasonId === season.id &&
              s.instrumentId === position.instrumentId,
          )
        )
          continue;
        const pin = await tx.futuresSeasonPrice.findUnique({
          where: {
            seasonId_instrumentId: {
              seasonId: season.id,
              instrumentId: position.instrumentId,
            },
          },
          include: { snapshot: true, lastPriceSnapshot: true },
        });
        let evidence: FuturesSettlementReadiness['evidence'] =
          'missing_or_invalid';
        if (pin) {
          const sameBoundary =
            +pin.endAt === +season.endAt && pin.feeRate.eq(season.tradeFeeRate);
          if (
            sameBoundary &&
            !pin.snapshot &&
            pin.lastPriceSnapshot &&
            validFuturesFinalLastPrice(
              pin.lastPriceSnapshot,
              position.instrument,
              season.endAt,
            )
          )
            evidence = 'pinned_last';
          else if (
            sameBoundary &&
            !pin.lastPriceSnapshot &&
            pin.snapshot &&
            validLegacySpotFinalPrice(
              pin.snapshot,
              position.instrument.underlyingAsset,
              season.endAt,
            )
          )
            evidence = 'pinned_legacy_spot';
        } else {
          const candidate = await tx.futuresLastPriceSnapshot.findFirst({
            where: {
              instrumentId: position.instrumentId,
              capturedAt: { lte: season.endAt },
              effectiveAt: { lte: season.endAt },
            },
            orderBy: [
              { effectiveAt: 'desc' },
              { capturedAt: 'desc' },
              { id: 'desc' },
            ],
          });
          if (
            candidate &&
            validFuturesFinalLastPrice(
              candidate,
              position.instrument,
              season.endAt,
            )
          )
            evidence = 'unfixed_last_candidate';
        }
        settlements.push({
          seasonId: season.id,
          instrumentId: position.instrumentId,
          endAt: season.endAt.toISOString(),
          evidence,
          ready: evidence !== 'missing_or_invalid',
        });
      }
      const config = {
        tradingMode: futuresTradingMode(),
        riskEngine: futuresRiskConfig().enabled,
        markIngestion: futuresRiskConfig().ingestion,
        lastPriceIngestion: futuresLastPriceConfig().ingestion,
        conditionalOrders: conditionalEnabled(),
      };
      return {
        database: target(),
        evaluatedAt: now.toISOString(),
        policy: {
          target:
            'all active registered instruments plus inactive instruments with live financial work',
          releaseMode: 'ENABLED (independent of current trading mode)',
          lastMaxReceiptAgeMs: FUTURES_LAST_MAX_CAPTURE_AGE_MS,
          lastMaxTradeAgeMs: FUTURES_LAST_MAX_TRADE_AGE_MS,
          markMaxAgeMs: MARK_MAX_AGE_MS,
          workerMaxReportAgeMs: FUTURES_WORKER_REPORT_MAX_AGE_MS,
          workerObservation:
            'Ops runs are demand-driven, not idle heartbeats; fresh prices prove receipt, not transport connectivity',
        },
        ...evaluateFuturesReadiness(rows, workers, config, now, settlements),
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
  console.log(JSON.stringify(report, null, 2));
  if (requireReady && !report.readiness.launchReady) process.exitCode = 1;
}
main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
