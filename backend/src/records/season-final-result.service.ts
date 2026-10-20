import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import { createApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { assertSeasonRankingScopeForParticipant } from '../ranking/season-ranking-scope';
import {
  publicSeasonWhere,
  seasonDisplayFields,
} from '../seasons/season-availability.policy';

/**
 * 시즌최종결과 (docs/records-api-contract.md): one participant's official
 * final result for one season, and whether they have seen it.
 *
 * Every figure is settlement's stored result, never a current-price read:
 *  - a ranked participant: finalRank/finalTier from the participant (as 내 뱃지
 *    reads them) and the total/return of their final ranking row (as the
 *    records list does), with the row's rank required to agree;
 *  - a participant who did not meet the final-ranking criteria: the totals
 *    settlement stored beside the verdict, with no rank or tier;
 *  - an excluded participant: no result at all.
 * Anything else after settlement (a missing or disagreeing final row, an
 * unranked `registered` participant) is `unavailable`, which cannot be marked
 * as viewed. Before settlement the result is `pending`.
 */
export type SeasonFinalResult =
  | {
      state: 'available';
      finalRank: number;
      finalTier: string;
      totalAssetKrw: string;
      returnRate: string;
      capturedAt: string;
    }
  | {
      state: 'not_qualified';
      totalAssetKrw: string;
      returnRate: string;
      tradedInstrumentCount: number | null;
      recognizedTurnoverKrw: string | null;
    }
  | { state: 'excluded' }
  | { state: 'pending' }
  | { state: 'unavailable'; reason: 'FINAL_RESULT_UNAVAILABLE' };

type SeasonFinalResultResponse = {
  success: true;
  data: {
    season: {
      id: string;
      name: string;
      status: SeasonStatus;
      startAt: string;
      endAt: string;
    };
    participantStatus: ParticipantStatus | null;
    /** First view of this result by its owner; null until then. */
    viewedAt: string | null;
    result: SeasonFinalResult | { state: 'not_joined' };
  };
};

type SeasonFinalResultViewResponse = {
  success: true;
  data: { seasonId: string; viewedAt: string };
};

const VIEWABLE_STATES: ReadonlySet<SeasonFinalResult['state']> = new Set([
  'available',
  'not_qualified',
  'excluded',
]);

const PARTICIPANT_SELECT = {
  id: true,
  seasonId: true,
  userId: true,
  tradingAccountId: true,
  tradingAccount: { select: { id: true, mode: true, userId: true } },
  participantStatus: true,
  finalRank: true,
  finalTier: true,
  finalQualified: true,
  finalTradedInstrumentCount: true,
  finalRecognizedTurnoverKrw: true,
  totalAssetKrw: true,
  totalReturnRate: true,
  finalResultViewedAt: true,
  seasonRankings: {
    where: { rankType: SeasonRankingType.final },
    orderBy: [
      { rankingDate: 'desc' },
      { capturedAt: 'desc' },
      { createdAt: 'desc' },
    ],
    take: 1,
    select: {
      id: true,
      seasonId: true,
      tradingAccountId: true,
      rank: true,
      totalAssetKrw: true,
      returnRate: true,
      capturedAt: true,
    },
  },
} satisfies Prisma.SeasonParticipantSelect;

type FinalResultParticipant = Prisma.SeasonParticipantGetPayload<{
  select: typeof PARTICIPANT_SELECT;
}>;

@Injectable()
export class SeasonFinalResultService {
  constructor(private readonly prisma: PrismaService) {}

  async getMyFinalResult(
    userId: string | undefined,
    seasonId: string | undefined,
  ): Promise<SeasonFinalResultResponse> {
    const ownerId = requireUserId(userId);
    const { season, participant } = await this.read(
      ownerId,
      parseSeasonId(seasonId),
    );

    return {
      success: true,
      data: {
        season: {
          id: season.id,
          name: season.name,
          ...seasonDisplayFields(season),
          status: season.status,
          startAt: season.startAt.toISOString(),
          endAt: season.endAt.toISOString(),
        },
        participantStatus: participant?.participantStatus ?? null,
        viewedAt: participant?.finalResultViewedAt?.toISOString() ?? null,
        result: participant
          ? evaluateFinalResult(season.status, participant)
          : { state: 'not_joined' },
      },
    };
  }

  /**
   * Records the FIRST view; later calls return the stored instant unchanged.
   * Only a result that can be shown is ever marked: a pending or unavailable
   * result answers 409 and stores nothing.
   */
  async markMyFinalResultViewed(
    userId: string | undefined,
    seasonId: string | undefined,
  ): Promise<SeasonFinalResultViewResponse> {
    const ownerId = requireUserId(userId);
    const { season, participant } = await this.read(
      ownerId,
      parseSeasonId(seasonId),
    );
    if (!participant) {
      throw createApiError(
        'SEASON_NOT_JOINED',
        'Season final result is available to its participants only.',
        HttpStatus.NOT_FOUND,
      );
    }
    const result = evaluateFinalResult(season.status, participant);
    if (!VIEWABLE_STATES.has(result.state)) {
      throw createApiError(
        'SEASON_FINAL_RESULT_UNAVAILABLE',
        result.state === 'pending'
          ? 'Season final result is available after settlement.'
          : 'Stored season final result is unavailable.',
        HttpStatus.CONFLICT,
      );
    }

    // Outside the read snapshot, under the default isolation: a concurrent
    // first view makes this match no row instead of failing to serialize,
    // and the stored instant is read back.
    await this.prisma.seasonParticipant.updateMany({
      where: { id: participant.id, finalResultViewedAt: null },
      data: { finalResultViewedAt: new Date() },
    });
    const stored = await this.prisma.seasonParticipant.findUnique({
      where: { id: participant.id },
      select: { finalResultViewedAt: true },
    });
    if (!stored?.finalResultViewedAt) {
      throw createApiError(
        'SEASON_FINAL_RESULT_VIEW_FAILED',
        'Season final result view could not be stored.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      data: {
        seasonId: season.id,
        viewedAt: stored.finalResultViewedAt.toISOString(),
      },
    };
  }

  /** Season, participant and final row from one snapshot. */
  private read(userId: string, seasonId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const season = await tx.season.findUnique({
          where: { ...publicSeasonWhere(), id: seasonId },
          select: {
            id: true,
            name: true,
            launchKind: true,
            status: true,
            startAt: true,
            endAt: true,
          },
        });
        if (!season) {
          throw createApiError(
            'SEASON_NOT_FOUND',
            'Season not found.',
            HttpStatus.NOT_FOUND,
          );
        }
        const participant = await tx.seasonParticipant.findUnique({
          where: { seasonId_userId: { seasonId: season.id, userId } },
          select: PARTICIPANT_SELECT,
        });
        if (participant) {
          // A mis-scoped row would show another account's result as mine.
          assertSeasonRankingScopeForParticipant(
            participant,
            participant.seasonRankings,
          );
        }
        return { season, participant };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

export function evaluateFinalResult(
  seasonStatus: SeasonStatus,
  participant: Pick<
    FinalResultParticipant,
    | 'participantStatus'
    | 'finalRank'
    | 'finalTier'
    | 'finalQualified'
    | 'finalTradedInstrumentCount'
    | 'finalRecognizedTurnoverKrw'
    | 'totalAssetKrw'
    | 'totalReturnRate'
    | 'seasonRankings'
  >,
): SeasonFinalResult {
  if (seasonStatus !== SeasonStatus.settled) return { state: 'pending' };
  if (participant.participantStatus === ParticipantStatus.excluded) {
    return { state: 'excluded' };
  }
  if (participant.finalQualified === false) {
    return {
      state: 'not_qualified',
      totalAssetKrw: participant.totalAssetKrw.toFixed(8),
      returnRate: participant.totalReturnRate.toFixed(8),
      tradedInstrumentCount: participant.finalTradedInstrumentCount,
      recognizedTurnoverKrw:
        participant.finalRecognizedTurnoverKrw?.toFixed(8) ?? null,
    };
  }
  const ranking = participant.seasonRankings[0];
  const finalTier = participant.finalTier?.trim();
  const finalRank = participant.finalRank;
  if (
    ranking &&
    finalTier &&
    typeof finalRank === 'number' &&
    Number.isInteger(finalRank) &&
    finalRank >= 1 &&
    ranking.rank === finalRank
  ) {
    return {
      state: 'available',
      finalRank,
      finalTier,
      totalAssetKrw: ranking.totalAssetKrw.toFixed(8),
      returnRate: ranking.returnRate.toFixed(8),
      capturedAt: ranking.capturedAt.toISOString(),
    };
  }
  return { state: 'unavailable', reason: 'FINAL_RESULT_UNAVAILABLE' };
}

function requireUserId(userId: string | undefined): string {
  if (!userId) {
    throw createApiError(
      'UNAUTHORIZED',
      'Unauthorized',
      HttpStatus.UNAUTHORIZED,
    );
  }
  return userId;
}

function parseSeasonId(seasonId: string | undefined): string {
  const value = typeof seasonId === 'string' ? seasonId.trim() : '';
  if (!value) {
    throw createApiError(
      'INVALID_SEASON_ID',
      'seasonId must be a non-empty string.',
      HttpStatus.BAD_REQUEST,
    );
  }
  return value;
}
