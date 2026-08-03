import type { PrismaClient } from '../../src/generated/prisma/client';

/**
 * READ-ONLY operational audit of general-mode accounts and ad-reward payouts
 * (작업 6).
 *
 * There is deliberately NO `--apply` counterpart. Re-granting the 10,000,000
 * KRW, creating a missing wallet, or "fixing" a mismatched amount by writing
 * to production money is far more dangerous than an operator reading a report
 * and deciding. This module therefore issues SELECT/aggregate queries only —
 * it never inserts, updates, or deletes anything.
 *
 * What it reports (all counts, never a repair):
 *  - general accounts, and those with a SeasonParticipant attached
 *  - missing/duplicate KRW or USD wallets
 *  - general wallets or ledger rows carrying a seasonParticipantId
 *  - missing / duplicate / wrong-amount initial grants
 *  - initialCapitalKrw values that are not the one-time 10,000,000 grant
 *  - granted claims without a wallet transaction
 *  - claim ↔ ledger amount mismatches, and ad_reward ledger rows with no claim
 *  - duplicate (provider, providerEventId) groups
 */

export const GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW = '10000000.00000000';

export type GeneralAccountAuditFinding = {
  code: string;
  tradingAccountId: string | null;
  detail: string;
};

export type GeneralAccountAuditSummary = {
  generalAccountCount: number;
  accountsWithSeasonParticipant: number;
  accountsMissingKrwWallet: number;
  accountsMissingUsdWallet: number;
  accountsWithDuplicateWallets: number;
  walletsWithSeasonParticipant: number;
  ledgerRowsWithSeasonParticipant: number;
  accountsMissingInitialGrant: number;
  accountsWithDuplicateInitialGrant: number;
  initialGrantsWithWrongAmount: number;
  accountsWithWrongInitialCapital: number;
  grantedClaimsWithoutWalletTransaction: number;
  claimLedgerAmountMismatches: number;
  adRewardLedgerRowsWithoutClaim: number;
  duplicateProviderEventGroups: number;
  findings: GeneralAccountAuditFinding[];
};

type Countable = { n: number | bigint };

const toNumber = (rows: Countable[]): number => Number(rows[0]?.n ?? 0);

