import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma, TradingAccountMode } from '../generated/prisma/client';

/**
 * SeasonRanking ↔ TradingAccount scope (작업 8).
 *
 * SeasonRanking keeps its SeasonParticipant relation — it is a season-only
 * model and this work does not turn it into a general-mode ranking table.
 * `tradingAccountId` is a SECOND identity that states which isolated trading
 * account produced the row, so that:
 *
 *   - a general-mode account can never be scored in a season ranking,
 *   - a row whose account disagrees with its participant's account is visible
 *     instead of silently ranked,
 *   - account-scoped audits and repairs have something to check.
 *
 * TWO SIDES, ONE RULE
 * -------------------
 * WRITERS resolve the account from the participant BEFORE inserting, and
 * refuse to write at all when the link is missing or wrong
 * (`resolveSeasonRankingAccountScopes`). A ranking row is never created with a
 * null scope by new code.
 *
 * READERS re-verify what they loaded (`assertSeasonRankingScopes`). A damaged
 * row is NOT dropped from the set and the remaining ranks are NOT renumbered:
 * silently omitting one competitor shifts everyone below them and produces a
 * leaderboard that is wrong in a way nobody can see. The whole set fails closed
 * with a structured 500 instead.
 *
 * NOTHING HERE REPAIRS ANYTHING. A non-null mismatch is never overwritten, and
 * a null scope is never guessed from context — that is
 * `pnpm trading-accounts:repair-ranking-scope --apply`, run by an operator.
 */

export const seasonRankingScopeErrorCodes = {
  /** ranking.tradingAccountId IS NULL — a legacy row the repair must fill. */
  SEASON_RANKING_SCOPE_REPAIR_REQUIRED: 'SEASON_RANKING_SCOPE_REPAIR_REQUIRED',
  /** The row's account contradicts its participant, user, season, or mode. */
  SEASON_RANKING_SCOPE_MISMATCH: 'SEASON_RANKING_SCOPE_MISMATCH',
  /** The PARTICIPANT itself has no account link (repair-links territory). */
  TRADING_ACCOUNT_LINK_INTEGRITY: 'TRADING_ACCOUNT_LINK_INTEGRITY',
} as const;

export type SeasonRankingScopeErrorCode =
  (typeof seasonRankingScopeErrorCodes)[keyof typeof seasonRankingScopeErrorCodes];

const REPAIR_HINT =
  'Run "pnpm trading-accounts:repair-links --apply" then "pnpm trading-accounts:repair-ranking-scope --apply"; ranking scope is never auto-corrected.';

