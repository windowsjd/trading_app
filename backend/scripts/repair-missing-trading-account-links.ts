import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { parseApplyDryRunFlags } from './lib/cli-flags';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';
import {
  repairMissingTradingAccountLinks,
  resolveRepairLinksExitCode,
} from './lib/repair-trading-account-links';

/**
 * Operational repair for participant↔trading-account consistency:
 *
 *  1. Season participants created with tradingAccountId = null by an
 *     old-version writer (deploy boundary).
 *  2. Participants excluded before the exclusion→suspended sync shipped,
 *     whose season account is therefore still active.
 *
 * Safety contract:
 *  - Bare invocation is a DRY-RUN; writes require an explicit `--apply`.
 *  - Only the participant→account link and the account status
 *    (active→suspended, guarded) are repaired. Wallets, ledgers, orders,
 *    positions, exchanges, snapshots, exclusion metadata, ranks, and rewards
 *    are never modified. Closed accounts are never reverted; general
 *    accounts and mismatched (foreign-user) accounts are never touched.
 *  - Already-consistent rows are never modified; re-running is idempotent.
 *  - Never drops, truncates, deletes, or resets anything.
 *  - `--apply` exits non-zero unless the post-apply verification confirms
 *    ZERO remaining null links and ZERO remaining excluded-active
 *    mismatches. The follow-up NOT NULL migration must only be considered
 *    after this command exits 0.
 *
 * Usage:
 *   pnpm trading-accounts:repair-links             # dry-run (default)
 *   pnpm trading-accounts:repair-links --apply     # perform the repair
 */

async function main(argv: string[]) {
  const flags = parseApplyDryRunFlags(argv);
  loadRuntimeEnv();
  const databaseUrl = requireDatabaseUrl();

  console.log('=== repair-missing-trading-account-links ===');
  console.log(
    `Mode: ${flags.mode}${flags.apply ? ' (will write)' : ' (no writes)'}`,
  );
  console.log(`Target DB: ${formatDatabaseTarget(databaseUrl)}`);

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const summary = await repairMissingTradingAccountLinks(prisma, {
      apply: flags.apply,
    });

    console.log(
      `\n[1] Participants with tradingAccountId = null: ${summary.nullLinkCount}`,
    );
    for (const outcome of summary.outcomes) {
      console.log(
        `  - ${outcome.seasonParticipantId} (season=${outcome.seasonId}, user=${outcome.userId})` +
          ` -> account ${outcome.tradingAccountId} [${outcome.action}]`,
      );
    }

    console.log(
      `\n[2] Excluded participants with an active season account: ${summary.excludedActiveMismatchCount}`,
    );
    for (const outcome of summary.excludedActiveOutcomes) {
      console.log(
        `  - ${outcome.seasonParticipantId} (season=${outcome.seasonId}, user=${outcome.userId})` +
          ` -> account ${outcome.tradingAccountId} [${outcome.action}]`,
      );
    }

    if (summary.failures.length > 0) {
      console.error(`\nFailed participants: ${summary.failures.length}`);
      for (const failure of summary.failures) {
        console.error(
          `  x ${failure.seasonParticipantId} (season=${failure.seasonId}, user=${failure.userId})` +
            ` [${failure.code}] ${failure.message}`,
        );
      }
    }

    if (flags.apply) {
      console.log(
        `\nLink repairs: ${summary.outcomes.length}, status corrections: ` +
          `${summary.excludedActiveOutcomes.filter((o) => o.action === 'suspended').length}, ` +
          `failed: ${summary.failures.length}`,
      );
      console.log(
        `Remaining null links after apply: ${summary.remainingNullLinkCount}`,
      );
      console.log(
        `Remaining excluded-active mismatches after apply: ${summary.remainingExcludedActiveMismatchCount}`,
      );
    } else {
      const pending =
        summary.outcomes.length +
        summary.excludedActiveOutcomes.filter(
          (o) => o.action === 'would-suspend',
        ).length;
      console.log(
        `\nWould repair: ${pending} row(s), would fail: ${summary.failures.length}` +
          ' (dry-run; re-run with --apply to write)',
      );
      if (pending > 0 || summary.failures.length > 0) {
        console.log(
          'ACTION REQUIRED: inconsistencies exist; run with --apply after stopping old-version writers.',
        );
      }
    }

    const { exitCode, problems } = resolveRepairLinksExitCode(summary);
    if (flags.apply && exitCode !== 0) {
      console.error('\nRepair did NOT converge:');
      for (const problem of problems) {
        console.error(`  ! ${problem}`);
      }
      console.error(
        [
          'Possible causes: an old-version writer is still running and creating',
          'new null-link participants, a participant repair failed above, the',
          'linked account data is inconsistent (see failures), or excluded-active',
          'mismatches remain. Stop all old-version instances and re-run',
          '`pnpm trading-accounts:repair-links --apply`. The NOT NULL migration',
          'must NOT proceed until this command exits 0 with zero remaining rows.',
        ].join('\n'),
      );
    }

    if (flags.apply) {
      process.exitCode = exitCode;
    } else if (summary.failures.length > 0) {
      // Dry-run still fails loudly when integrity failures were detected —
      // those rows can never be auto-repaired and need investigation.
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.exitCode = 1;
    if (error instanceof Error) {
      console.error(
        `repair-missing-trading-account-links failed: ${error.message}`,
      );
      return;
    }

    console.error('repair-missing-trading-account-links failed.');
  });
}
