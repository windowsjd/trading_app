import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  auditGeneralAccounts,
  resolveGeneralAccountAuditExitCode,
} from './lib/audit-general-accounts';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';

/**
 * Read-only operational audit of general accounts and ad-reward payouts.
 *
 * There is NO `--apply` mode, by design: a damaged general account must never
 * be "repaired" by re-granting 10,000,000 KRW, creating a wallet, or
 * rewriting a ledger amount. Automatic financial correction of damaged data is
 * more dangerous than the damage; this reports and stops.
 *
 * Exit code 0 = nothing found, 1 = at least one finding to investigate.
 *
 * Usage:
 *   pnpm trading-accounts:audit-general
 */
async function main() {
  loadRuntimeEnv();
  const databaseUrl = requireDatabaseUrl();

  console.log('=== audit-general-accounts (READ-ONLY) ===');
  console.log(`Target DB: ${formatDatabaseTarget(databaseUrl)}`);

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const summary = await auditGeneralAccounts(prisma);

    console.log(`\ngeneral accounts: ${summary.generalAccountCount}`);
    console.log(
      `  with a SeasonParticipant attached: ${summary.accountsWithSeasonParticipant}`,
    );
    console.log(`  missing KRW wallet: ${summary.accountsMissingKrwWallet}`);
    console.log(`  missing USD wallet: ${summary.accountsMissingUsdWallet}`);
    console.log(`  duplicate wallets: ${summary.accountsWithDuplicateWallets}`);
    console.log(
      `  wrong initialCapitalKrw: ${summary.accountsWithWrongInitialCapital}`,
    );
    console.log(
      `  missing initial grant: ${summary.accountsMissingInitialGrant}`,
    );
    console.log(
      `  duplicate initial grant: ${summary.accountsWithDuplicateInitialGrant}`,
    );
    console.log(
      `  initial grant amount mismatch: ${summary.initialGrantsWithWrongAmount}`,
    );
    console.log(
      `general wallets with a season participant: ${summary.walletsWithSeasonParticipant}`,
    );
    console.log(
      `general ledger rows with a season participant: ${summary.ledgerRowsWithSeasonParticipant}`,
    );

    console.log('\nad rewards:');
    console.log(
      `  granted claims without a wallet transaction: ${summary.grantedClaimsWithoutWalletTransaction}`,
    );
    console.log(
      `  claim/ledger mismatches: ${summary.claimLedgerAmountMismatches}`,
    );
    console.log(
      `  ad_reward ledger rows without a claim: ${summary.adRewardLedgerRowsWithoutClaim}`,
    );
    console.log(
      `  duplicate (provider, providerEventId) groups: ${summary.duplicateProviderEventGroups}`,
    );

    console.log('\nperformance (작업 7):');
    console.log(
      `  accounts without a performance origin: ${summary.accountsWithoutPerformanceOrigin}`,
    );
    console.log(
      `  accounts with duplicate origins: ${summary.accountsWithDuplicatePerformanceOrigin}`,
    );
    console.log(
      `  general snapshots with a season participant: ${summary.generalSnapshotsWithSeasonParticipant}`,
    );
    console.log(
      `  snapshots with no scope at all: ${summary.generalSnapshotsWithoutAccountScope}`,
    );
    console.log(
      `  general snapshots missing performance values: ${summary.snapshotsMissingPerformanceValues}`,
    );
    console.log(
      `  investmentPnl mismatches: ${summary.snapshotsWithInvestmentPnlMismatch}`,
    );
    console.log(
      `  returnRate/factor mismatches: ${summary.snapshotsWithReturnRateMismatch}`,
    );
    console.log(
      `  negative factor or total: ${summary.snapshotsWithNegativeFactorOrTotal}`,
    );
    console.log(
      `  unpaired external_funding_before: ${summary.unpairedExternalFundingBefore}`,
    );
    console.log(
      `  unpaired external_funding_after: ${summary.unpairedExternalFundingAfter}`,
    );
    console.log(
      `  external-funding pair inconsistencies: ${summary.externalFundingPairInconsistencies}`,
    );
    console.log(
      `  keyed granted claims without a boundary pair: ${summary.keyedGrantedClaimsWithoutBoundaryPair}`,
    );
    console.log(
      `  duplicate (account, date) daily snapshots: ${summary.duplicateAccountDateDailySnapshots}`,
    );
    console.log(
      `  season snapshots without an account scope: ${summary.seasonSnapshotsWithoutAccountScope}`,
    );
    console.log(
      `  season snapshots with a scope mismatch: ${summary.seasonSnapshotsWithScopeMismatch}`,
    );

    if (summary.findings.length > 0) {
      console.error(`\nFindings: ${summary.findings.length}`);
      for (const finding of summary.findings.slice(0, 50)) {
        console.error(
          `  x [${finding.code}] account=${finding.tradingAccountId ?? '-'} ${finding.detail}`,
        );
      }
      if (summary.findings.length > 50) {
        console.error(`  ... ${summary.findings.length - 50} more omitted`);
      }
      console.error(
        '\nThis audit NEVER repairs data. Investigate each finding manually;' +
          ' re-calling the general-account open endpoint does not re-grant funds.',
      );
    } else {
      console.log('\nNo findings.');
    }

    process.exitCode = resolveGeneralAccountAuditExitCode(summary);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
