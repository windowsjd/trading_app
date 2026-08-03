import { Prisma, type PrismaClient } from '../../src/generated/prisma/client';

/**
 * Performance-origin backfill for general accounts opened BEFORE 작업 7
 * (`pnpm trading-accounts:backfill-general-performance`).
 *
 * Migrations deliberately create no baseline, because inventing a starting
 * point silently rewrites a user's return history. This script does it
 * explicitly, only for accounts where the baseline is PROVABLY correct.
 *
 * WHY A 0% BASELINE IS SAFE HERE
 * ------------------------------
 * General-mode trading (orders, FX, positions) has never been enabled. An
 * eligible account therefore cannot have earned or lost anything: its total
 * assets must equal exactly the external funding it received. Under that
 * condition — and only that condition — investment PnL is 0 and a factor of 1
 * is the truth, not an assumption. The script verifies it row by row instead
 * of trusting it.
 *
 * Anything that does not fit is REPORTED and skipped; nothing is overwritten,
 * re-granted, or reconstructed. There is no `--force`.
 */

export const GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW = '10000000.00000000';

const ORIGIN_REASONS = [
  'general_account_open',
  'performance_baseline',
] as const;

export type BackfillFinding = {
  tradingAccountId: string;
  code: string;
  detail: string;
};

export type BackfillGeneralPerformanceSummary = {
  apply: boolean;
  generalAccountCount: number;
  alreadyInitialized: number;
  eligible: number;
  created: number;
  skipped: number;
  findings: BackfillFinding[];
  remainingWithoutOrigin?: number;
};

