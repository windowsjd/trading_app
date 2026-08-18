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
 *  - (작업 7) performance origin presence/uniqueness, general snapshots with a
 *    participant link or no account scope, missing performance columns,
 *    investment-PnL and factor/returnRate disagreement, negative factor or
 *    total, unpaired or inconsistent external-funding before/after pairs,
 *    keyed granted claims with no boundary pair, duplicate account/date daily
 *    rows, and season snapshots left unscoped or mis-scoped
 *  - (작업 6·7 보완) accounts whose newest state is an unpaired "before" row,
 *    ledger-vs-snapshot cumulative external funding mismatches, the before /
 *    after halves of a missing boundary reported SEPARATELY, each boundary
 *    invariant (amount, account scope, factor/returnRate, investment PnL,
 *    after-total) reported on its own, general daily rows polluted with a
 *    participant or missing performance columns, and daily rows written to a
 *    closed general account
 *  - general Order/Position/Quote participant and account-scope pollution,
 *    missing durable quotes, invalid sell-side reservation evidence, invalid
 *    Position reservation bounds, and account+asset reservation mismatches
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
  // ---- general trading checks ----
  generalOrdersWithSeasonParticipant: number;
  generalOrdersWithoutDurableQuote: number;
  generalOrderQuoteAccountMismatches: number;
  generalPositionsWithSeasonParticipant: number;
  generalPositionsWithInvalidReservation: number;
  duplicateGeneralPositionAccountAssetGroups: number;
  generalQuotesWithSeasonParticipant: number;
  invalidGeneralSellReservations: number;
  generalPositionReservationMismatches: number;
  // ---- 작업 7 performance checks ----
  accountsWithoutPerformanceOrigin: number;
  accountsWithDuplicatePerformanceOrigin: number;
  generalSnapshotsWithSeasonParticipant: number;
  generalSnapshotsWithoutAccountScope: number;
  snapshotsMissingPerformanceValues: number;
  snapshotsWithInvestmentPnlMismatch: number;
  snapshotsWithReturnRateMismatch: number;
  snapshotsWithNegativeFactorOrTotal: number;
  unpairedExternalFundingBefore: number;
  unpairedExternalFundingAfter: number;
  externalFundingPairInconsistencies: number;
  keyedGrantedClaimsWithoutBoundaryPair: number;
  duplicateAccountDateDailySnapshots: number;
  seasonSnapshotsWithoutAccountScope: number;
  seasonSnapshotsWithScopeMismatch: number;
  // ---- 작업 6·7 보완 checks ----
  accountsWithLatestSnapshotBefore: number;
  accountsWithExternalFundingDiscontinuity: number;
  keyedGrantedClaimsWithoutBoundaryBefore: number;
  keyedGrantedClaimsWithoutBoundaryAfter: number;
  boundaryPairsWithAmountMismatch: number;
  boundaryPairsWithAccountScopeMismatch: number;
  boundaryPairsWithFactorMismatch: number;
  boundaryPairsWithInvestmentPnlMismatch: number;
  boundaryPairsWithTotalAssetMismatch: number;
  generalDailySnapshotsWithSeasonParticipant: number;
  generalDailySnapshotsMissingPerformanceValues: number;
  dailySnapshotsOnClosedAccounts: number;
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

  const trading = await auditGeneralTrading(prisma, add);

  // ------------------------------------------------------------ 작업 7
  const performance = await auditGeneralPerformance(prisma, add);

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
    ...trading,
    ...performance,
    findings,
  };
}

type TradingAuditRow = {
  id: string;
  tradingAccountId: string | null;
  detail: string;
};

/**
 * General trading audit. Every query is SELECT-only and mirrors invariants
 * enforced by assertGeneralAccountTradingRowsIntegrity plus the current
 * full-fill-only limit-sell reservation lifecycle.
 */
