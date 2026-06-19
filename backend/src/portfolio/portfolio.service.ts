import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  ParticipantStatus,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PortfolioValuationError,
  type PortfolioValuationResult,
} from './portfolio-valuation.policy';
import { PortfolioValuationService } from './portfolio-valuation.service';

export type PortfolioEquityQuery = {
  range?: string;
};

type PortfolioState = 'available' | 'not_joined' | 'unavailable';
type EquityRange = '1d' | '7d' | 'season';

type PortfolioSeason = {
  id: string;
  name: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
};

type PortfolioParticipant = {
  id: string;
  participantStatus: ParticipantStatus;
  joinedAt: Date;
};

type SectionError = {
  section: string;
  code: string;
  message: string;
};

type PortfolioResponse = {
  success: true;
  data: {
    state: PortfolioState;
    season: ReturnType<PortfolioService['formatSeason']> | null;
    participant: ReturnType<PortfolioService['formatParticipant']> | null;
    summary: {
      totalAssetKrw: string;
      returnRate: string;
      krwCash: string;
      usdCashKrw: string;
      assetValueKrw: string;
      realizedPnlKrw: string;
      unrealizedPnlKrw: string;
    } | null;
    allocation: {
      state: PortfolioState;
      cashKrwValue: string;
      domesticStockValueKrw: string;
      usStockValueKrw: string;
      cryptoValueKrw: string;
      reason?: string;
      message?: string;
    };
    sectionErrors: SectionError[];
    reason?: string;
    message?: string;
  };
};