export async function backfillGeneralPerformance(
  prisma: PrismaClient,
  options: { apply: boolean; now: Date },
): Promise<BackfillGeneralPerformanceSummary> {
  const summary: BackfillGeneralPerformanceSummary = {
    apply: options.apply,
    generalAccountCount: 0,
    alreadyInitialized: 0,
    eligible: 0,
    created: 0,
    skipped: 0,
    findings: [],
  };

  const accounts = await prisma.tradingAccount.findMany({
    where: { mode: 'general' },
    select: {
      id: true,
      initialCapitalKrw: true,
      openedAt: true,
      seasonParticipant: { select: { id: true } },
    },
    orderBy: { id: 'asc' },
  });
  summary.generalAccountCount = accounts.length;

  for (const account of accounts) {
    const add = (code: string, detail: string) => {
      summary.findings.push({ tradingAccountId: account.id, code, detail });
      summary.skipped += 1;
    };

    const snapshotCount = await prisma.equitySnapshot.count({
      where: { tradingAccountId: account.id },
    });
    const originCount = await prisma.equitySnapshot.count({
      where: {
        tradingAccountId: account.id,
        snapshotReason: { in: [...ORIGIN_REASONS] },
      },
    });

    if (originCount === 1) {
      summary.alreadyInitialized += 1;
      continue;
    }
    if (originCount > 1) {
      add(
        'GENERAL_PERFORMANCE_PARTIAL_STATE',
        `${originCount} origin snapshots already exist`,
      );
      continue;
    }
    if (snapshotCount > 0) {
      // Snapshots but no origin: a partially written history. Adding a
      // baseline now would sit AFTER rows it is supposed to precede.
      add(
        'GENERAL_PERFORMANCE_PARTIAL_STATE',
        `${snapshotCount} snapshot(s) exist without an origin`,
      );
      continue;
    }

    if (account.seasonParticipant) {
      add(
        'GENERAL_PERFORMANCE_FINANCIAL_INTEGRITY',
        'general account has a season participant attached',
      );
      continue;
    }
    if (
      !account.initialCapitalKrw.equals(
        new Prisma.Decimal(GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW),
      )
    ) {
      add(
        'GENERAL_PERFORMANCE_FINANCIAL_INTEGRITY',
        `initialCapitalKrw=${account.initialCapitalKrw.toFixed(8)}`,
      );
      continue;
    }

    // General trading must still be disabled for this account: any trading row
    // means the 0% baseline assumption below is not verifiable.
    const [orders, positions, exchanges, fxRequests] = await Promise.all([
      prisma.order.count({ where: { tradingAccountId: account.id } }),
      prisma.position.count({ where: { tradingAccountId: account.id } }),
      prisma.exchangeTransaction.count({
        where: { tradingAccountId: account.id },
      }),
      prisma.fxExecuteRequest.count({
        where: { tradingAccountId: account.id },
      }),
    ]);
    if (orders || positions || exchanges || fxRequests) {
      add(
        'GENERAL_PERFORMANCE_HISTORY_UNRECONSTRUCTABLE',
        `account has trading rows (orders=${orders}, positions=${positions}, exchanges=${exchanges}, fxRequests=${fxRequests}); a 0% baseline cannot be justified`,
      );
      continue;
    }

    const wallets = await prisma.cashWallet.findMany({
      where: { tradingAccountId: account.id },
      select: {
        id: true,
        currencyCode: true,
        seasonParticipantId: true,
        balanceAmount: true,
        reservedAmount: true,
      },
    });
    const krw = wallets.filter((w) => w.currencyCode === 'KRW');
    const usd = wallets.filter((w) => w.currencyCode === 'USD');
    if (
      krw.length !== 1 ||
      usd.length !== 1 ||
      wallets.length !== 2 ||
      wallets.some((w) => w.seasonParticipantId !== null)
    ) {
      add(
        'GENERAL_PERFORMANCE_FINANCIAL_INTEGRITY',
        `unexpected wallets (KRW=${krw.length}, USD=${usd.length}, total=${wallets.length})`,
      );
      continue;
    }
    if (wallets.some((w) => w.balanceAmount.lt(0))) {
      add('GENERAL_PERFORMANCE_FINANCIAL_INTEGRITY', 'negative wallet balance');
      continue;
    }

    // Cumulative external funding from the two allowed ledger shapes only.
    const ledger = await prisma.walletTransaction.findMany({
      where: { tradingAccountId: account.id },
      select: {
        id: true,
        txType: true,
        referenceType: true,
        referenceId: true,
        direction: true,
        currencyCode: true,
        amount: true,
        walletId: true,
      },
    });

    let externalFunding = new Prisma.Decimal(0);
    let unexpected = 0;
    for (const row of ledger) {
      const isInitialGrant =
        row.txType === 'initial_grant' &&
        row.referenceType === 'general_account_open' &&
        row.referenceId === account.id;
      const isAdReward =
        row.txType === 'ad_reward' && row.referenceType === 'ad_reward_claim';

      if (
        (!isInitialGrant && !isAdReward) ||
        row.direction !== 'credit' ||
        row.currencyCode !== 'KRW' ||
        row.walletId !== krw[0].id
      ) {
        unexpected += 1;
        continue;
      }
      externalFunding = externalFunding.add(row.amount);
    }
    if (unexpected > 0) {
      add(
        'GENERAL_PERFORMANCE_HISTORY_UNRECONSTRUCTABLE',
        `${unexpected} ledger row(s) are not recognised external funding; the baseline cannot be derived`,
      );
      continue;
    }

    // Every ad claim must be consistent with its ledger row.
    const claims = await prisma.adRewardClaim.findMany({
      where: { tradingAccountId: account.id },
      select: {
        id: true,
        status: true,
        rewardAmountKrw: true,
        walletTransactionId: true,
      },
    });
    const badClaims = claims.filter((claim) =>
      claim.status === 'granted'
        ? !claim.walletTransactionId
        : Boolean(claim.walletTransactionId),
    );
    if (badClaims.length > 0) {
      add(
        'GENERAL_PERFORMANCE_FINANCIAL_INTEGRITY',
        `${badClaims.length} ad reward claim(s) disagree with their ledger link`,
      );
      continue;
    }

    // The decisive condition: with trading disabled, total assets MUST equal
    // the external funding received. Cash only, so no price/FX lookup is
    // involved and the comparison is exact.
    const totalAsset = krw[0].balanceAmount.add(usd[0].balanceAmount);
    if (!usd[0].balanceAmount.isZero()) {
      add(
        'GENERAL_PERFORMANCE_HISTORY_UNRECONSTRUCTABLE',
        'account holds USD cash, which cannot exist without FX; the baseline cannot be derived',
      );
      continue;
    }
    if (!totalAsset.equals(externalFunding)) {
      add(
        'GENERAL_PERFORMANCE_HISTORY_UNRECONSTRUCTABLE',
        `total assets ${totalAsset.toFixed(8)} != external funding ${externalFunding.toFixed(8)}; investment PnL is non-zero and the history cannot be reconstructed`,
      );
      continue;
    }

    summary.eligible += 1;
    if (!options.apply) {
      continue;
    }

    await prisma.equitySnapshot.create({
      data: {
        seasonParticipantId: null,
        tradingAccountId: account.id,
        totalAssetKrw: totalAsset.toFixed(8),
        returnRate: '0',
        krwCash: krw[0].balanceAmount.toFixed(8),
        usdCashKrw: '0',
        domesticStockValueKrw: '0',
        usStockValueKrw: '0',
        cryptoValueKrw: '0',
        snapshotReason: 'performance_baseline',
        cumulativeExternalFundingKrw: externalFunding.toFixed(8),
        investmentPnlKrw: '0',
        timeWeightedReturnFactor: '1',
        // A baseline is NOT an external-funding boundary; the reference
        // columns stay null so it never collides with a real boundary pair.
        externalFundingAmountKrw: null,
        externalFundingReferenceType: null,
        externalFundingReferenceId: null,
        capturedAt: options.now,
      },
      select: { id: true },
    });
    summary.created += 1;
  }

  if (options.apply) {
    const withoutOrigin = await prisma.tradingAccount.count({
      where: {
        mode: 'general',
        equitySnapshots: {
          none: { snapshotReason: { in: [...ORIGIN_REASONS] } },
        },
      },
    });
    summary.remainingWithoutOrigin = withoutOrigin;
  }

  return summary;
}

/** Non-zero while anything was skipped or left without an origin. */
export function resolveBackfillExitCode(
  summary: BackfillGeneralPerformanceSummary,
): number {
  if (summary.findings.length > 0) return 1;
  if (!summary.apply) return 0;
  return (summary.remainingWithoutOrigin ?? 0) > 0 ? 1 : 0;
}