async function auditGeneralTrading(
  prisma: PrismaClient,
  add: (code: string, tradingAccountId: string | null, detail: string) => void,
) {
  const reportRows = (rows: TradingAuditRow[], code: string): number => {
    for (const row of rows) {
      add(code, row.tradingAccountId, `${row.id}: ${row.detail}`);
    }
    return rows.length;
  };

  const generalOrdersWithSeasonParticipant = reportRows(
    await prisma.$queryRaw<TradingAuditRow[]>`
      SELECT
        o."id",
        coalesce(o."trading_account_id", q."trading_account_id") AS "tradingAccountId",
        'seasonParticipantId=' || o."season_participant_id" AS "detail"
      FROM "orders" o
      LEFT JOIN "quotes" q ON q."id" = o."quote_id"
      LEFT JOIN "trading_accounts" oa ON oa."id" = o."trading_account_id"
      LEFT JOIN "trading_accounts" qa ON qa."id" = q."trading_account_id"
      WHERE o."season_participant_id" IS NOT NULL
        AND (oa."mode" = 'general' OR qa."mode" = 'general')
      ORDER BY o."id"
    `,
    'GENERAL_ORDER_HAS_SEASON_PARTICIPANT',
  );

  const generalOrdersWithoutDurableQuote = reportRows(
    await prisma.$queryRaw<TradingAuditRow[]>`
      SELECT
        o."id",
        o."trading_account_id" AS "tradingAccountId",
        'durable quote is missing' AS "detail"
      FROM "orders" o
      JOIN "trading_accounts" a ON a."id" = o."trading_account_id"
      LEFT JOIN "quotes" q ON q."id" = o."quote_id"
      WHERE a."mode" = 'general'
        AND (o."quote_id" IS NULL OR q."id" IS NULL)
      ORDER BY o."id"
    `,
    'GENERAL_ORDER_DURABLE_QUOTE_MISSING',
  );

  const generalOrderQuoteAccountMismatches = reportRows(
    await prisma.$queryRaw<TradingAuditRow[]>`
      SELECT
        o."id",
        coalesce(o."trading_account_id", q."trading_account_id") AS "tradingAccountId",
        'orderAccount=' || coalesce(o."trading_account_id", 'null')
          || ', quote=' || coalesce(q."id", 'null')
          || ', quoteAccount=' || coalesce(q."trading_account_id", 'null') AS "detail"
      FROM "orders" o
      JOIN "quotes" q ON q."id" = o."quote_id"
      LEFT JOIN "trading_accounts" oa ON oa."id" = o."trading_account_id"
      LEFT JOIN "trading_accounts" qa ON qa."id" = q."trading_account_id"
      WHERE (oa."mode" = 'general' OR qa."mode" = 'general')
        AND q."trading_account_id" IS DISTINCT FROM o."trading_account_id"
      ORDER BY o."id"
    `,
    'GENERAL_ORDER_QUOTE_ACCOUNT_MISMATCH',
  );

  const generalPositionsWithSeasonParticipant = reportRows(
    await prisma.$queryRaw<TradingAuditRow[]>`
      SELECT
        p."id",
        p."trading_account_id" AS "tradingAccountId",
        'seasonParticipantId=' || p."season_participant_id" AS "detail"
      FROM "positions" p
      JOIN "trading_accounts" a ON a."id" = p."trading_account_id"
      WHERE a."mode" = 'general'
        AND p."season_participant_id" IS NOT NULL
      ORDER BY p."id"
    `,
    'GENERAL_POSITION_HAS_SEASON_PARTICIPANT',
  );

  const generalPositionsWithInvalidReservation = reportRows(
    await prisma.$queryRaw<TradingAuditRow[]>`
      SELECT
        p."id",
        p."trading_account_id" AS "tradingAccountId",
        'quantity=' || p."quantity"::text
          || ', reservedQuantity=' || p."reserved_quantity"::text AS "detail"
      FROM "positions" p
      JOIN "trading_accounts" a ON a."id" = p."trading_account_id"
      WHERE a."mode" = 'general'
        AND (p."reserved_quantity" < 0 OR p."reserved_quantity" > p."quantity")
      ORDER BY p."id"
    `,
    'GENERAL_POSITION_RESERVATION_INVALID',
  );

  const duplicateGeneralPositionAccountAssetGroups = reportRows(
    await prisma.$queryRaw<TradingAuditRow[]>`
      SELECT
        min(p."id") AS "id",
        p."trading_account_id" AS "tradingAccountId",
        'assetId=' || p."asset_id" || ', rows=' || count(*)::text AS "detail"
      FROM "positions" p
      JOIN "trading_accounts" a ON a."id" = p."trading_account_id"
      WHERE a."mode" = 'general'
      GROUP BY p."trading_account_id", p."asset_id"
      HAVING count(*) > 1
      ORDER BY p."trading_account_id", p."asset_id"
    `,
    'GENERAL_POSITION_ACCOUNT_ASSET_DUPLICATE',
  );

  const generalQuotesWithSeasonParticipant = reportRows(
    await prisma.$queryRaw<TradingAuditRow[]>`
      SELECT
        q."id",
        coalesce(q."trading_account_id", o."trading_account_id") AS "tradingAccountId",
        'seasonParticipantId=' || q."season_participant_id" AS "detail"
      FROM "quotes" q
      LEFT JOIN "orders" o ON o."quote_id" = q."id"
      LEFT JOIN "trading_accounts" qa ON qa."id" = q."trading_account_id"
      LEFT JOIN "trading_accounts" oa ON oa."id" = o."trading_account_id"
      WHERE q."season_participant_id" IS NOT NULL
        AND (qa."mode" = 'general' OR oa."mode" = 'general')
      ORDER BY q."id"
    `,
    'GENERAL_QUOTE_HAS_SEASON_PARTICIPANT',
  );

  const invalidGeneralSellReservations = reportRows(
    await prisma.$queryRaw<TradingAuditRow[]>`
      SELECT
        o."id",
        o."trading_account_id" AS "tradingAccountId",
        'status=' || o."status"::text
          || ', quantity=' || o."quantity"::text
          || ', reservedQuantity=' || coalesce(o."reserved_quantity"::text, 'null')
          || ', reservedAmount=' || coalesce(o."reserved_amount"::text, 'null')
          || ', releasedAt=' || coalesce(o."reservation_released_at"::text, 'null') AS "detail"
      FROM "orders" o
      JOIN "trading_accounts" a ON a."id" = o."trading_account_id"
      WHERE a."mode" = 'general'
        AND o."order_type" = 'limit'
        AND o."side" = 'sell'
        AND (
          (
            o."status" = 'submitted'
            AND (
              o."reserved_quantity" IS NULL
              OR o."reserved_quantity" <= 0
              OR o."reserved_quantity" IS DISTINCT FROM o."quantity"
              OR o."reserved_amount" IS NOT NULL
              OR o."reservation_released_at" IS NOT NULL
            )
          )
          OR (
            o."status" IN ('executed', 'canceled')
            AND o."reservation_released_at" IS NULL
          )
        )
      ORDER BY o."id"
    `,
    'GENERAL_LIMIT_SELL_RESERVATION_INVALID',
  );

  const generalPositionReservationMismatches = reportRows(
    await prisma.$queryRaw<TradingAuditRow[]>`
      WITH live_sell AS (
        SELECT
          o."trading_account_id" AS account_id,
          o."asset_id" AS asset_id,
          coalesce(sum(o."reserved_quantity"), 0) AS reserved_quantity
        FROM "orders" o
        JOIN "trading_accounts" a ON a."id" = o."trading_account_id"
        WHERE a."mode" = 'general'
          AND o."order_type" = 'limit'
          AND o."side" = 'sell'
          AND o."status" = 'submitted'
        GROUP BY o."trading_account_id", o."asset_id"
      ),
      general_position AS (
        SELECT p."id", p."trading_account_id", p."asset_id", p."reserved_quantity"
        FROM "positions" p
        JOIN "trading_accounts" a ON a."id" = p."trading_account_id"
        WHERE a."mode" = 'general'
      )
      SELECT
        coalesce(p."id", 'missing-position:' || l.account_id || ':' || l.asset_id) AS "id",
        coalesce(p."trading_account_id", l.account_id) AS "tradingAccountId",
        'assetId=' || coalesce(p."asset_id", l.asset_id)
          || ', positionReserved=' || coalesce(p."reserved_quantity", 0)::text
          || ', liveSellReserved=' || coalesce(l.reserved_quantity, 0)::text AS "detail"
      FROM general_position p
      FULL OUTER JOIN live_sell l
        ON l.account_id = p."trading_account_id" AND l.asset_id = p."asset_id"
      WHERE coalesce(p."reserved_quantity", 0)
        IS DISTINCT FROM coalesce(l.reserved_quantity, 0)
      ORDER BY "tradingAccountId", "id"
    `,
    'GENERAL_POSITION_RESERVATION_MISMATCH',
  );

  return {
    generalOrdersWithSeasonParticipant,
    generalOrdersWithoutDurableQuote,
    generalOrderQuoteAccountMismatches,
    generalPositionsWithSeasonParticipant,
    generalPositionsWithInvalidReservation,
    duplicateGeneralPositionAccountAssetGroups,
    generalQuotesWithSeasonParticipant,
    invalidGeneralSellReservations,
    generalPositionReservationMismatches,
  };
}