type PortfolioEquityResponse = {
  success: true;
  data: {
    state: 'available' | 'empty' | 'not_joined' | 'unavailable';
    range: EquityRange;
    points: Array<{
      time: string;
      totalAssetKrw: string;
      returnRate: string;
    }>;
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
const ZERO_MONEY = '0.00000000';

@Injectable()
export class PortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolioValuationService: PortfolioValuationService,
  ) {}

  async getPortfolio(userId: string | undefined): Promise<PortfolioResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const season = await this.findCurrentSeason();
    if (!season) {
      return this.emptyPortfolioResponse({
        state: 'unavailable',
        season: null,
        participant: null,
        reason: 'CURRENT_SEASON_NOT_FOUND',
        message: 'Current season is not configured.',
      });
    }

    const participant = await this.findParticipant(season.id, userId);
    if (!participant) {
      return this.emptyPortfolioResponse({
        state: 'not_joined',
        season,
        participant: null,
        reason: 'SEASON_NOT_JOINED',
        message: 'Portfolio is available after joining the season.',
      });
    }

    try {
      const valuation =
        await this.portfolioValuationService.calculateSeasonParticipantValuation(
          participant.id,
          new Date(),
          'home_live_valuation',
        );

      return {
        success: true,
        data: {
          state: 'available',
          season: this.formatSeason(season),
          participant: this.formatParticipant(participant),
          summary: this.formatSummary(valuation),
          allocation: this.formatAllocation(valuation),
          sectionErrors: [],
        },
      };
    } catch (error) {
      const sectionError = this.sectionErrorFromValuation(error);

      return {
        success: true,
        data: {
          state: 'unavailable',
          season: this.formatSeason(season),
          participant: this.formatParticipant(participant),
          summary: null,
          allocation: {
            ...this.emptyAllocation(),
            state: 'unavailable',
            reason: sectionError.code,
            message: sectionError.message,
          },
          sectionErrors: [sectionError],
          reason: sectionError.code,
          message: sectionError.message,
        },
      };
    }
  }

  async getEquity(
    userId: string | undefined,
    query: PortfolioEquityQuery = {},
  ): Promise<PortfolioEquityResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const range = this.parseRange(query.range);
    const season = await this.findCurrentSeason();
    if (!season) {
      return this.emptyEquityResponse(
        range,
        'unavailable',
        'CURRENT_SEASON_NOT_FOUND',
        'Current season is not configured.',
      );
    }

    const participant = await this.findParticipant(season.id, userId);
    if (!participant) {
      return this.emptyEquityResponse(
        range,
        'not_joined',
        'SEASON_NOT_JOINED',
        'Equity history is available after joining the season.',
      );
    }

    const points =
      range === '1d'
        ? await this.findEquitySnapshotPoints(participant.id, this.since1d())
        : await this.findDailyOrEquityPoints(
            participant.id,
            range === '7d' ? this.since7d() : season.startAt,
          );

    if (points.length === 0) {
      return {
        success: true,
        data: {
          state: 'empty',
          range,
          points: [],
        },
      };
    }

    return {
      success: true,
      data: {
        state: 'available',
        range,
        points,
      },
    };
  }

  private formatSummary(valuation: PortfolioValuationResult) {
    return {
      totalAssetKrw: valuation.totalAssetKrw,
      returnRate: valuation.returnRate,
      krwCash: valuation.krwCash,
      usdCashKrw: valuation.usdCashKrw,
      assetValueKrw: valuation.assetValueKrw,
      realizedPnlKrw: valuation.realizedPnlKrw,
      unrealizedPnlKrw: valuation.unrealizedPnlKrw,
    };
  }

  private formatAllocation(valuation: PortfolioValuationResult) {
    return {
      state: 'available' as const,
      cashKrwValue: new Prisma.Decimal(valuation.krwCash)
        .add(valuation.usdCashKrw)
        .toFixed(8),
      domesticStockValueKrw: valuation.domesticStockValueKrw,
      usStockValueKrw: valuation.usStockValueKrw,
      cryptoValueKrw: valuation.cryptoValueKrw,
    };
  }

  private emptyPortfolioResponse(input: {
    state: PortfolioState;
    season: PortfolioSeason | null;
    participant: PortfolioParticipant | null;
    reason: string;
    message: string;
  }): PortfolioResponse {
    return {
      success: true,
      data: {
        state: input.state,
        season: input.season ? this.formatSeason(input.season) : null,
        participant: input.participant
          ? this.formatParticipant(input.participant)
          : null,
        summary: null,
        allocation: {
          ...this.emptyAllocation(),
          state: input.state,
          reason: input.reason,
          message: input.message,
        },
        sectionErrors: [],
        reason: input.reason,
        message: input.message,
      },
    };
  }

  private emptyAllocation() {
    return {
      state: 'unavailable' as PortfolioState,
      cashKrwValue: ZERO_MONEY,
      domesticStockValueKrw: ZERO_MONEY,
      usStockValueKrw: ZERO_MONEY,
      cryptoValueKrw: ZERO_MONEY,
    };
  }

  private emptyEquityResponse(
    range: EquityRange,
    state: 'not_joined' | 'unavailable',
    reason: string,
    message: string,
  ): PortfolioEquityResponse {
    return {
      success: true,
      data: {
        state,
        range,
        points: [],
        reason,
        message,
      },
    };
  }

  private async findDailyOrEquityPoints(
    seasonParticipantId: string,
    since: Date,
  ): Promise<PortfolioEquityResponse['data']['points']> {
    const dailyPoints = await this.findDailySnapshotPoints(
      seasonParticipantId,
      since,
    );

    return dailyPoints.length > 0
      ? dailyPoints
      : this.findEquitySnapshotPoints(seasonParticipantId, since);
  }

  private async findEquitySnapshotPoints(
    seasonParticipantId: string,
    since: Date,
  ): Promise<PortfolioEquityResponse['data']['points']> {
    const snapshots = await this.prisma.equitySnapshot.findMany({
      where: {
        seasonParticipantId,
        capturedAt: {
          gte: since,
        },
      },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        capturedAt: true,
        totalAssetKrw: true,
        returnRate: true,
      },
    });

    return snapshots.map((snapshot) => ({
      time: snapshot.capturedAt.toISOString(),
      totalAssetKrw: this.formatDecimal(snapshot.totalAssetKrw, 8),
      returnRate: this.formatDecimal(snapshot.returnRate, 8),
    }));
  }

  private async findDailySnapshotPoints(
    seasonParticipantId: string,
    since: Date,
  ): Promise<PortfolioEquityResponse['data']['points']> {
    const snapshots = await this.prisma.dailyPortfolioSnapshot.findMany({
      where: {
        seasonParticipantId,
        capturedAt: {
          gte: since,
        },
      },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        capturedAt: true,
        totalAssetKrw: true,
        returnRate: true,
      },
    });

    return snapshots.map((snapshot) => ({
      time: snapshot.capturedAt.toISOString(),
      totalAssetKrw: this.formatDecimal(snapshot.totalAssetKrw, 8),
      returnRate: this.formatDecimal(snapshot.returnRate, 8),
    }));
  }

  private parseRange(value: string | undefined): EquityRange {
    const range = value?.trim() || 'season';
    if (range === '1d' || range === '7d' || range === 'season') {
      return range;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_RANGE',
      'range must be one of 1d, 7d, season.',
    );
  }

  private since1d() {
    return new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  private since7d() {
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  }

  private async findCurrentSeason(): Promise<PortfolioSeason | null> {
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
        participantStatus: true,
        joinedAt: true,
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

  private sectionErrorFromValuation(error: unknown): SectionError {
    return {
      section: 'portfolio',
      code:
        error instanceof PortfolioValuationError
          ? error.code
          : 'VALUATION_UNAVAILABLE',
      message:
        error instanceof Error ? error.message : 'Portfolio is unavailable.',
    };
  }

  private formatSeason(season: PortfolioSeason) {
    return {
      id: season.id,
      name: season.name,
      status: season.status,
      startAt: season.startAt.toISOString(),
      endAt: season.endAt.toISOString(),
    };
  }

  private formatParticipant(participant: PortfolioParticipant) {
    return {
      id: participant.id,
      status: participant.participantStatus,
      joinedAt: participant.joinedAt.toISOString(),
    };
  }

  private formatDecimal(value: Prisma.Decimal, scale: number) {
    return value.toFixed(scale);
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