export async function auditGeneralAccounts(
  prisma: PrismaClient,
): Promise<GeneralAccountAuditSummary> {
  const findings: GeneralAccountAuditFinding[] = [];
  const add = (
    code: string,
    tradingAccountId: string | null,
    detail: string,
  ) => {
    findings.push({ code, tradingAccountId, detail });
  };

  const generalAccounts = await prisma.tradingAccount.findMany({
    where: { mode: 'general' },
    select: {
      id: true,
      initialCapitalKrw: true,
      seasonParticipant: { select: { id: true } },
    },
    orderBy: { id: 'asc' },
  });

  let accountsWithSeasonParticipant = 0;
  let accountsMissingKrwWallet = 0;
  let accountsMissingUsdWallet = 0;
  let accountsWithDuplicateWallets = 0;
  let accountsMissingInitialGrant = 0;
  let accountsWithDuplicateInitialGrant = 0;
  let initialGrantsWithWrongAmount = 0;
  let accountsWithWrongInitialCapital = 0;

  for (const account of generalAccounts) {
    if (account.seasonParticipant) {
      accountsWithSeasonParticipant += 1;
      add(
        'GENERAL_ACCOUNT_HAS_SEASON_PARTICIPANT',
        account.id,
        `participant ${account.seasonParticipant.id} is attached to a general account`,
      );
    }

    if (
      account.initialCapitalKrw.toFixed(8) !==
      GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW
    ) {
      accountsWithWrongInitialCapital += 1;
      add(
        'GENERAL_ACCOUNT_INITIAL_CAPITAL_MISMATCH',
        account.id,
        `initialCapitalKrw=${account.initialCapitalKrw.toFixed(8)} (expected ${GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW})`,
      );
    }

    const wallets = await prisma.cashWallet.findMany({
      where: { tradingAccountId: account.id },
      select: { id: true, currencyCode: true, seasonParticipantId: true },
    });
    const krw = wallets.filter((w) => w.currencyCode === 'KRW');
    const usd = wallets.filter((w) => w.currencyCode === 'USD');

    if (krw.length === 0) {
      accountsMissingKrwWallet += 1;
      add('GENERAL_ACCOUNT_KRW_WALLET_MISSING', account.id, 'no KRW wallet');
    }
    if (usd.length === 0) {
      accountsMissingUsdWallet += 1;
      add('GENERAL_ACCOUNT_USD_WALLET_MISSING', account.id, 'no USD wallet');
    }
    if (krw.length > 1 || usd.length > 1) {
      accountsWithDuplicateWallets += 1;
      add(
        'GENERAL_ACCOUNT_DUPLICATE_WALLET',
        account.id,
        `KRW=${krw.length}, USD=${usd.length}`,
      );
    }

    const grants = await prisma.walletTransaction.findMany({
      where: {
        tradingAccountId: account.id,
        referenceType: 'general_account_open',
      },
      select: { id: true, amount: true, referenceId: true, walletId: true },
    });

    if (grants.length === 0) {
      accountsMissingInitialGrant += 1;
      add(
        'GENERAL_ACCOUNT_INITIAL_GRANT_MISSING',
        account.id,
        'no general_account_open ledger row',
      );
    }
    if (grants.length > 1) {
      accountsWithDuplicateInitialGrant += 1;
      add(
        'GENERAL_ACCOUNT_INITIAL_GRANT_DUPLICATE',
        account.id,
        `${grants.length} general_account_open ledger rows`,
      );
    }
    for (const grant of grants) {
      if (grant.amount.toFixed(8) !== GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW) {
        initialGrantsWithWrongAmount += 1;
        add(
          'GENERAL_ACCOUNT_INITIAL_GRANT_AMOUNT_MISMATCH',
          account.id,
          `ledger ${grant.id} amount=${grant.amount.toFixed(8)}`,
        );
      }
      if (grant.referenceId !== account.id) {
        add(
          'GENERAL_ACCOUNT_INITIAL_GRANT_REFERENCE_MISMATCH',
          account.id,
          `ledger ${grant.id} references ${grant.referenceId ?? 'null'}`,
        );
      }
      if (krw.length === 1 && grant.walletId !== krw[0].id) {
        add(
          'GENERAL_ACCOUNT_INITIAL_GRANT_WALLET_MISMATCH',
          account.id,
          `ledger ${grant.id} is not on the KRW wallet`,
        );
      }
    }
  }

  const generalAccountIds = generalAccounts.map((account) => account.id);

  const walletsWithSeasonParticipant =
    generalAccountIds.length === 0
      ? 0
      : await prisma.cashWallet.count({
          where: {
            tradingAccountId: { in: generalAccountIds },
            seasonParticipantId: { not: null },
          },
        });
  if (walletsWithSeasonParticipant > 0) {
    add(
      'GENERAL_WALLET_HAS_SEASON_PARTICIPANT',
      null,
      `${walletsWithSeasonParticipant} general wallet(s) carry a season participant link`,
    );
  }

  const ledgerRowsWithSeasonParticipant =
    generalAccountIds.length === 0
      ? 0
      : await prisma.walletTransaction.count({
          where: {
            tradingAccountId: { in: generalAccountIds },
            seasonParticipantId: { not: null },
          },
        });
  if (ledgerRowsWithSeasonParticipant > 0) {
    add(
      'GENERAL_LEDGER_HAS_SEASON_PARTICIPANT',
      null,
      `${ledgerRowsWithSeasonParticipant} general ledger row(s) carry a season participant link`,
    );
  }

  const grantedClaimsWithoutWalletTransaction =
    await prisma.adRewardClaim.count({
      where: { status: 'granted', walletTransactionId: null },
    });
  if (grantedClaimsWithoutWalletTransaction > 0) {
    add(
      'AD_REWARD_GRANTED_CLAIM_WITHOUT_LEDGER',
      null,
      `${grantedClaimsWithoutWalletTransaction} granted claim(s) have no wallet transaction`,
    );
  }

  const claimLedgerAmountMismatches = toNumber(
    await prisma.$queryRaw<Countable[]>`
      SELECT count(*)::int AS n
      FROM "ad_reward_claims" c
      JOIN "wallet_transactions" wt ON wt."id" = c."wallet_transaction_id"
      WHERE c."reward_amount_krw" <> wt."amount"
         OR wt."reference_id" IS DISTINCT FROM c."id"
         OR wt."reference_type" <> 'ad_reward_claim'
         OR wt."tx_type" <> 'ad_reward'
         OR wt."trading_account_id" IS DISTINCT FROM c."trading_account_id"
    `,
  );
  if (claimLedgerAmountMismatches > 0) {
    add(
      'AD_REWARD_CLAIM_LEDGER_MISMATCH',
      null,
      `${claimLedgerAmountMismatches} claim/ledger pair(s) disagree on amount, reference, type, or account`,
    );
  }

  const adRewardLedgerRowsWithoutClaim = toNumber(
    await prisma.$queryRaw<Countable[]>`
      SELECT count(*)::int AS n
      FROM "wallet_transactions" wt
      LEFT JOIN "ad_reward_claims" c ON c."id" = wt."reference_id"
      WHERE wt."tx_type" = 'ad_reward'
        AND c."id" IS NULL
    `,
  );
  if (adRewardLedgerRowsWithoutClaim > 0) {
    add(
      'AD_REWARD_LEDGER_WITHOUT_CLAIM',
      null,
      `${adRewardLedgerRowsWithoutClaim} ad_reward ledger row(s) have no matching claim`,
    );
  }

  const duplicateProviderEventGroups = toNumber(
    await prisma.$queryRaw<Countable[]>`
      SELECT count(*)::int AS n
      FROM (
        SELECT "provider", "provider_event_id"
        FROM "ad_reward_claims"
        GROUP BY "provider", "provider_event_id"
        HAVING count(*) > 1
      ) duplicates
    `,
  );
  if (duplicateProviderEventGroups > 0) {
    add(
      'AD_REWARD_DUPLICATE_PROVIDER_EVENT',
      null,
      `${duplicateProviderEventGroups} duplicate (provider, providerEventId) group(s)`,
    );
  }

  return {
    generalAccountCount: generalAccounts.length,
    accountsWithSeasonParticipant,
    accountsMissingKrwWallet,
    accountsMissingUsdWallet,
    accountsWithDuplicateWallets,
    walletsWithSeasonParticipant,
    ledgerRowsWithSeasonParticipant,
    accountsMissingInitialGrant,
    accountsWithDuplicateInitialGrant,
    initialGrantsWithWrongAmount,
    accountsWithWrongInitialCapital,
    grantedClaimsWithoutWalletTransaction,
    claimLedgerAmountMismatches,
    adRewardLedgerRowsWithoutClaim,
    duplicateProviderEventGroups,
    findings,
  };
}

/** 0 when the audit found nothing, 1 when any finding needs investigation. */
export function resolveGeneralAccountAuditExitCode(
  summary: GeneralAccountAuditSummary,
): number {
  return summary.findings.length > 0 ? 1 : 0;
}
