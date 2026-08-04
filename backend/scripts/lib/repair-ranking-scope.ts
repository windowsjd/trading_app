import type { PrismaClient } from '../../src/generated/prisma/client';

/**
 * Non-destructive backfill of `season_rankings.trading_account_id` (작업 8 §12).
 *
 * Companion to — and deliberately separate from — repair-links (participant ↔
 * account), repair-financial-scope (wallets/ledger/exchange/fx),
 * repair-trading-scope (orders/positions/quotes), and repair-snapshot-scope
 * (equity/daily snapshots). Each owns one table family; none of them repairs
 * another's rows, so an operator always knows which one to blame.
 *
 * Safety contract, identical to the other four:
 *  - Bare invocation is a DRY-RUN; writes require an explicit `--apply`.
 *  - ONLY the null `tradingAccountId` column is filled, from the row's own
 *    participant link. rank, totalAssetKrw, returnRate, maxDrawdown,
 *    totalFillCount, reachedReturnAt, rankingDate, capturedAt, createdAt, and
 *    seasonParticipantId are NEVER touched. Nor are participant results,
 *    Season.status, or TradingAccount.status.
 *  - A NON-NULL value that disagrees with the participant is REPORTED, never
 *    overwritten: one of the two is wrong and a script cannot know which.
 *  - A participant with no account link, a general-mode account, a user
 *    mismatch, and a season mismatch are all reported and left alone.
 *  - Re-running is idempotent (IS NULL guarded updates only).
 *  - `--apply` exits non-zero unless nothing is left unresolved.
 */

const BATCH_SIZE = 500;

export type RankingScopeFailure = {
  rankingId: string | null;
  code: string;
  message: string;
};

export type RankingScopeSummary = {
  apply: boolean;
  /** Rows with trading_account_id IS NULL at the start of the run. */
  nullScopeRowCount: number;
  /** Rows filled (apply) or that would be filled (dry-run). */
  backfilledCount: number;
  /** Null rows the repair refuses to fill, with the reason. */
  blockedRows: RankingScopeFailure[];
  /** Non-null values that disagree with the participant link. */
  mismatchCount: number;
  /** Rankings whose participant has no account link at all. */
  participantLinkNullCount: number;
  /** Rankings scoped to a general-mode account. */
  generalAccountCount: number;
  /** Rankings whose account owner differs from the participant's user. */
  userMismatchCount: number;
  /** Rankings filed under a different season than their participant. */
  seasonMismatchCount: number;
  failures: RankingScopeFailure[];
  remainingNullCount?: number;
  remainingMismatchCount?: number;
};

type NullScopeRow = {
  id: string;
  season_id: string;
  season_participant_id: string;
  participant_season_id: string | null;
  participant_user_id: string | null;
  participant_trading_account_id: string | null;
  account_mode: string | null;
  account_user_id: string | null;
};

