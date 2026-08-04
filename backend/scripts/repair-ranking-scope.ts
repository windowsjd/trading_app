import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { parseApplyDryRunFlags } from './lib/cli-flags';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';
import {
  auditRankingAndSettlement,
  repairRankingScope,
  resolveRankingScopeExitCode,
} from './lib/repair-ranking-scope';

/**
 * Operational backfill of `season_rankings.trading_account_id` left null by an
 * old-version writer during the 작업 8 deploy boundary. Run AFTER repair-links
 * has converged, and after every old backend instance has shut down — a running
 * old writer keeps creating new null rows behind this script.
 *
 * Safety contract (same as the other four repairs):
 *  - Bare invocation is a DRY-RUN; writes require an explicit `--apply`.
 *  - Only the null tradingAccountId column is filled, from the row's own
 *    participant link. No rank, amount, return rate, drawdown, fill count, or
 *    timestamp is ever modified, and no participant result, season status, or
 *    account status is touched. No DROP/DELETE/TRUNCATE/reset.
 *  - Non-null mismatches, general-account links, user mismatches, and season
 *    mismatches are REPORTED, never guessed or corrected.
 *  - `--apply` exits non-zero unless nothing is left unresolved.
 *
 * The read-only ranking + settlement audit runs on BOTH modes, because the
 * findings it surfaces (rank gaps, tier disagreements, settled seasons still
 * holding open accounts) are not repairable by this script and need a job
 * re-run instead.
 *
 * Usage:
 *   pnpm trading-accounts:repair-ranking-scope           # dry-run
 *   pnpm trading-accounts:repair-ranking-scope --apply   # write
 */
async function main(argv: string[]) {
  const flags = parseApplyDryRunFlags(argv);
  loadRuntimeEnv();
  const databaseUrl = requireDatabaseUrl();

  console.log('=== repair-ranking-scope ===');
  console.log(
    `Mode: ${flags.mode}${flags.apply ? ' (will write)' : ' (no writes)'}`,
  );
  console.log(`Target DB: ${formatDatabaseTarget(databaseUrl)}`);

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const summary = await repairRankingScope(prisma, { apply: flags.apply });

    console.log(
      `\n[seasonRanking] null scope rows: ${summary.nullScopeRowCount}, ` +
        `${flags.apply ? 'backfilled' : 'would backfill'}: ${summary.backfilledCount}, ` +
        `blocked: ${summary.blockedRows.length}, ` +
        `scope mismatches: ${summary.mismatchCount}, ` +
        `participant link null: ${summary.participantLinkNullCount}, ` +
        `general-account rows: ${summary.generalAccountCount}, ` +
        `user mismatches: ${summary.userMismatchCount}, ` +
        `season mismatches: ${summary.seasonMismatchCount}`,
    );

    for (const row of summary.blockedRows.slice(0, 20)) {
      console.log(`  x ${row.rankingId ?? '-'} [${row.code}] ${row.message}`);
    }
    if (summary.blockedRows.length > 20) {
      console.log(
        `  ... ${summary.blockedRows.length - 20} more blocked row(s) omitted`,
      );
    }

    const auditFindings = await auditRankingAndSettlement(prisma);
    console.log(
      `\n[audit] ranking + settlement findings: ${auditFindings.length}`,
    );
    for (const finding of auditFindings) {
      console.log(`  ! [${finding.code}] ${finding.count} ${finding.message}`);
    }

    if (summary.failures.length > 0) {
      console.error(`\nFailures: ${summary.failures.length}`);
      for (const failure of summary.failures) {
        console.error(
          `  x ${failure.rankingId ?? '-'} [${failure.code}] ${failure.message}`,
        );
      }
    }

    if (flags.apply) {
      console.log(
        `\nRemaining after apply: null=${summary.remainingNullCount}, ` +
          `mismatch=${summary.remainingMismatchCount}`,
      );
    }

    const exitCode = resolveRankingScopeExitCode(summary);
    // Audit findings are reported but do NOT by themselves fail the repair:
    // several of them (rank gaps, tier disagreements) are outside this
    // script's remit and are fixed by re-running the owning job.
    process.exitCode = exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
