import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { parseApplyDryRunFlags } from './lib/cli-flags';
import {
  backfillGeneralPerformance,
  resolveBackfillExitCode,
} from './lib/backfill-general-performance';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';

/**
 * Creates the performance ORIGIN for general accounts opened before 작업 7.
 *
 * Migrations never create one: inventing a starting point silently rewrites a
 * user's return history. This script does it explicitly and ONLY where the
 * baseline is provable — general trading has never been enabled, so an
 * eligible account's total assets must equal exactly the external funding it
 * received, which makes investment PnL 0 and a TWR factor of 1 the truth
 * rather than an assumption. Every condition is verified per account.
 *
 * Safety contract:
 *  - Bare invocation is a DRY-RUN; writes require an explicit `--apply`.
 *  - Accounts that already have an origin are skipped (idempotent).
 *  - Partial snapshot state, trading rows, wallet problems, claim/ledger
 *    mismatches, unknown credits, USD cash, or total != external funding are
 *    REPORTED and skipped. Nothing is overwritten and there is no `--force`.
 *  - `--apply` exits non-zero if anything was skipped or is still missing an
 *    origin afterwards.
 *
 * Usage:
 *   pnpm trading-accounts:backfill-general-performance           # dry-run
 *   pnpm trading-accounts:backfill-general-performance --apply   # write
 */
async function main(argv: string[]) {
  const flags = parseApplyDryRunFlags(argv);
  loadRuntimeEnv();
  const databaseUrl = requireDatabaseUrl();

  console.log('=== backfill-general-performance ===');
  console.log(
    `Mode: ${flags.mode}${flags.apply ? ' (will write)' : ' (no writes)'}`,
  );
  console.log(`Target DB: ${formatDatabaseTarget(databaseUrl)}`);

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const summary = await backfillGeneralPerformance(prisma, {
      apply: flags.apply,
      now: new Date(),
    });

    console.log(`\ngeneral accounts: ${summary.generalAccountCount}`);
    console.log(`  already initialized: ${summary.alreadyInitialized}`);
    console.log(
      `  eligible for a baseline: ${summary.eligible}` +
        (flags.apply ? ` (created ${summary.created})` : ' (dry-run)'),
    );
    console.log(`  skipped: ${summary.skipped}`);

    if (summary.findings.length > 0) {
      console.error(`\nFindings: ${summary.findings.length}`);
      for (const finding of summary.findings.slice(0, 50)) {
        console.error(
          `  x [${finding.code}] account=${finding.tradingAccountId} ${finding.detail}`,
        );
      }
      if (summary.findings.length > 50) {
        console.error(`  ... ${summary.findings.length - 50} more omitted`);
      }
      console.error(
        '\nSkipped accounts are NEVER auto-corrected. Investigate each one; a' +
          ' baseline is only safe while general trading has produced no value change.',
      );
    }

    if (flags.apply) {
      console.log(
        `\nGeneral accounts still without an origin: ${summary.remainingWithoutOrigin}`,
      );
    }

    process.exitCode = resolveBackfillExitCode(summary);
  } finally {
    await prisma.$disconnect();
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
