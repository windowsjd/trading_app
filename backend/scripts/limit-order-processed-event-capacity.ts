/**
 * Manual capacity report for `limit_order_processed_events`.
 *
 * WHY THIS IS A SCRIPT AND NOT A HEARTBEAT FIELD
 * ----------------------------------------------
 * The matcher heartbeat used to run `COUNT(*)` plus two filtered counts over
 * the WHOLE table every 60 seconds. That table is append-only and grows without
 * bound (no retention deletion is performed — see
 * docs/limit-order-live-matching-operations.md for why a TTL cannot be proven
 * correct yet), so the cost of that observation rose forever and was paid by
 * the matcher's own event loop.
 *
 * The heartbeat now samples APPROXIMATE figures on a multi-minute interval.
 * This script is where an operator gets EXACT numbers, on demand, plus the
 * growth projection used for the partitioning decision.
 *
 * Read-only: it never deletes, never writes, and never mutates a row.
 */
import 'dotenv/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { LimitOrderMatcherHealthService } from '../src/orders/limit-matching/limit-order-matcher-health.service';

const prisma = new PrismaService();

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured.');
  }
  await prisma.$connect();
  try {
    const health = new LimitOrderMatcherHealthService(prisma);
    const approximate = await health.collectProcessedEventStats();
    const exact = await health.collectExactProcessedEventStats();

    const totalBytes = (exact.tableBytes ?? 0) + (exact.indexBytes ?? 0);
    const bytesPerRow = exact.rowCount > 0 ? totalBytes / exact.rowCount : 0;
    // Projection from the observed last-24h rate, which already reflects this
    // deployment's asset count and market activity — a far better basis than
    // any hand-written per-asset estimate.
    const rowsPerDay = exact.lastDayCount;
    const rowsPerMonth = rowsPerDay * 30;

    console.log(
      JSON.stringify(
        {
          event: 'limit_order_processed_event_capacity',
          approximate: {
            rowCount: approximate.rowCount,
            sampledAt: approximate.sampledAt,
          },
          exact: {
            rowCount: exact.rowCount,
            oldestProcessedAt: exact.oldestProcessedAt,
            newestProcessedAt: exact.newestProcessedAt,
            lastHourCount: exact.lastHourCount,
            lastDayCount: exact.lastDayCount,
            tableBytes: exact.tableBytes,
            indexBytes: exact.indexBytes,
            totalBytes,
          },
          projection: {
            bytesPerRow: Math.round(bytesPerRow * 100) / 100,
            rowsPerDay,
            rowsPerMonth,
            bytesPerDay: Math.round(rowsPerDay * bytesPerRow),
            bytesPerMonth: Math.round(rowsPerMonth * bytesPerRow),
            bytesPerYear: Math.round(rowsPerMonth * 12 * bytesPerRow),
          },
          // How far the planner statistics have drifted from reality. A large
          // drift means autovacuum/ANALYZE is not keeping up, and the
          // heartbeat's approximate figure should be read with that in mind.
          estimateDriftRatio:
            exact.rowCount > 0
              ? Math.round(
                  ((approximate.rowCount - exact.rowCount) / exact.rowCount) *
                    10_000,
                ) / 10_000
              : 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
