import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type RankingQuery = {
  seasonId?: string;
  rankingDate?: string;
  rankType?: string;
  limit?: string;
  offset?: string;
};

type RankingSectionState = 'available' | 'unavailable' | 'not_joined';

type RankingSeason = {
  id: string;
  name: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
};

type ParsedRankingQuery = {
  seasonId?: string;
  rankingDate?: Date;
  rankType: SeasonRankingType;
  limit: number;
  offset: number;
};

type RankingResponse = {
  success: true;
  data: {
    state: RankingSectionState;
    season: ReturnType<RankingService['formatSeason']> | null;
    rankType: SeasonRankingType;
    rankingDate: string | null;
    capturedAt: string | null;
    pagination: {
      limit: number;
      offset: number;
      total: number;
      returned: number;
    };
    rankings: Array<{
      rank: number;
      seasonParticipantId: string;
      userId: string;
      nickname: string;
      profileImageUrl: string | null;
      totalAssetKrw: string;
      returnRate: string;
      maxDrawdown: string;
      totalFillCount: number;
      reachedReturnAt: string | null;
      capturedAt: string;
    }>;
    myRanking:
      | {
          state: 'available';
          rank: number;
          seasonParticipantId: string;
          totalAssetKrw: string;
          returnRate: string;
          maxDrawdown: string;
          totalFillCount: number;
          reachedReturnAt: string | null;
          rankingDate: string;
          capturedAt: string;
        }
      | {
          state: 'not_joined' | 'unavailable';
          reason: string;
          message: string;
        };
    reason?: string;
    message?: string;
  };
};

const CURRENT_SEASON_STATUS_PRIORITY: readonly SeasonStatus[] = [
  SeasonStatus.active,
  SeasonStatus.upcoming,
  SeasonStatus.ended,
  SeasonStatus.settled,
];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

@Injectable()
export class RankingService {
  constructor(private readonly prisma: PrismaService) {}

  async getRanking(
    userId: string | undefined,
    query: RankingQuery = {},
  ): Promise<RankingResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedQuery = this.parseQuery(query);
    const season = parsedQuery.seasonId
      ? await this.findSeasonById(parsedQuery.seasonId)
      : await this.findCurrentSeason();

    if (!season) {
      return this.unavailableResponse({
        season: null,
        rankType: parsedQuery.rankType,
        rankingDate: parsedQuery.rankingDate,
        limit: parsedQuery.limit,
        offset: parsedQuery.offset,
        reason: parsedQuery.seasonId
          ? 'SEASON_NOT_FOUND'
          : 'CURRENT_SEASON_NOT_FOUND',
        message: parsedQuery.seasonId
          ? 'Season not found.'
          : 'Current season is not configured.',
        myRanking: this.unavailableMyRanking(
          'RANKING_UNAVAILABLE',
          'Ranking is unavailable.',
        ),
      });
    }

    const selectedRanking = parsedQuery.rankingDate
      ? await this.findRankingDateMetadata(
          season.id,
          parsedQuery.rankType,
          parsedQuery.rankingDate,
        )
      : await this.findLatestRankingDateMetadata(
          season.id,
          parsedQuery.rankType,
        );

    const participant = await this.findParticipant(season.id, userId);

    if (!selectedRanking) {
      return this.unavailableResponse({
        season,
        rankType: parsedQuery.rankType,
        rankingDate: parsedQuery.rankingDate,
        limit: parsedQuery.limit,
        offset: parsedQuery.offset,
        reason: 'RANKING_UNAVAILABLE',
        message: 'Ranking data is unavailable for the selected season.',
        myRanking: participant
          ? this.unavailableMyRanking(
              'MY_RANKING_UNAVAILABLE',
              'My ranking is unavailable until season rankings are generated.',
            )
          : this.notJoinedMyRanking(),
      });
    }

    const where = {
      seasonId: season.id,
      rankType: parsedQuery.rankType,
      rankingDate: selectedRanking.rankingDate,
    };
    const [total, rankingRows, myRankingRow] = await Promise.all([
      this.prisma.seasonRanking.count({ where }),
      this.prisma.seasonRanking.findMany({
        where,
        orderBy: [{ rank: 'asc' }, { seasonParticipantId: 'asc' }],
        skip: parsedQuery.offset,
        take: parsedQuery.limit,
        select: {
          rank: true,
          seasonParticipantId: true,
          totalAssetKrw: true,
          returnRate: true,
          maxDrawdown: true,
          totalFillCount: true,
          reachedReturnAt: true,
          capturedAt: true,
          seasonParticipant: {
            select: {
              userId: true,
              user: {
                select: {
                  nickname: true,
                  profileImageUrl: true,
                },
              },
            },
          },
        },
      }),
      participant
        ? this.prisma.seasonRanking.findUnique({
            where: {
              seasonId_rankType_rankingDate_seasonParticipantId: {
                seasonId: season.id,
                rankType: parsedQuery.rankType,
                rankingDate: selectedRanking.rankingDate,
                seasonParticipantId: participant.id,
              },
            },
            select: {
              rank: true,
              seasonParticipantId: true,
              totalAssetKrw: true,
              returnRate: true,
              maxDrawdown: true,
              totalFillCount: true,
              reachedReturnAt: true,
              capturedAt: true,
            },
          })
        : Promise.resolve(null),
    ]);

