import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';

/**
 * Season-only snapshot scoping (작업 7).
 *
 * EquitySnapshot.seasonParticipantId and
 * DailyPortfolioSnapshot.seasonParticipantId became nullable so general-mode
 * accounts — which have no SeasonParticipant — can own snapshots. Every
 * SEASON reader (ranking, settlement, records, admin scripts) must therefore
 * say so explicitly instead of relying on the column having been NOT NULL:
 *
 *  - `seasonSnapshotWhere` makes the query genuinely season-only, so a
 *    general-account row can never drift into a season ranking, settlement
 *    valuation, or history list.
 *  - `requireSeasonSnapshotParticipantId` narrows the type at the one place
 *    the filter already guarantees it, instead of scattering `!` around.
 *
 * This is deliberately NOT a general-purpose helper: it exists to keep the
 * season contract identical to what it was before the column was relaxed.
 */

/** Add to any season snapshot WHERE clause. */
export const seasonSnapshotWhere = {
  seasonParticipantId: { not: null },
} satisfies { seasonParticipantId: Prisma.StringNullableFilter };

/**
 * Narrows a snapshot row already selected with `seasonSnapshotWhere` (or
 * through a `seasonParticipant` relation filter, which implies it). Throws
 * rather than returning a placeholder, because a null here would mean a
 * general row reached a season code path.
 */
export function requireSeasonSnapshotParticipantId(
  seasonParticipantId: string | null,
): string {
  if (!seasonParticipantId) {
    throw new Error(
      'Season snapshot row has no seasonParticipantId; a general-mode snapshot reached a season-only code path.',
    );
  }

  return seasonParticipantId;
}

/**
 * Resolves the participant's verified trading account for a snapshot write
 * (작업 7 dual-write).
 *
 * Every season snapshot writer must record BOTH identities. A participant
 * whose link is null must NOT silently produce an unscoped snapshot: that row
 * would later be invisible to every account-scoped read and would make the
 * read-integrity probes fail closed for the whole account. Failing here
 * instead points the operator at `pnpm trading-accounts:repair-links --apply`
 * while the damage is still one request wide.
 */
export async function requireParticipantTradingAccountIdForSnapshot(
  client: Pick<Prisma.TransactionClient, 'seasonParticipant'>,
  seasonParticipantId: string,
): Promise<string> {
  const participant = await client.seasonParticipant.findUnique({
    where: { id: seasonParticipantId },
    select: { tradingAccountId: true },
  });

  if (!participant?.tradingAccountId) {
    throw new HttpException(
      {
        success: false,
        error: {
          code: 'TRADING_ACCOUNT_LINK_INTEGRITY',
          message:
            'Season participant has no trading account link; run trading-accounts:repair-links before writing performance snapshots.',
        },
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  return participant.tradingAccountId;
}