export async function repairRankingScope(
  prisma: PrismaClient,
  options: { apply: boolean },
): Promise<RankingScopeSummary> {
  const summary: RankingScopeSummary = {
    apply: options.apply,
    nullScopeRowCount: 0,
    backfilledCount: 0,
    blockedRows: [],
    mismatchCount: 0,
    participantLinkNullCount: 0,
    generalAccountCount: 0,
    userMismatchCount: 0,
    seasonMismatchCount: 0,
    failures: [],
  };

  // ---- null scope rows, cursor-paged by id ----
  let cursor = '';
  for (;;) {
    const rows = await prisma.$queryRaw<NullScopeRow[]>`
      SELECT sr."id",
             sr."season_id",
             sr."season_participant_id",
             sp."season_id"           AS participant_season_id,
             sp."user_id"             AS participant_user_id,
             sp."trading_account_id"  AS participant_trading_account_id,
             ta."mode"::text          AS account_mode,
             ta."user_id"             AS account_user_id
      FROM "season_rankings" sr
      LEFT JOIN "season_participants" sp ON sp."id" = sr."season_participant_id"
      LEFT JOIN "trading_accounts" ta ON ta."id" = sp."trading_account_id"
      WHERE sr."trading_account_id" IS NULL
        AND sr."id" > ${cursor}
      ORDER BY sr."id" ASC
      LIMIT ${BATCH_SIZE}
    `;
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    summary.nullScopeRowCount += rows.length;

    for (const row of rows) {
      const blocked = describeBlockedNullScope(row);
      if (blocked) {
        summary.blockedRows.push(blocked);
        summary.failures.push(blocked);
        continue;
      }

      if (!options.apply) {
        summary.backfilledCount += 1;
        continue;
      }

      // IS NULL guarded: a concurrent new-version writer that already set the
      // scope wins, and this becomes a no-op rather than an overwrite.
      const updated = await prisma.seasonRanking.updateMany({
        where: { id: row.id, tradingAccountId: null },
        data: { tradingAccountId: row.participant_trading_account_id },
      });
      summary.backfilledCount += updated.count;
    }

    if (rows.length < BATCH_SIZE) break;
  }

  // ---- conditions that are REPORTED ONLY, never corrected ----
  summary.mismatchCount = await countMismatches(prisma);
  if (summary.mismatchCount > 0) {
    summary.failures.push({
      rankingId: null,
      code: 'SEASON_RANKING_SCOPE_MISMATCH',
      message: `${summary.mismatchCount} ranking row(s) carry a non-null trading_account_id that disagrees with their participant's link; investigate manually (never auto-corrected).`,
    });
  }

  summary.participantLinkNullCount = await countRaw(
    prisma,
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "season_rankings" sr
      JOIN "season_participants" sp ON sp."id" = sr."season_participant_id"
      WHERE sp."trading_account_id" IS NULL
    `,
  );
  if (summary.participantLinkNullCount > 0) {
    summary.failures.push({
      rankingId: null,
      code: 'MISSING_PARTICIPANT_TRADING_ACCOUNT_LINK',
      message: `${summary.participantLinkNullCount} ranking row(s) reference a participant with no trading account link; run "pnpm trading-accounts:repair-links --apply" first.`,
    });
  }

  summary.generalAccountCount = await countRaw(
    prisma,
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "season_rankings" sr
      JOIN "trading_accounts" ta ON ta."id" = sr."trading_account_id"
      WHERE ta."mode" = 'general'
    `,
  );
  if (summary.generalAccountCount > 0) {
    summary.failures.push({
      rankingId: null,
      code: 'SEASON_RANKING_GENERAL_ACCOUNT',
      message: `${summary.generalAccountCount} ranking row(s) are scoped to a GENERAL account; a general account is never ranked in a season and this is never auto-corrected.`,
    });
  }

  summary.userMismatchCount = await countRaw(
    prisma,
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "season_rankings" sr
      JOIN "season_participants" sp ON sp."id" = sr."season_participant_id"
      JOIN "trading_accounts" ta ON ta."id" = sr."trading_account_id"
      WHERE ta."user_id" <> sp."user_id"
    `,
  );
  if (summary.userMismatchCount > 0) {
    summary.failures.push({
      rankingId: null,
      code: 'SEASON_RANKING_USER_MISMATCH',
      message: `${summary.userMismatchCount} ranking row(s) are scoped to an account owned by a different user than their participant.`,
    });
  }

  summary.seasonMismatchCount = await countRaw(
    prisma,
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "season_rankings" sr
      JOIN "season_participants" sp ON sp."id" = sr."season_participant_id"
      WHERE sp."season_id" <> sr."season_id"
    `,
  );
  if (summary.seasonMismatchCount > 0) {
    summary.failures.push({
      rankingId: null,
      code: 'SEASON_RANKING_SEASON_MISMATCH',
      message: `${summary.seasonMismatchCount} ranking row(s) are filed under a different season than their participant.`,
    });
  }

  if (options.apply) {
    summary.remainingNullCount = await countRaw(
      prisma,
      prisma.$queryRaw`
        SELECT count(*)::int AS n
        FROM "season_rankings"
        WHERE "trading_account_id" IS NULL
      `,
    );
    summary.remainingMismatchCount = await countMismatches(prisma);
  }

  return summary;
}

/**
 * Why a null-scope row cannot be filled. Returning null means "safe to fill".
 * Every branch here is a case where guessing would attach a ranking to an
 * account that may not be the one that produced it.
 */
function describeBlockedNullScope(
  row: NullScopeRow,
): RankingScopeFailure | null {
  if (!row.participant_season_id) {
    return {
      rankingId: row.id,
      code: 'SEASON_RANKING_PARTICIPANT_MISSING',
      message: `Ranking ${row.id} references participant ${row.season_participant_id}, which does not exist.`,
    };
  }
  if (row.participant_season_id !== row.season_id) {
    return {
      rankingId: row.id,
      code: 'SEASON_RANKING_SEASON_MISMATCH',
      message: `Ranking ${row.id} is filed under season ${row.season_id} but its participant belongs to ${row.participant_season_id}.`,
    };
  }
  if (!row.participant_trading_account_id) {
    return {
      rankingId: row.id,
      code: 'MISSING_PARTICIPANT_TRADING_ACCOUNT_LINK',
      message: `Ranking ${row.id}'s participant has no trading account link; run trading-accounts:repair-links --apply first.`,
    };
  }
  if (row.account_mode !== 'season') {
    return {
      rankingId: row.id,
      code: 'SEASON_RANKING_GENERAL_ACCOUNT',
      message: `Ranking ${row.id}'s participant is linked to a "${row.account_mode ?? 'missing'}" account; a season ranking never references one.`,
    };
  }
  if (row.account_user_id !== row.participant_user_id) {
    return {
      rankingId: row.id,
      code: 'SEASON_RANKING_USER_MISMATCH',
      message: `Ranking ${row.id}'s participant is linked to an account owned by a different user.`,
    };
  }

  return null;
}

