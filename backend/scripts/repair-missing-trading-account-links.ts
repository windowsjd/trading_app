import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { parseApplyDryRunFlags } from './lib/cli-flags';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';
import { repairMissingTradingAccountLinks } from './lib/repair-trading-account-links';

/**
 * Operational repair for the TradingAccount deploy boundary: season
 * participants created with tradingAccountId = null by an old-version writer.
 *
 * Safety contract:
 *  - Bare invocation is a DRY-RUN; writes require an explicit `--apply`.
 *  - Only the missing participant→account link is repaired (deterministic
 *    account id identical to the migration backfill). Wallets, ledgers,
 *    orders, positions, exchanges, and snapshots are never modified, and no
 *    general-mode account is ever created.
 *  - Already-linked participants are never touched; re-running is idempotent.
 *  - Never drops, truncates, deletes, or resets anything.
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
      `\nParticipants with tradingAccountId = null: ${summary.nullLinkCount}`,
    );

    for (const outcome of summary.outcomes) {
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
        `\nRepaired: ${summary.outcomes.length}, failed: ${summary.failures.length}`,
      );
      console.log(
        `Remaining null links after apply: ${summary.remainingNullLinkCount}`,
      );
    } else {
      console.log(
        `\nWould repair: ${summary.outcomes.length}, would fail: ${summary.failures.length}` +
          ' (dry-run; re-run with --apply to write)',
      );
    }

    if (summary.failures.length > 0) {
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