/**
 * Performance-state audit (작업 7). Every check is a counting query; nothing
 * is repaired, recomputed, or written.
 */
async function auditGeneralPerformance(
  prisma: PrismaClient,
  add: (code: string, tradingAccountId: string | null, detail: string) => void,
) {
  const q = async (sql: Promise<Array<{ n: number | bigint }>>) =>
    Number((await sql)[0]?.n ?? 0);
  const report = (count: number, code: string, detail: string) => {
    if (count > 0) add(code, null, detail);
    return count;
  };

  const accountsWithoutPerformanceOrigin = report(
    await prisma.tradingAccount.count({
      where: {
        mode: 'general',
        equitySnapshots: {
          none: {
            snapshotReason: {
              in: ['general_account_open', 'performance_baseline'],
            },
          },
        },
      },
    }),
    'GENERAL_PERFORMANCE_ORIGIN_MISSING',
    'general account(s) have no performance origin snapshot',
  );

  const accountsWithDuplicatePerformanceOrigin = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n FROM (
        SELECT "trading_account_id"
        FROM "equity_snapshots"
        WHERE "snapshot_reason" IN ('general_account_open', 'performance_baseline')
        GROUP BY "trading_account_id"
        HAVING count(*) > 1
      ) d
    `),
    'GENERAL_PERFORMANCE_ORIGIN_DUPLICATE',
    'account(s) have more than one performance origin snapshot',
  );

  const generalSnapshotsWithSeasonParticipant = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "equity_snapshots" s
      JOIN "trading_accounts" a ON a."id" = s."trading_account_id"
      WHERE a."mode" = 'general' AND s."season_participant_id" IS NOT NULL
    `),
    'GENERAL_SNAPSHOT_HAS_SEASON_PARTICIPANT',
    'general equity snapshot(s) carry a season participant link',
  );

  const generalSnapshotsWithoutAccountScope = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "equity_snapshots"
      WHERE "season_participant_id" IS NULL AND "trading_account_id" IS NULL
    `),
    'GENERAL_SNAPSHOT_SCOPE_MISSING',
    'snapshot(s) have neither a participant nor an account scope',
  );

  const snapshotsMissingPerformanceValues = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "equity_snapshots"
      WHERE "season_participant_id" IS NULL
        AND (
          "cumulative_external_funding_krw" IS NULL
          OR "investment_pnl_krw" IS NULL
          OR "time_weighted_return_factor" IS NULL
        )
    `),
    'GENERAL_SNAPSHOT_PERFORMANCE_VALUES_MISSING',
    'general snapshot(s) are missing performance columns',
  );

  const snapshotsWithInvestmentPnlMismatch = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "equity_snapshots"
      WHERE "season_participant_id" IS NULL
        AND "investment_pnl_krw" IS NOT NULL
        AND "cumulative_external_funding_krw" IS NOT NULL
        AND "investment_pnl_krw"
            <> ("total_asset_krw" - "cumulative_external_funding_krw")
    `),
    'GENERAL_SNAPSHOT_INVESTMENT_PNL_MISMATCH',
    'general snapshot(s) where investmentPnl != totalAsset - externalFunding',
  );

  const snapshotsWithReturnRateMismatch = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "equity_snapshots"
      WHERE "season_participant_id" IS NULL
        AND "time_weighted_return_factor" IS NOT NULL
        AND round(("time_weighted_return_factor" - 1) * 100, 8) <> "return_rate"
    `),
    'GENERAL_SNAPSHOT_RETURN_RATE_MISMATCH',
    'general snapshot(s) whose returnRate disagrees with their TWR factor',
  );

  const snapshotsWithNegativeFactorOrTotal = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "equity_snapshots"
      WHERE "total_asset_krw" < 0
         OR ("time_weighted_return_factor" IS NOT NULL AND "time_weighted_return_factor" < 0)
    `),
    'GENERAL_SNAPSHOT_NEGATIVE_VALUE',
    'snapshot(s) with a negative total asset or TWR factor',
  );

  const unpairedExternalFundingBefore = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "equity_snapshots" b
      WHERE b."snapshot_reason" = 'external_funding_before'
        AND NOT EXISTS (
          SELECT 1 FROM "equity_snapshots" a
          WHERE a."snapshot_reason" = 'external_funding_after'
            AND a."trading_account_id" = b."trading_account_id"
            AND a."external_funding_reference_id" = b."external_funding_reference_id"
        )
    `),
    'EXTERNAL_FUNDING_BEFORE_UNPAIRED',
    'external_funding_before snapshot(s) with no matching after row',
  );

  const unpairedExternalFundingAfter = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "equity_snapshots" a
      WHERE a."snapshot_reason" = 'external_funding_after'
        AND NOT EXISTS (
          SELECT 1 FROM "equity_snapshots" b
          WHERE b."snapshot_reason" = 'external_funding_before'
            AND b."trading_account_id" = a."trading_account_id"
            AND b."external_funding_reference_id" = a."external_funding_reference_id"
        )
    `),
    'EXTERNAL_FUNDING_AFTER_UNPAIRED',
    'external_funding_after snapshot(s) with no matching before row',
  );

  // The four invariants that make an inflow performance-neutral.
  const externalFundingPairInconsistencies = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "equity_snapshots" b
      JOIN "equity_snapshots" a
        ON a."trading_account_id" = b."trading_account_id"
       AND a."external_funding_reference_id" = b."external_funding_reference_id"
       AND a."snapshot_reason" = 'external_funding_after'
      WHERE b."snapshot_reason" = 'external_funding_before'
        AND (
          a."external_funding_amount_krw" <> b."external_funding_amount_krw"
          OR (a."total_asset_krw" - b."total_asset_krw") <> b."external_funding_amount_krw"
          OR (a."cumulative_external_funding_krw" - b."cumulative_external_funding_krw") <> b."external_funding_amount_krw"
          OR a."investment_pnl_krw" <> b."investment_pnl_krw"
          OR a."time_weighted_return_factor" <> b."time_weighted_return_factor"
          OR a."return_rate" <> b."return_rate"
        )
    `),
    'EXTERNAL_FUNDING_PAIR_INCONSISTENT',
    'external-funding pair(s) violate the neutrality invariants',
  );

  const keyedGrantedClaimsWithoutBoundaryPair = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "ad_reward_claims" c
      WHERE c."status" = 'granted'
        AND c."idempotency_key" IS NOT NULL
        AND (
          NOT EXISTS (
            SELECT 1 FROM "equity_snapshots" s
            WHERE s."external_funding_reference_id" = c."id"
              AND s."snapshot_reason" = 'external_funding_before'
          )
          OR NOT EXISTS (
            SELECT 1 FROM "equity_snapshots" s
            WHERE s."external_funding_reference_id" = c."id"
              AND s."snapshot_reason" = 'external_funding_after'
          )
        )
    `),
    'AD_REWARD_CLAIM_BOUNDARY_MISSING',
    'keyed granted claim(s) have no complete external-funding boundary pair',
  );

  const duplicateAccountDateDailySnapshots = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n FROM (
        SELECT "trading_account_id", "snapshot_date"
        FROM "daily_portfolio_snapshots"
        WHERE "trading_account_id" IS NOT NULL
        GROUP BY "trading_account_id", "snapshot_date"
        HAVING count(*) > 1
      ) d
    `),
    'DAILY_SNAPSHOT_ACCOUNT_DATE_DUPLICATE',
    'duplicate (account, date) daily snapshot group(s)',
  );

  // ------------------------------------------------------ 작업 6·7 보완
  //
  // `latest` uses the SAME phase rank the runtime does: within one capturedAt
  // an `after` row is the committed end state, a `before` row is the transient
  // one, and neither is decided by a UUID. Keeping the two definitions
  // identical is the point — an audit that ranked rows differently from the
  // service would report healthy accounts as broken and vice versa.
  const latestSnapshotCte = `
    SELECT DISTINCT ON (s."trading_account_id")
      s."trading_account_id" AS account_id,
      s."snapshot_reason" AS reason,
      s."cumulative_external_funding_krw" AS cumulative_funding
    FROM "equity_snapshots" s
    JOIN "trading_accounts" a ON a."id" = s."trading_account_id"
    WHERE a."mode" = 'general'
    ORDER BY
      s."trading_account_id",
      s."captured_at" DESC,
      CASE s."snapshot_reason"
        WHEN 'external_funding_after' THEN 2
        WHEN 'external_funding_before' THEN 0
        ELSE 1
      END DESC,
      s."created_at" DESC,
      s."id" DESC
  `;

  const accountsWithLatestSnapshotBefore = report(
    await q(
      prisma.$queryRawUnsafe(`
      WITH latest AS (${latestSnapshotCte})
      SELECT count(*)::int AS n
      FROM latest
      WHERE reason = 'external_funding_before'
    `),
    ),
    'GENERAL_PERFORMANCE_LATEST_IS_BEFORE',
    'general account(s) whose newest performance state is an unpaired external-funding "before" row',
  );

  const accountsWithExternalFundingDiscontinuity = report(
    await q(
      prisma.$queryRawUnsafe(`
      WITH latest AS (${latestSnapshotCte}),
      funding AS (
        SELECT "trading_account_id" AS account_id, sum("amount") AS total
        FROM "wallet_transactions"
        WHERE "direction" = 'credit'
          AND (
            ("tx_type" = 'initial_grant' AND "reference_type" = 'general_account_open')
            OR ("tx_type" = 'ad_reward' AND "reference_type" = 'ad_reward_claim')
          )
        GROUP BY "trading_account_id"
      )
      SELECT count(*)::int AS n
      FROM latest l
      LEFT JOIN funding f ON f.account_id = l.account_id
      WHERE l.cumulative_funding IS DISTINCT FROM coalesce(f.total, 0)
    `),
    ),
    'GENERAL_PERFORMANCE_EXTERNAL_FUNDING_MISMATCH',
    'general account(s) whose newest snapshot cumulative external funding disagrees with the ledger total',
  );

  const keyedGrantedClaimsWithoutBoundaryBefore = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "ad_reward_claims" c
      WHERE c."status" = 'granted'
        AND c."idempotency_key" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "equity_snapshots" s
          WHERE s."external_funding_reference_id" = c."id"
            AND s."snapshot_reason" = 'external_funding_before'
        )
    `),
    'AD_REWARD_CLAIM_BOUNDARY_BEFORE_MISSING',
    'keyed granted claim(s) have no external-funding "before" snapshot',
  );

  const keyedGrantedClaimsWithoutBoundaryAfter = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "ad_reward_claims" c
      WHERE c."status" = 'granted'
        AND c."idempotency_key" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "equity_snapshots" s
          WHERE s."external_funding_reference_id" = c."id"
            AND s."snapshot_reason" = 'external_funding_after'
        )
    `),
    'AD_REWARD_CLAIM_BOUNDARY_AFTER_MISSING',
    'keyed granted claim(s) have no external-funding "after" snapshot',
  );

  // The pair invariants, reported ONE BY ONE. The combined
  // EXTERNAL_FUNDING_PAIR_INCONSISTENT count above stays for continuity, but an
  // operator needs to know WHICH invariant broke to know what happened.
  const pairCount = async (predicate: string) =>
    q(
      prisma.$queryRawUnsafe(`
        SELECT count(*)::int AS n
        FROM "equity_snapshots" b
        JOIN "equity_snapshots" a
          ON a."trading_account_id" = b."trading_account_id"
         AND a."external_funding_reference_id" = b."external_funding_reference_id"
         AND a."snapshot_reason" = 'external_funding_after'
        WHERE b."snapshot_reason" = 'external_funding_before'
          AND (${predicate})
      `),
    );

  const boundaryPairsWithAmountMismatch = report(
    await pairCount(
      `a."external_funding_amount_krw" IS DISTINCT FROM b."external_funding_amount_krw"`,
    ),
    'EXTERNAL_FUNDING_PAIR_AMOUNT_MISMATCH',
    'external-funding pair(s) whose before/after amounts disagree',
  );

  const boundaryPairsWithAccountScopeMismatch = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "equity_snapshots" s
      WHERE s."snapshot_reason" IN ('external_funding_before', 'external_funding_after')
        AND (
          s."trading_account_id" IS NULL
          OR s."season_participant_id" IS NOT NULL
          OR NOT EXISTS (
            SELECT 1 FROM "ad_reward_claims" c
            WHERE c."id" = s."external_funding_reference_id"
              AND c."trading_account_id" = s."trading_account_id"
          )
        )
        AND s."external_funding_reference_type" = 'ad_reward_claim'
    `),
    'EXTERNAL_FUNDING_BOUNDARY_ACCOUNT_SCOPE_MISMATCH',
    'ad-reward boundary snapshot(s) missing account scope, carrying a participant, or pointing at another account’s claim',
  );

  const boundaryPairsWithFactorMismatch = report(
    await pairCount(
      `a."time_weighted_return_factor" IS DISTINCT FROM b."time_weighted_return_factor"
       OR a."return_rate" IS DISTINCT FROM b."return_rate"`,
    ),
    'EXTERNAL_FUNDING_PAIR_FACTOR_MISMATCH',
    'external-funding pair(s) where the inflow moved the TWR factor or return rate',
  );

  const boundaryPairsWithInvestmentPnlMismatch = report(
    await pairCount(
      `a."investment_pnl_krw" IS DISTINCT FROM b."investment_pnl_krw"`,
    ),
    'EXTERNAL_FUNDING_PAIR_INVESTMENT_PNL_MISMATCH',
    'external-funding pair(s) where the inflow moved investment PnL',
  );

  const boundaryPairsWithTotalAssetMismatch = report(
    await pairCount(
      `(a."total_asset_krw" - b."total_asset_krw") IS DISTINCT FROM b."external_funding_amount_krw"
       OR (a."cumulative_external_funding_krw" - b."cumulative_external_funding_krw")
          IS DISTINCT FROM b."external_funding_amount_krw"`,
    ),
    'EXTERNAL_FUNDING_PAIR_TOTAL_ASSET_MISMATCH',
    'external-funding pair(s) where the after totals are not before plus the inflow',
  );

  const generalDailySnapshotsWithSeasonParticipant = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "daily_portfolio_snapshots" d
      JOIN "trading_accounts" a ON a."id" = d."trading_account_id"
      WHERE a."mode" = 'general' AND d."season_participant_id" IS NOT NULL
    `),
    'GENERAL_DAILY_SNAPSHOT_HAS_SEASON_PARTICIPANT',
    'general daily snapshot(s) carry a season participant link',
  );

  const generalDailySnapshotsMissingPerformanceValues = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "daily_portfolio_snapshots" d
      JOIN "trading_accounts" a ON a."id" = d."trading_account_id"
      WHERE a."mode" = 'general'
        AND d."season_participant_id" IS NULL
        AND (
          d."cumulative_external_funding_krw" IS NULL
          OR d."investment_pnl_krw" IS NULL
          OR d."time_weighted_return_factor" IS NULL
        )
    `),
    'GENERAL_DAILY_SNAPSHOT_PERFORMANCE_VALUES_MISSING',
    'general daily snapshot(s) are missing TWR / external-funding / investment-PnL columns',
  );

  const dailySnapshotsOnClosedAccounts = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "daily_portfolio_snapshots" d
      JOIN "trading_accounts" a ON a."id" = d."trading_account_id"
      WHERE a."mode" = 'general'
        AND a."status" = 'closed'
        AND (a."closed_at" IS NULL OR d."created_at" > a."closed_at")
    `),
    'GENERAL_DAILY_SNAPSHOT_ON_CLOSED_ACCOUNT',
    'daily snapshot(s) were written to a closed general account after it closed',
  );

  const seasonSnapshotsWithoutAccountScope = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "equity_snapshots"
      WHERE "season_participant_id" IS NOT NULL AND "trading_account_id" IS NULL
    `),
    'SEASON_SNAPSHOT_SCOPE_MISSING',
    'season snapshot(s) have no account scope; run trading-accounts:repair-snapshot-scope',
  );

  const seasonSnapshotsWithScopeMismatch = report(
    await q(prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "equity_snapshots" s
      JOIN "season_participants" sp ON sp."id" = s."season_participant_id"
      WHERE s."trading_account_id" IS NOT NULL
        AND sp."trading_account_id" IS NOT NULL
        AND s."trading_account_id" <> sp."trading_account_id"
    `),
    'SEASON_SNAPSHOT_SCOPE_MISMATCH',
    "season snapshot(s) disagree with their participant's account link",
  );

  return {
    accountsWithoutPerformanceOrigin,
    accountsWithDuplicatePerformanceOrigin,
    generalSnapshotsWithSeasonParticipant,
    generalSnapshotsWithoutAccountScope,
    snapshotsMissingPerformanceValues,
    snapshotsWithInvestmentPnlMismatch,
    snapshotsWithReturnRateMismatch,
    snapshotsWithNegativeFactorOrTotal,
    unpairedExternalFundingBefore,
    unpairedExternalFundingAfter,
    externalFundingPairInconsistencies,
    keyedGrantedClaimsWithoutBoundaryPair,
    duplicateAccountDateDailySnapshots,
    seasonSnapshotsWithoutAccountScope,
    seasonSnapshotsWithScopeMismatch,
    accountsWithLatestSnapshotBefore,
    accountsWithExternalFundingDiscontinuity,
    keyedGrantedClaimsWithoutBoundaryBefore,
    keyedGrantedClaimsWithoutBoundaryAfter,
    boundaryPairsWithAmountMismatch,
    boundaryPairsWithAccountScopeMismatch,
    boundaryPairsWithFactorMismatch,
    boundaryPairsWithInvestmentPnlMismatch,
    boundaryPairsWithTotalAssetMismatch,
    generalDailySnapshotsWithSeasonParticipant,
    generalDailySnapshotsMissingPerformanceValues,
    dailySnapshotsOnClosedAccounts,
  };
}

/** 0 when the audit found nothing, 1 when any finding needs investigation. */
export function resolveGeneralAccountAuditExitCode(
  summary: GeneralAccountAuditSummary,
): number {
  return summary.findings.length > 0 ? 1 : 0;
}
