import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { parseApplyDryRunFlags } from './lib/cli-flags';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';
import {
  FINANCIAL_SCOPE_MODELS,
  repairFinancialTradingAccountScope,
  resolveFinancialScopeExitCode,
} from './lib/repair-financial-trading-account-scope';

/**
 * Operational backfill for financial rows (cash_wallets,
 * wallet_transactions, exchange_transactions, fx_execute_requests) left with
 * tradingAccountId = null by an old-version writer after the
 * add_financial_trading_account_scope migration.
 *
 * Safety contract:
 *  - Bare invocation is a DRY-RUN; writes require an explicit `--apply`.
 *  - Only the null tradingAccountId column is filled from the row's
 *    participant link. No amount, balance, reservation, fee, status, id, or
 *    idempotency key is ever modified. No DROP/DELETE/TRUNCATE/reset.
 *  - Rows whose participant has no account link are reported
 *    (MISSING_PARTICIPANT_TRADING_ACCOUNT_LINK) and skipped — run
 *    `pnpm trading-accounts:repair-links --apply` FIRST.
 *  - Rows whose existing accountId mismatches the participant link are
 *    reported (FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH) and NEVER
 *    overwritten.
 *  - Re-running is idempotent. `--apply` exits non-zero unless the
 *    post-apply verification confirms ZERO remaining nulls and mismatches.
 *
 * Usage:
 *   pnpm trading-accounts:repair-financial-scope             # dry-run
 *   pnpm trading-accounts:repair-financial-scope --apply     # write
 */

async function main(argv: string[]) {
  const flags = parseApplyDryRunFlags(argv);
  loadRuntimeEnv();
  const databaseUrl = requireDatabaseUrl();

  console.log('=== repair-financial-trading-account-scope ===');
  console.log(
    `Mode: ${flags.mode}${flags.apply ? ' (will write)' : ' (no writes)'}`,
  );
  console.log(`Target DB: ${formatDatabaseTarget(databaseUrl)}`);

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const summary = await repairFinancialTradingAccountScope(prisma, {
      apply: flags.apply,
    });

    for (const model of FINANCIAL_SCOPE_MODELS) {
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
      `\nwallet_transactions vs cash_wallets scope mismatches: ${summary.walletTransactionWalletMismatchCount}`,
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
      for (const model of FINANCIAL_SCOPE_MODELS) {
        console.log(
          `  ${model}: null=${summary.remainingNullCounts[model]}, ` +
            `mismatch=${summary.remainingMismatchCounts?.[model]}`,
        );
      }
    }

    const missingLinkTotal = FINANCIAL_SCOPE_MODELS.reduce(
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

    const { exitCode, problems } = resolveFinancialScopeExitCode(summary);
    if (flags.apply && exitCode !== 0) {
      console.error('\nFinancial scope repair did NOT converge:');
      for (const problem of problems) {
        console.error(`  ! ${problem}`);
      }
      console.error(
        [
          'Possible causes: an old-version writer is still creating unscoped',
          'financial rows, participants still lack account links (repair-links',
          'first), or stored scope values mismatch (investigate before any',
          'overwrite). The financial NOT NULL tightening must NOT proceed until',
          'this command exits 0 with zero remaining rows.',
        ].join('\n'),
      );
      process.exitCode = 1;
    } else if (!flags.apply) {
      const pending = FINANCIAL_SCOPE_MODELS.reduce(
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
      console.error(
        `repair-financial-trading-account-scope failed: ${error.message}`,
      );
      return;
    }

    console.error('repair-financial-trading-account-scope failed.');
  });
}