export function throwSeasonRankingScope(
  code: SeasonRankingScopeErrorCode,
  message: string,
): never {
  throw new HttpException(
    {
      success: false,
      error: { code, message: `${message} ${REPAIR_HINT}` },
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

// --------------------------------------------------------------- write side

type ParticipantScopeClient = Pick<
  Prisma.TransactionClient,
  'seasonParticipant'
>;

const PARTICIPANT_SCOPE_SELECT = {
  id: true,
  seasonId: true,
  userId: true,
  tradingAccountId: true,
  tradingAccount: {
    select: {
      id: true,
      mode: true,
      userId: true,
      status: true,
      seasonParticipant: { select: { id: true } },
    },
  },
} satisfies Prisma.SeasonParticipantSelect;

export type ParticipantRankingScope = {
  seasonParticipantId: string;
  tradingAccountId: string;
  userId: string;
  seasonId: string;
};

/**
 * Resolves the verified season account for every participant a ranking write is
 * about — in ONE query, never one per row.
 *
 * Every participant in `seasonParticipantIds` must resolve. A partially
 * resolvable set is not written partially: the caller aborts and the whole
 * ranking transaction rolls back, because a ranking missing one competitor is
 * not a smaller correct ranking, it is a wrong one.
 */
export async function resolveSeasonRankingAccountScopes(
  client: ParticipantScopeClient,
  input: {
    seasonId: string;
    seasonParticipantIds: readonly string[];
  },
): Promise<Map<string, ParticipantRankingScope>> {
  const ids = [...new Set(input.seasonParticipantIds)];
  if (ids.length === 0) {
    return new Map();
  }

  const participants = await client.seasonParticipant.findMany({
    where: { id: { in: ids } },
    select: PARTICIPANT_SCOPE_SELECT,
  });
  const byId = new Map(participants.map((row) => [row.id, row]));
  const scopes = new Map<string, ParticipantRankingScope>();

  for (const seasonParticipantId of ids) {
    const participant = byId.get(seasonParticipantId);
    if (!participant) {
      throwSeasonRankingScope(
        seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
        `Season participant ${seasonParticipantId} does not exist, so no ranking row can be scoped to an account.`,
      );
    }
    if (participant.seasonId !== input.seasonId) {
      throwSeasonRankingScope(
        seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
        `Season participant ${seasonParticipantId} belongs to season ${participant.seasonId}, not ${input.seasonId}.`,
      );
    }
    if (!participant.tradingAccountId || !participant.tradingAccount) {
      throwSeasonRankingScope(
        seasonRankingScopeErrorCodes.TRADING_ACCOUNT_LINK_INTEGRITY,
        `Season participant ${seasonParticipantId} has no trading account link, so a ranking row for it would be unscoped.`,
      );
    }

    assertAccountIsThisParticipantsSeasonAccount(
      seasonParticipantId,
      participant.userId,
      participant.tradingAccount,
    );

    scopes.set(seasonParticipantId, {
      seasonParticipantId,
      tradingAccountId: participant.tradingAccountId,
      userId: participant.userId,
      seasonId: participant.seasonId,
    });
  }

  return scopes;
}

/** Single-participant convenience over the batch resolver. */
export async function requireSeasonRankingAccountScope(
  client: ParticipantScopeClient,
  input: { seasonId: string; seasonParticipantId: string },
): Promise<ParticipantRankingScope> {
  const scopes = await resolveSeasonRankingAccountScopes(client, {
    seasonId: input.seasonId,
    seasonParticipantIds: [input.seasonParticipantId],
  });

  // resolveSeasonRankingAccountScopes throws for anything it cannot resolve,
  // so a miss here would be a logic error rather than a data problem.
  const scope = scopes.get(input.seasonParticipantId);
  if (!scope) {
    throwSeasonRankingScope(
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
      `Season participant ${input.seasonParticipantId} could not be scoped to a trading account.`,
    );
  }

  return scope;
}

function assertAccountIsThisParticipantsSeasonAccount(
  seasonParticipantId: string,
  participantUserId: string,
  account: {
    id: string;
    mode: TradingAccountMode;
    userId: string;
    seasonParticipant: { id: string } | null;
  },
): void {
  if (account.mode !== TradingAccountMode.season) {
    throwSeasonRankingScope(
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
      `Trading account ${account.id} is mode "${account.mode}"; only season accounts may appear in a season ranking.`,
    );
  }
  if (account.userId !== participantUserId) {
    throwSeasonRankingScope(
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
      `Trading account ${account.id} belongs to a different user than season participant ${seasonParticipantId}.`,
    );
  }
  if (account.seasonParticipant?.id !== seasonParticipantId) {
    throwSeasonRankingScope(
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
      `Trading account ${account.id} is linked to season participant ${account.seasonParticipant?.id ?? 'none'}, not ${seasonParticipantId}.`,
    );
  }
}

/**
 * Guard for a writer that may UPDATE/UPSERT an existing ranking row.
 *
 * An existing row with a NULL scope is not quietly filled in by a normal
 * ranking write — that would hide the deploy-boundary damage the repair script
 * exists to surface and count. An existing row whose scope disagrees with the
 * participant is never overwritten either: one of the two is wrong and a writer
 * cannot know which.
 */
export function assertExistingRankingRowScopeWritable(input: {
  rankingId?: string | null;
  storedTradingAccountId: string | null;
  expectedTradingAccountId: string;
}): void {
  const label = input.rankingId
    ? `Season ranking ${input.rankingId}`
    : 'Season ranking row';

  if (input.storedTradingAccountId === null) {
    throwSeasonRankingScope(
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_REPAIR_REQUIRED,
      `${label} has no trading account scope and must be repaired before it can be updated.`,
    );
  }
  if (input.storedTradingAccountId !== input.expectedTradingAccountId) {
    throwSeasonRankingScope(
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
      `${label} is scoped to account ${input.storedTradingAccountId} but its participant is linked to ${input.expectedTradingAccountId}.`,
    );
  }
}

// ---------------------------------------------------------------- read side

/**
 * The scope columns EVERY SeasonRanking reader must select. Spread it into the
 * reader's own `select` so the verification below always has what it needs.
 *
 * `seasonParticipant.select` is intentionally part of this constant: readers
 * that need extra participant fields merge them in rather than replacing it.
 */
export const SEASON_RANKING_SCOPE_SELECT = {
  seasonId: true,
  seasonParticipantId: true,
  tradingAccountId: true,
  seasonParticipant: {
    select: {
      id: true,
      seasonId: true,
      userId: true,
      tradingAccountId: true,
      tradingAccount: { select: { id: true, mode: true, userId: true } },
    },
  },
} satisfies Prisma.SeasonRankingSelect;

export type SeasonRankingScopeRow = {
  id?: string;
  seasonId: string;
  seasonParticipantId: string;
  tradingAccountId: string | null;
  seasonParticipant: {
    id: string;
    seasonId: string;
    userId: string;
    tradingAccountId: string | null;
    tradingAccount: {
      id: string;
      mode: TradingAccountMode;
      userId: string;
    } | null;
  } | null;
};

/**
 * Fail-closed verification of ONE loaded ranking row.
 *
 * "No ranking row exists" stays the existing `unavailable` response — that is
 * absence of data. Everything below is DAMAGE to data that does exist, and a
 * damaged leaderboard must not render as either an empty one or a shorter one.
 */
export function assertSeasonRankingScope(row: SeasonRankingScopeRow): void {
  const label = row.id
    ? `Season ranking ${row.id}`
    : `Season ranking row for participant ${row.seasonParticipantId}`;
  const participant = row.seasonParticipant;

  if (row.tradingAccountId === null) {
    throwSeasonRankingScope(
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_REPAIR_REQUIRED,
      `${label} has no trading account scope.`,
    );
  }
  if (!participant) {
    throwSeasonRankingScope(
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
      `${label} has no season participant.`,
    );
  }
  if (participant.seasonId !== row.seasonId) {
    throwSeasonRankingScope(
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
      `${label} is filed under season ${row.seasonId} but its participant belongs to ${participant.seasonId}.`,
    );
  }
  if (!participant.tradingAccountId || !participant.tradingAccount) {
    throwSeasonRankingScope(
      seasonRankingScopeErrorCodes.TRADING_ACCOUNT_LINK_INTEGRITY,
      `${label} references a participant with no trading account link.`,
    );
  }
  if (participant.tradingAccountId !== row.tradingAccountId) {
    throwSeasonRankingScope(
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
      `${label} is scoped to account ${row.tradingAccountId} but its participant is linked to ${participant.tradingAccountId}.`,
    );
  }
  if (participant.tradingAccount.mode !== TradingAccountMode.season) {
    throwSeasonRankingScope(
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
      `${label} is scoped to a "${participant.tradingAccount.mode}" account; season rankings never contain general accounts.`,
    );
  }
  if (participant.tradingAccount.userId !== participant.userId) {
    throwSeasonRankingScope(
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
      `${label} is scoped to an account owned by a different user than its participant.`,
    );
  }
}

/**
 * Same verification for rankings loaded as a NESTED relation of the
 * participant that owns them (`seasonParticipant.seasonRankings`).
 *
 * Re-selecting the participant through the ranking would fetch the same row
 * twice, so the parent's already-loaded scope fields are used instead. The
 * parent query must therefore select `seasonId`, `userId`, `tradingAccountId`
 * and `tradingAccount { id, mode, userId }`, and the nested ranking must select
 * `seasonId` and `tradingAccountId`.
 */
export function assertSeasonRankingScopeForParticipant(
  participant: {
    id: string;
    seasonId: string;
    userId: string;
    tradingAccountId: string | null;
    tradingAccount: {
      id: string;
      mode: TradingAccountMode;
      userId: string;
    } | null;
  },
  rankings: readonly {
    id?: string;
    seasonId: string;
    tradingAccountId: string | null;
  }[],
): void {
  for (const ranking of rankings) {
    assertSeasonRankingScope({
      id: ranking.id,
      seasonId: ranking.seasonId,
      seasonParticipantId: participant.id,
      tradingAccountId: ranking.tradingAccountId,
      seasonParticipant: participant,
    });
  }
}

/**
 * Verifies a whole loaded set AND that no two rows share one account — a
 * duplicate would mean one competitor occupies two ranks.
 */
export function assertSeasonRankingScopes(
  rows: readonly SeasonRankingScopeRow[],
): void {
  const seenAccounts = new Set<string>();

  for (const row of rows) {
    assertSeasonRankingScope(row);

    // assertSeasonRankingScope has already proven this is non-null.
    const accountId = row.tradingAccountId!;
    if (seenAccounts.has(accountId)) {
      throwSeasonRankingScope(
        seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
        `Trading account ${accountId} occupies more than one row in the same ranking set.`,
      );
    }
    seenAccounts.add(accountId);
  }
}