    return {
      success: true,
      data: {
        state: 'available',
        season: this.formatSeason(season),
        rankType: parsedQuery.rankType,
        rankingDate: this.formatDateOnly(selectedRanking.rankingDate),
        capturedAt: selectedRanking.capturedAt.toISOString(),
        pagination: {
          limit: parsedQuery.limit,
          offset: parsedQuery.offset,
          total,
          returned: rankingRows.length,
        },
        rankings: rankingRows.map((row) => ({
          rank: row.rank,
          seasonParticipantId: row.seasonParticipantId,
          userId: row.seasonParticipant.userId,
          nickname: row.seasonParticipant.user.nickname,
          profileImageUrl: row.seasonParticipant.user.profileImageUrl,
          totalAssetKrw: this.formatDecimal(row.totalAssetKrw, 8),
          returnRate: this.formatDecimal(row.returnRate, 8),
          maxDrawdown: this.formatDecimal(row.maxDrawdown, 8),
          totalFillCount: row.totalFillCount,
          reachedReturnAt: row.reachedReturnAt?.toISOString() ?? null,
          capturedAt: row.capturedAt.toISOString(),
        })),
        myRanking: participant
          ? this.formatMyRanking(
              myRankingRow,
              this.formatDateOnly(selectedRanking.rankingDate),
            )
          : this.notJoinedMyRanking(),
      },
    };
  }

  private parseQuery(query: RankingQuery): ParsedRankingQuery {
    return {
      seasonId: this.parseOptionalText(query.seasonId),
      rankingDate: this.parseOptionalDate(query.rankingDate),
      rankType: this.parseRankType(query.rankType),
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
  }

  private parseRankType(value: string | undefined): SeasonRankingType {
    const text = value?.trim() || SeasonRankingType.daily;

    if (text === SeasonRankingType.daily || text === SeasonRankingType.final) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_RANK_TYPE',
      'Invalid rankType.',
    );
  }

  private parseOptionalDate(value: string | undefined): Date | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_RANKING_DATE',
        'rankingDate must be YYYY-MM-DD.',
      );
    }

    const date = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || this.formatDateOnly(date) !== text) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_RANKING_DATE',
        'rankingDate must be YYYY-MM-DD.',
      );
    }

    return date;
  }

  private parseLimit(value: string | undefined): number {
    if (value === undefined) {
      return DEFAULT_LIMIT;
    }

    const limit = this.parseNonNegativeInteger(value, 'INVALID_LIMIT', 'limit');
    if (limit < 1) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_LIMIT',
        'limit must be greater than 0.',
      );
    }

    return Math.min(limit, MAX_LIMIT);
  }

  private parseOffset(value: string | undefined): number {
    if (value === undefined) {
      return 0;
    }

    return this.parseNonNegativeInteger(value, 'INVALID_OFFSET', 'offset');
  }

  private parseNonNegativeInteger(
    value: string,
    code: string,
    fieldName: string,
  ): number {
    if (!/^\d+$/.test(value.trim())) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        `${fieldName} must be a non-negative integer.`,
      );
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        `${fieldName} must be a safe integer.`,
      );
    }

    return parsed;
  }

  private parseOptionalText(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  private async findCurrentSeason(): Promise<RankingSeason | null> {
    for (const status of CURRENT_SEASON_STATUS_PRIORITY) {
      const season = await this.prisma.season.findFirst({
        where: {
          status,
        },
        select: {
          id: true,
          name: true,
          status: true,
          startAt: true,
          endAt: true,
        },
        orderBy: this.getSeasonOrderBy(status),
      });

      if (season) {
        return season;
      }
    }

    return null;
  }

  private async findSeasonById(
    seasonId: string,
  ): Promise<RankingSeason | null> {
    return this.prisma.season.findUnique({
      where: {
        id: seasonId,
      },
      select: {
        id: true,
        name: true,
        status: true,
        startAt: true,
        endAt: true,
      },
    });
  }

  private getSeasonOrderBy(
    status: SeasonStatus,
  ): Prisma.SeasonFindFirstArgs['orderBy'] {
    switch (status) {
      case SeasonStatus.upcoming:
        return [{ startAt: 'asc' }, { createdAt: 'asc' }];
      case SeasonStatus.ended:
      case SeasonStatus.settled:
        return [{ endAt: 'desc' }, { createdAt: 'desc' }];
      case SeasonStatus.active:
      default:
        return [{ startAt: 'desc' }, { createdAt: 'desc' }];
    }
  }

  private async findLatestRankingDateMetadata(
    seasonId: string,
    rankType: SeasonRankingType,
  ) {
    return this.prisma.seasonRanking.findFirst({
      where: {
        seasonId,
        rankType,
      },
      orderBy: [
        { rankingDate: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        rankingDate: true,
        capturedAt: true,
      },
    });
  }

  private async findRankingDateMetadata(
    seasonId: string,
    rankType: SeasonRankingType,
    rankingDate: Date,
  ) {
    return this.prisma.seasonRanking.findFirst({
      where: {
        seasonId,
        rankType,
        rankingDate,
      },
      orderBy: [{ capturedAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        rankingDate: true,
        capturedAt: true,
      },
    });
  }

  private async findParticipant(seasonId: string, userId: string) {
    return this.prisma.seasonParticipant.findUnique({
      where: {
        seasonId_userId: {
          seasonId,
          userId,
        },
      },
      select: {
        id: true,
      },
    });
  }

  private unavailableResponse(input: {
    season: RankingSeason | null;
    rankType: SeasonRankingType;
    rankingDate: Date | undefined;
    limit: number;
    offset: number;
    reason: string;
    message: string;
    myRanking: RankingResponse['data']['myRanking'];
  }): RankingResponse {
    return {
      success: true,
      data: {
        state: 'unavailable',
        season: input.season ? this.formatSeason(input.season) : null,
        rankType: input.rankType,
        rankingDate: input.rankingDate
          ? this.formatDateOnly(input.rankingDate)
          : null,
        capturedAt: null,
        pagination: {
          limit: input.limit,
          offset: input.offset,
          total: 0,
          returned: 0,
        },
        rankings: [],
        myRanking: input.myRanking,
        reason: input.reason,
        message: input.message,
      },
    };
  }

  private formatMyRanking(
    ranking: {
      rank: number;
      seasonParticipantId: string;
      totalAssetKrw: Prisma.Decimal;
      returnRate: Prisma.Decimal;
      maxDrawdown: Prisma.Decimal;
      totalFillCount: number;
      reachedReturnAt: Date | null;
      capturedAt: Date;
    } | null,
    rankingDate: string,
  ): RankingResponse['data']['myRanking'] {
    if (!ranking) {
      return this.unavailableMyRanking(
        'MY_RANKING_UNAVAILABLE',
        'My ranking is unavailable until season rankings are generated.',
      );
    }

    return {
      state: 'available',
      rank: ranking.rank,
      seasonParticipantId: ranking.seasonParticipantId,
      totalAssetKrw: this.formatDecimal(ranking.totalAssetKrw, 8),
      returnRate: this.formatDecimal(ranking.returnRate, 8),
      maxDrawdown: this.formatDecimal(ranking.maxDrawdown, 8),
      totalFillCount: ranking.totalFillCount,
      reachedReturnAt: ranking.reachedReturnAt?.toISOString() ?? null,
      rankingDate,
      capturedAt: ranking.capturedAt.toISOString(),
    };
  }

  private notJoinedMyRanking(): RankingResponse['data']['myRanking'] {
    return {
      state: 'not_joined',
      reason: 'SEASON_NOT_JOINED',
      message: 'My ranking is available after joining the season.',
    };
  }

  private unavailableMyRanking(
    reason: string,
    message: string,
  ): RankingResponse['data']['myRanking'] {
    return {
      state: 'unavailable',
      reason,
      message,
    };
  }

  private formatSeason(season: RankingSeason) {
    return {
      id: season.id,
      name: season.name,
      status: season.status,
      startAt: season.startAt.toISOString(),
      endAt: season.endAt.toISOString(),
    };
  }

  private formatDecimal(value: Prisma.Decimal, scale: number) {
    return value.toFixed(scale);
  }

  private formatDateOnly(date: Date) {
    return date.toISOString().slice(0, 10);
  }

  private createErrorBody(code: string, message: string) {
    return {
      success: false,
      error: {
        code,
        message,
      },
    };
  }

  private throwApiError(
    status: HttpStatus,
    code: string,
    message: string,
  ): never {
    throw new HttpException(this.createErrorBody(code, message), status);
  }
}
