import { HttpStatus } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import {
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
  TradingAccountStatus,
} from '../generated/prisma/client';

/** The participants a final ranking can contain (settlement's eligible set). */
const RANKABLE_PARTICIPANT_STATUSES: ParticipantStatus[] = [
  ParticipantStatus.active,
  ParticipantStatus.finished,
  ParticipantStatus.rewarded,
];

type FinalResultIntegrityClient = Pick<
  Prisma.TransactionClient,
  'seasonParticipant' | 'seasonRanking' | 'tradingAccount'
>;

export type EligibilityFinalResult =
  | { settled: false }
  | { settled: true; qualifiedCount: number };

/**
 * The final result of a season WITH an eligibility rule, as a reader may
 * present it (docs/season-final-ranking-eligibility.md §5). It applies the
 * criteria settlement itself checks before it publishes `settled`, so a reader
 * never shows a state settlement would refuse:
 *
 *   - not settled: no final ranking row and no confirmed verdict yet (both are
 *     written only by the settlement that sets `settled`, atomically);
 *   - settled: every rankable participant (active/finished/rewarded) carries a
 *     verdict, the final rows are exactly one per confirmed qualified
 *     participant on a single rankingDate, and every linked season account is
 *     closed.
 *
 * That is what separates "nobody qualified" (a normal, empty final ranking)
 * from damage — a lost verdict, a deleted or injected row, a re-opened account
 * — which would otherwise read as the same empty or shortened leaderboard.
 * Damage fails closed with 500 FINAL_RESULTS_INTEGRITY, never filtered around.
 *
 * Cost: a fixed number of indexed counts over the season's participants and
 * final rows. The verdicts settlement stored are reused; fills and FX are
 * never re-read here.
 */
export async function verifyEligibilityFinalResult(
  client: FinalResultIntegrityClient,
  season: { id: string; status: SeasonStatus },
): Promise<EligibilityFinalResult> {
  const finalRows = { seasonId: season.id, rankType: SeasonRankingType.final };

  if (season.status !== SeasonStatus.settled) {
    const [rowCount, verdictCount] = await Promise.all([
      client.seasonRanking.count({ where: finalRows }),
      client.seasonParticipant.count({
        where: { seasonId: season.id, finalQualified: { not: null } },
      }),
    ]);
    if (rowCount > 0 || verdictCount > 0) {
      failFinalResultIntegrity(season, {
        seasonStatus: season.status,
        finalRankingRowCount: rowCount,
        confirmedVerdictCount: verdictCount,
      });
    }
    return { settled: false };
  }

  const rankable = {
    participantStatus: { in: RANKABLE_PARTICIPANT_STATUSES },
  };
  const [
    unconfirmedCount,
    qualifiedCount,
    rowCount,
    qualifiedRowCount,
    rowDates,
    liveAccountCount,
  ] = await Promise.all([
    client.seasonParticipant.count({
      where: { seasonId: season.id, ...rankable, finalQualified: null },
    }),
    client.seasonParticipant.count({
      where: { seasonId: season.id, ...rankable, finalQualified: true },
    }),
    client.seasonRanking.count({ where: finalRows }),
    client.seasonRanking.count({
      where: {
        ...finalRows,
        seasonParticipant: { ...rankable, finalQualified: true },
      },
    }),
    client.seasonRanking.aggregate({
      where: finalRows,
      _min: { rankingDate: true },
      _max: { rankingDate: true },
    }),
    client.tradingAccount.count({
      where: {
        seasonParticipant: { seasonId: season.id },
        OR: [
          { status: { not: TradingAccountStatus.closed } },
          { closedAt: null },
        ],
      },
    }),
  ]);
  const minDate = rowDates._min.rankingDate;
  const maxDate = rowDates._max.rankingDate;

  if (
    unconfirmedCount > 0 ||
    rowCount !== qualifiedRowCount ||
    qualifiedRowCount !== qualifiedCount ||
    (minDate !== null &&
      maxDate !== null &&
      minDate.getTime() !== maxDate.getTime()) ||
    liveAccountCount > 0
  ) {
    failFinalResultIntegrity(season, {
      seasonStatus: season.status,
      unconfirmedRankableParticipantCount: unconfirmedCount,
      confirmedQualifiedCount: qualifiedCount,
      finalRankingRowCount: rowCount,
      finalRankingRowsOfQualifiedCount: qualifiedRowCount,
      finalRankingDateMin: minDate?.toISOString() ?? null,
      finalRankingDateMax: maxDate?.toISOString() ?? null,
      openSeasonAccountCount: liveAccountCount,
    });
  }

  return { settled: true, qualifiedCount };
}

function failFinalResultIntegrity(
  season: { id: string },
  evidence: Record<string, unknown>,
): never {
  setAdminDiagnosticContext({
    domain: 'RANKING',
    operation: 'SEASON_FINAL_RESULT_READ',
    failureStage: 'final_result_integrity',
    entities: { seasonId: season.id },
    evidence,
    nextInvestigation: [
      'backend/docs/season-final-ranking-eligibility.md',
      'pnpm trading-accounts:repair-ranking-scope',
    ],
  });
  throw createApiError(
    'FINAL_RESULTS_INTEGRITY',
    'The confirmed season final result could not be verified.',
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}
