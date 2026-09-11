import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma, TradingAccountMode } from '../generated/prisma/client';

/**
 * Scope verification of the ROWS A RANKING IS COMPUTED FROM (작업 8 §9).
 *
 * Daily snapshots, equity history, and executed orders are account-owned.
 * Every source account must belong to one of this season's verified
 * participants before it can affect ranking.
 *
 * WHY THIS FAILS THE JOB INSTEAD OF SKIPPING ROWS
 * ----------------------------------------------
 * Every one of these inputs changes the ORDER of the leaderboard, not just one
 * competitor's card:
 *   - a dropped daily snapshot removes a participant and shifts every rank
 *     below them,
 *   - a dropped equity snapshot LOWERS that participant's max drawdown, which
 *     is tie-break #2 and can promote them,
 *   - a dropped executed order LOWERS totalFillCount, which is tie-break #3.
 * Quietly excluding damaged rows therefore produces a plausible ranking that is
 * subtly wrong in the direction that favours the damaged account. The job fails
 * closed instead, and the existing repair scripts fix the source rows.
 *
 * Queries filter through TradingAccount -> SeasonParticipant; these checks are
 * the separate assertion that every returned account is in the verified map.
 */

export const rankingSourceScopeErrorCodes = {
  /** A source row has no canonical account scope. */
  SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED:
    'SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED',
  /** A source row's account contradicts its participant, user, or mode. */
  SEASON_RANKING_SOURCE_SCOPE_MISMATCH: 'SEASON_RANKING_SOURCE_SCOPE_MISMATCH',
} as const;

export type RankingSourceScopeErrorCode =
  (typeof rankingSourceScopeErrorCodes)[keyof typeof rankingSourceScopeErrorCodes];

const REPAIR_HINT =
  'Inspect the canonical TradingAccount link; ranking inputs are never silently excluded or repaired during calculation.';

export function throwRankingSourceScope(
  code: RankingSourceScopeErrorCode,
  message: string,
): never {
  throw new HttpException(
    { success: false, error: { code, message: `${message} ${REPAIR_HINT}` } },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/** Participant fields every ranking participant query must select (no N+1). */
export const RANKING_PARTICIPANT_SCOPE_SELECT = {
  id: true,
  seasonId: true,
  userId: true,
  participantStatus: true,
  tradingAccountId: true,
  tradingAccount: {
    select: { id: true, mode: true, status: true, userId: true },
  },
} satisfies Prisma.SeasonParticipantSelect;

export type RankingParticipantScopeRow = {
  id: string;
  seasonId: string;
  userId: string;
  tradingAccountId: string | null;
  tradingAccount: {
    id: string;
    mode: TradingAccountMode;
    userId: string;
  } | null;
};

/**
 * The verified participant → season account map every source check is measured
 * against. Built once per job from the participant list the job already loads.
 */
export function buildRankingParticipantScopes(
  seasonId: string,
  participants: readonly RankingParticipantScopeRow[],
): Map<string, string> {
  const scopes = new Map<string, string>();

  for (const participant of participants) {
    if (participant.seasonId !== seasonId) {
      throwRankingSourceScope(
        rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
        `Season participant ${participant.id} belongs to season ${participant.seasonId}, not ${seasonId}.`,
      );
    }
    if (!participant.tradingAccountId || !participant.tradingAccount) {
      throwRankingSourceScope(
        rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED,
        `Season participant ${participant.id} has no trading account link, so its ranking inputs cannot be verified.`,
      );
    }
    if (participant.tradingAccount.mode !== TradingAccountMode.season) {
      throwRankingSourceScope(
        rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
        `Season participant ${participant.id} is linked to a "${participant.tradingAccount.mode}" account.`,
      );
    }
    if (participant.tradingAccount.userId !== participant.userId) {
      throwRankingSourceScope(
        rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
        `Season participant ${participant.id} is linked to an account owned by a different user.`,
      );
    }

    scopes.set(participant.id, participant.tradingAccountId);
  }

  return scopes;
}

/** Columns any season snapshot used as a ranking input must be selected with. */
export type RankingSourceSnapshotScopeRow = {
  id?: string;
  tradingAccountId: string;
  cumulativeExternalFundingKrw: Prisma.Decimal | null;
  investmentPnlKrw: Prisma.Decimal | null;
  timeWeightedReturnFactor: Prisma.Decimal | null;
};

export function assertRankingSourceSnapshotScopes(input: {
  kind: 'daily portfolio snapshot' | 'equity snapshot';
  rows: readonly RankingSourceSnapshotScopeRow[];
  participantScopes: ReadonlyMap<string, string>;
}): void {
  const accountIds = new Set(input.participantScopes.values());
  for (const row of input.rows) {
    const label = `Season ${input.kind}${row.id ? ` ${row.id}` : ''}`;
    if (!accountIds.has(row.tradingAccountId)) {
      throwRankingSourceScope(
        rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
        `${label} is scoped to account ${row.tradingAccountId}, which is not among this season's verified ranking accounts.`,
      );
    }

    // A season row carrying general-mode performance state means a general
    // writer touched it. Its returnRate would then be a TWR percent, which is
    // a different number from the initial-capital return the season ranking
    // sorts by — ranking the two together would compare unlike quantities.
    if (
      row.cumulativeExternalFundingKrw !== null ||
      row.investmentPnlKrw !== null ||
      row.timeWeightedReturnFactor !== null
    ) {
      throwRankingSourceScope(
        rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
        `${label} carries general-mode performance columns; its return rate is not the season initial-capital return.`,
      );
    }
  }
}

/** Columns any executed Order used for totalFillCount must be selected with. */
export type RankingSourceOrderScopeRow = {
  id?: string;
  tradingAccountId: string;
};

export function assertRankingSourceOrderScopes(input: {
  rows: readonly RankingSourceOrderScopeRow[];
  participantScopes: ReadonlyMap<string, string>;
}): void {
  const accountIds = new Set(input.participantScopes.values());
  for (const row of input.rows) {
    const label = `Executed order${row.id ? ` ${row.id}` : ''}`;
    if (!accountIds.has(row.tradingAccountId)) {
      throwRankingSourceScope(
        rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
        `${label} is scoped to account ${row.tradingAccountId}, which is not among this season's verified ranking accounts.`,
      );
    }
  }
}
