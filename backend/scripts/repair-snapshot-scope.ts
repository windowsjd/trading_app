import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { parseApplyDryRunFlags } from './lib/cli-flags';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';
import {
  SNAPSHOT_SCOPE_MODELS,
  repairSnapshotScope,
  resolveSnapshotScopeExitCode,
} from './lib/repair-snapshot-scope';

/**
 * Operational backfill for EquitySnapshot / DailyPortfolioSnapshot rows left
 * with tradingAccountId = null by an old-version writer during the 작업 7
 * deploy boundary. Run AFTER repair-links has converged.
 *
 * Safety contract (same as the other three repairs):
 *  - Bare invocation is a DRY-RUN; writes require an explicit `--apply`.
 *  - Only the null tradingAccountId column is filled, from the row's own
 *    participant link. No amount, return rate, captured time, snapshot date,
 *    or reason is ever modified. No DROP/DELETE/TRUNCATE/reset.
 *  - Mismatches and general-account rows are REPORTED, never guessed or
 *    corrected.
 *  - `--apply` exits non-zero unless nothing is left unresolved.
 *
 * Usage:
 *   pnpm trading-accounts:repair-snapshot-scope           # dry-run
 *   pnpm trading-accounts:repair-snapshot-scope --apply   # write
 */
async function main(argv: string[]) {
  const flags = parseApplyDryRunFlags(argv);
  loadRuntimeEnv();
  const databaseUrl = requireDatabaseUrl();

  console.log('=== repair-snapshot-scope ===');
  console.log(
    `Mode: ${flags.mode}${flags.apply ? ' (will write)' : ' (no writes)'}`,
  );
  console.log(`Target DB: ${formatDatabaseTarget(databaseUrl)}`);

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const summary = await repairSnapshotScope(prisma, { apply: flags.apply });

    for (const model of SNAPSHOT_SCOPE_MODELS) {
      const m = summary.models[model];
      console.log(
        `\n[${model}] null scope rows: ${m.nullRowCount}, ` +
          `${flags.apply ? 'backfilled' : 'would backfill'}: ${m.backfilledCount}, ` +
          `blocked by missing participant link: ${m.missingParticipantLinkRows.length}, ` +
          `scope mismatches: ${m.mismatchCount}, ` +
          `general rows without an account: ${m.generalRowsWithoutAccount}, ` +
          `general rows with a participant: ${m.generalRowsWithParticipant}`,
      );
      for (const row of m.missingParticipantLinkRows.slice(0, 20)) {
        console.log(
          `  x ${model} ${row.rowId} (participant=${row.seasonParticipantId}) ` +
            '[MISSING_PARTICIPANT_TRADING_ACCOUNT_LINK]',
        );
      }
      if (m.missingParticipantLinkRows.length > 20) {
        console.log(
          `  ... ${m.missingParticipantLinkRows.length - 20} more row(s) omitted`,
        );
      }
    }

    if (summary.failures.length > 0) {
      console.error(`\nFailures: ${summary.failures.length}`);
      for (const failure of summary.failures) {
        console.error(
          `  x [${failure.model ?? '-'}] ${failure.rowId ?? '-'} [${failure.code}] ${failure.message}`,
        );
      }
    }

    if (flags.apply && summary.remainingNullCounts) {
      console.log('\nRemaining after apply:');
      for (const model of SNAPSHOT_SCOPE_MODELS) {
        console.log(
          `  ${model}: null=${summary.remainingNullCounts[model]}, ` +
            `mismatch=${summary.remainingMismatchCounts?.[model]}`,
        );
      }
    }

    process.exitCode = resolveSnapshotScopeExitCode(summary);
  } finally {
    await prisma.$disconnect();
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