async function countMismatches(prisma: PrismaClient): Promise<number> {
  return countRaw(
    prisma,
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "season_rankings" sr
      JOIN "season_participants" sp ON sp."id" = sr."season_participant_id"
      WHERE sr."trading_account_id" IS NOT NULL
        AND sp."trading_account_id" IS NOT NULL
        AND sr."trading_account_id" <> sp."trading_account_id"
    `,
  );
}

async function countRaw(
  _prisma: PrismaClient,
  query: Promise<Array<{ n: number }>>,
): Promise<number> {
  const rows = await query;
  return Number(rows[0]?.n ?? 0);
}

/** Non-zero while anything is unresolved, so `--apply` cannot look clean. */
export function resolveRankingScopeExitCode(
  summary: RankingScopeSummary,
): number {
  if (summary.failures.length > 0) return 1;
  if (!summary.apply) return 0;

  return (summary.remainingNullCount ?? 0) > 0 ||
    (summary.remainingMismatchCount ?? 0) > 0
    ? 1
    : 0;
}

// --------------------------------------------------------------- audit

/**
 * READ-ONLY ranking + settlement audit (작업 8 §17).
 *
 * Bundled with the repair because the repair's dry-run is the natural place an
 * operator looks, but it is strictly a reporter: it recomputes nothing,
 * renumbers nothing, and writes nothing. Several findings here are deliberately
 * NOT repairable by any script (a rank gap, a tier disagreement) — the correct
 * response is to re-run the owning job, not to patch rows.
 */
export type RankingAuditFinding = {
  code: string;
  count: number;
  message: string;
};

export async function auditRankingAndSettlement(
  prisma: PrismaClient,
): Promise<RankingAuditFinding[]> {
  const findings: RankingAuditFinding[] = [];

  const add = async (
    code: string,
    message: string,
    query: Promise<Array<{ n: number }>>,
  ) => {
    const count = await countRaw(prisma, query);
    if (count > 0) {
      findings.push({ code, count, message });
    }
  };

  await add(
    'SEASON_RANKING_SCOPE_NULL',
    'ranking row(s) have no trading account scope; run repair-ranking-scope --apply.',
    prisma.$queryRaw`
      SELECT count(*)::int AS n FROM "season_rankings" WHERE "trading_account_id" IS NULL
    `,
  );

  await add(
    'SEASON_RANKING_SCOPE_MISMATCH',
    "ranking row(s) disagree with their participant's account link.",
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "season_rankings" sr
      JOIN "season_participants" sp ON sp."id" = sr."season_participant_id"
      WHERE sr."trading_account_id" IS NOT NULL
        AND sp."trading_account_id" IS NOT NULL
        AND sr."trading_account_id" <> sp."trading_account_id"
    `,
  );

  await add(
    'SEASON_RANKING_GENERAL_ACCOUNT',
    'ranking row(s) are scoped to a general-mode account.',
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "season_rankings" sr
      JOIN "trading_accounts" ta ON ta."id" = sr."trading_account_id"
      WHERE ta."mode" = 'general'
    `,
  );

  await add(
    'SEASON_RANKING_DUPLICATE_ACCOUNT',
    'ranking set(s) contain the same trading account more than once.',
    prisma.$queryRaw`
      SELECT count(*)::int AS n FROM (
        SELECT 1
        FROM "season_rankings"
        WHERE "trading_account_id" IS NOT NULL
        GROUP BY "season_id", "rank_type", "ranking_date", "trading_account_id"
        HAVING count(*) > 1
      ) dupes
    `,
  );

  await add(
    'SEASON_RANKING_DUPLICATE_RANK',
    'ranking set(s) contain the same rank more than once.',
    prisma.$queryRaw`
      SELECT count(*)::int AS n FROM (
        SELECT 1
        FROM "season_rankings"
        GROUP BY "season_id", "rank_type", "ranking_date", "rank"
        HAVING count(*) > 1
      ) dupes
    `,
  );

  // Sequential ranks 1..N with no gap: MIN must be 1 and MAX must equal COUNT.
  await add(
    'SEASON_RANKING_RANK_SEQUENCE_BROKEN',
    'ranking set(s) are not a gapless 1..N sequence.',
    prisma.$queryRaw`
      SELECT count(*)::int AS n FROM (
        SELECT 1
        FROM "season_rankings"
        GROUP BY "season_id", "rank_type", "ranking_date"
        HAVING min("rank") <> 1 OR max("rank") <> count(*)
      ) broken
    `,
  );

  await add(
    'FINAL_RANKING_PARTICIPANT_RANK_MISMATCH',
    'settled participant(s) store a finalRank that differs from their final ranking row.',
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "season_rankings" sr
      JOIN "season_participants" sp ON sp."id" = sr."season_participant_id"
      JOIN "seasons" s ON s."id" = sr."season_id"
      WHERE sr."rank_type" = 'final'
        AND s."status" = 'settled'
        AND (sp."final_rank" IS NULL OR sp."final_rank" <> sr."rank")
    `,
  );

  await add(
    'FINAL_TIER_MISSING',
    'settled participant(s) with a final ranking have no finalTier.',
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "season_rankings" sr
      JOIN "season_participants" sp ON sp."id" = sr."season_participant_id"
      JOIN "seasons" s ON s."id" = sr."season_id"
      WHERE sr."rank_type" = 'final'
        AND s."status" = 'settled'
        AND sp."final_tier" IS NULL
    `,
  );

  await add(
    'SETTLED_SEASON_ACCOUNT_NOT_CLOSED',
    'settled season(s) still have a linked season account that is active or suspended.',
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "season_participants" sp
      JOIN "seasons" s ON s."id" = sp."season_id"
      JOIN "trading_accounts" ta ON ta."id" = sp."trading_account_id"
      WHERE s."status" = 'settled'
        AND ta."mode" = 'season'
        AND ta."status" <> 'closed'
    `,
  );

  await add(
    'SETTLED_SEASON_ACCOUNT_CLOSED_AT_NULL',
    'settled season(s) have a closed linked account with no closedAt.',
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "season_participants" sp
      JOIN "seasons" s ON s."id" = sp."season_id"
      JOIN "trading_accounts" ta ON ta."id" = sp."trading_account_id"
      WHERE s."status" = 'settled'
        AND ta."mode" = 'season'
        AND ta."closed_at" IS NULL
    `,
  );

  await add(
    'ELIGIBLE_PARTICIPANT_FINAL_RANKING_MISSING',
    'eligible participant(s) of a settled season have no final ranking row.',
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "season_participants" sp
      JOIN "seasons" s ON s."id" = sp."season_id"
      WHERE s."status" = 'settled'
        AND sp."participant_status" IN ('active', 'finished', 'rewarded')
        AND NOT EXISTS (
          SELECT 1 FROM "season_rankings" sr
          WHERE sr."season_participant_id" = sp."id" AND sr."rank_type" = 'final'
        )
    `,
  );

  await add(
    'EXCLUDED_PARTICIPANT_HAS_FINAL_RANKING',
    'excluded participant(s) hold a final ranking row.',
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "season_participants" sp
      JOIN "season_rankings" sr ON sr."season_participant_id" = sp."id"
      WHERE sp."participant_status" = 'excluded'
        AND sr."rank_type" = 'final'
    `,
  );

  await add(
    'SEASON_SNAPSHOT_SCOPE_DAMAGED',
    'season snapshot(s) used as ranking input have a null or mismatched account scope.',
    prisma.$queryRaw`
      SELECT (
        (SELECT count(*) FROM "daily_portfolio_snapshots" d
          JOIN "season_participants" sp ON sp."id" = d."season_participant_id"
          WHERE d."trading_account_id" IS NULL
             OR (sp."trading_account_id" IS NOT NULL
                 AND d."trading_account_id" <> sp."trading_account_id"))
        +
        (SELECT count(*) FROM "equity_snapshots" e
          JOIN "season_participants" sp ON sp."id" = e."season_participant_id"
          WHERE e."trading_account_id" IS NULL
             OR (sp."trading_account_id" IS NOT NULL
                 AND e."trading_account_id" <> sp."trading_account_id"))
      )::int AS n
    `,
  );

  await add(
    'RANKING_INPUT_ORDER_SCOPE_DAMAGED',
    'executed order(s) feeding totalFillCount have a null or mismatched account scope.',
    prisma.$queryRaw`
      SELECT count(*)::int AS n
      FROM "orders" o
      JOIN "season_participants" sp ON sp."id" = o."season_participant_id"
      WHERE o."status" = 'executed'
        AND (o."trading_account_id" IS NULL
             OR (sp."trading_account_id" IS NOT NULL
                 AND o."trading_account_id" <> sp."trading_account_id"))
    `,
  );

  return findings;
}
