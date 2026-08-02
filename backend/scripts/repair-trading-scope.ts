import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { parseApplyDryRunFlags } from './lib/cli-flags';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';
import {
  TRADING_SCOPE_MODELS,
  repairTradingScope,
  resolveTradingScopeExitCode,
} from './lib/repair-trading-scope';

/**
 * Operational backfill for trading rows (orders, positions, quotes) left
 * with tradingAccountId = null by an old-version writer after the
 * add_trading_scope_and_fx_legacy_partial_unique migration.
 *
 * Safety contract:
 *  - Bare invocation is a DRY-RUN; writes require an explicit `--apply`.
 *  - Only the null tradingAccountId column is filled from the row's
 *    participant link. No order status/amount/price/reservation, position
 *    quantity/average cost/PnL, quote status/hash/amount, id, or
 *    idempotency key is ever modified. No DROP/DELETE/TRUNCATE/reset.
 *  - Rows whose participant has no account link are reported
 *    (MISSING_PARTICIPANT_TRADING_ACCOUNT_LINK) and skipped — run
 *    `pnpm trading-accounts:repair-links --apply` FIRST.
 *  - Rows whose existing accountId mismatches the participant link are
 *    reported (TRADING_ACCOUNT_SCOPE_MISMATCH) and NEVER overwritten;
 *    order↔quote disagreements are reported
 *    (ORDER_QUOTE_ACCOUNT_SCOPE_MISMATCH) and never auto-adjusted; quotes
 *    with no participant are reported (QUOTE_PARTICIPANT_SCOPE_MISSING) and
 *    never guessed.
 *  - Re-running is idempotent. `--apply` exits non-zero unless the
 *    post-apply verification confirms ZERO remaining nulls and mismatches.
 *
 * Usage:
 *   pnpm trading-accounts:repair-trading-scope             # dry-run
 *   pnpm trading-accounts:repair-trading-scope --apply     # write
 */

async function main(argv: string[]) {
  const flags = parseApplyDryRunFlags(argv);
  loadRuntimeEnv();
  const databaseUrl = requireDatabaseUrl();

  console.log('=== repair-trading-scope ===');
  console.log(
    `Mode: ${flags.mode}${flags.apply ? ' (will write)' : ' (no writes)'}`,
  );
  console.log(`Target DB: ${formatDatabaseTarget(databaseUrl)}`);

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const summary = await repairTradingScope(prisma, {
      apply: flags.apply,
    });

    for (const model of TRADING_SCOPE_MODELS) {
      const m = summary.models[model];
      console.log(
        `\n[${model}] null scope rows: ${m.nullRowCount}, ` +
          `${flags.apply ? 'backfilled' : 'would backfill'}: ${m.backfilledCount}, ` +
          `blocked by missing participant link: ${m.missingParticipantLinkRows.length}, ` +
          `scope mismatches: ${m.mismatchCount}`,
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

    console.log(
      `\norder vs linked-quote account mismatches: ${summary.orderQuoteAccountMismatchCount}`,
    );
    console.log(
      `order vs linked-quote participant mismatches: ${summary.orderQuoteParticipantMismatchCount}`,
    );
    console.log(
      `quotes without a participant (never guessed): ${summary.quotesWithoutParticipantCount}`,
    );

    if (summary.failures.length > 0) {
      console.error(`\nFailures: ${summary.failures.length}`);
      for (const failure of summary.failures) {
        console.error(
          `  x [${failure.model}] ${failure.rowId ?? '-'} [${failure.code}] ${failure.message}`,
        );
      }
    }

    if (flags.apply && summary.remainingNullCounts) {
      console.log('\nRemaining after apply:');
      for (const model of TRADING_SCOPE_MODELS) {
        console.log(
          `  ${model}: null=${summary.remainingNullCounts[model]}, ` +
            `mismatch=${summary.remainingMismatchCounts?.[model]}`,
        );
      }
    }

    const missingLinkTotal = TRADING_SCOPE_MODELS.reduce(
      (sum, model) =>
        sum + summary.models[model].missingParticipantLinkRows.length,
      0,
    );
    if (missingLinkTotal > 0) {
      console.error(
        `\n${missingLinkTotal} row(s) are blocked because their participant has no` +
          ' trading account link. Run `pnpm trading-accounts:repair-links --apply`' +
          ' first (after stopping old-version writers), then re-run this command.',
      );
    }

    const { exitCode, problems } = resolveTradingScopeExitCode(summary);
    if (flags.apply && exitCode !== 0) {
      console.error('\nTrading scope repair did NOT converge:');
      for (const problem of problems) {
        console.error(`  ! ${problem}`);
      }
      console.error(
        [
          'Possible causes: an old-version writer is still creating unscoped',
          'orders/positions/quotes, participants still lack account links',
          '(repair-links first), or stored scope values mismatch (investigate',
          'before any overwrite). The trading NOT NULL tightening must NOT',
          'proceed until this command exits 0 with zero remaining rows.',
        ].join('\n'),
      );
      process.exitCode = 1;
    } else if (!flags.apply) {
      const pending = TRADING_SCOPE_MODELS.reduce(
        (sum, model) => sum + summary.models[model].backfilledCount,
        0,
      );
      console.log(
        `\nWould backfill: ${pending} row(s)` +
          ' (dry-run; re-run with --apply to write)',
      );
      if (summary.failures.length > 0) {
        // Mismatches can never be auto-repaired; surface them loudly even in
        // dry-run.
        process.exitCode = 1;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.exitCode = 1;
    if (error instanceof Error) {
      console.error(`repair-trading-scope failed: ${error.message}`);
      return;
    }

    console.error('repair-trading-scope failed.');
  });
}
