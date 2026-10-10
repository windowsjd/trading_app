/** Read-only operator check before/after enabling Futures: contract coverage,
 * Futures Last and Mark freshness per instrument, pending work and workers.
 * Runs inside a READ ONLY transaction; it never repairs, refreshes or writes. */
import { loadRuntimeEnv } from './lib/load-runtime-env';
import { PrismaService } from '../src/prisma/prisma.service';
import { verifiedFuturesInstrument } from '../src/futures/futures-instrument-coverage';
import {
  FUTURES_LAST_MAX_CAPTURE_AGE_MS,
  FUTURES_LAST_MAX_TRADE_AGE_MS,
  validFuturesLastPrice,
} from '../src/futures/futures-last-price';
import { MARK_MAX_AGE_MS, readFuturesMark } from '../src/futures/futures-mark';
import {
  futuresLastPriceConfig,
  futuresRiskConfig,
  futuresTradingMode,
} from '../src/futures/futures.config';

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
    tradeAgeMs: number;
    receiptAgeMs: number;
  } | null;
  mark: { valid: boolean; receiptAgeMs?: number };
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
                tradeAgeMs: +now - +last.effectiveAt,
                receiptAgeMs: +now - +last.capturedAt,
              }
            : null,
          mark: mark
            ? { valid: true, receiptAgeMs: +now - +mark.capturedAt }
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
          select: { status: true, startedAt: true, finishedAt: true },
        });
        workers.push({
          jobName,
          status: run?.status ?? null,
          startedAt: run?.startedAt?.toISOString() ?? null,
          finishedAt: run?.finishedAt?.toISOString() ?? null,
        });
      }
      return {
        database: target(),
        evaluatedAt: now.toISOString(),
        policy: {
          lastMaxReceiptAgeMs: FUTURES_LAST_MAX_CAPTURE_AGE_MS,
          lastMaxTradeAgeMs: FUTURES_LAST_MAX_TRADE_AGE_MS,
          markMaxAgeMs: MARK_MAX_AGE_MS,
        },
        config: {
          tradingMode: futuresTradingMode(),
          riskEngine: futuresRiskConfig().enabled,
          markIngestion: futuresRiskConfig().ingestion,
          lastPriceIngestion: futuresLastPriceConfig().ingestion,
        },
        summary: {
          instruments: rows.length,
          activeVerified: rows.filter(
            (r) => r.active && r.coverage === 'verified',
          ).length,
          ready: rows.filter((r) => r.ready).length,
          openPositions: rows.reduce((n, r) => n + r.openPositions, 0),
          pendingEntries: rows.reduce((n, r) => n + r.pendingEntries, 0),
          liveProtections: rows.reduce((n, r) => n + r.liveProtections, 0),
        },
        instruments: rows,
        workers,
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
  console.log(JSON.stringify(report, null, 2));
  const blocking = report.instruments.filter(
    (r) => r.active && r.coverage === 'verified' && !r.ready,
  );
  if (requireReady && (blocking.length || !report.summary.ready))
    process.exitCode = 1;
}
main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
