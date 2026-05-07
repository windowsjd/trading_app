import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import { PortfolioValuationError } from '../portfolio/portfolio-valuation.policy';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { PrismaService } from '../prisma/prisma.service';

type HomeSectionState = 'available' | 'blocked' | 'unavailable' | 'error';
type HomeMode =
  | 'active_joined'
  | 'active_not_joined'
  | 'upcoming'
  | 'ended'
  | 'settled'
  | 'no_current_season';

type CurrentSeasonRecord = {
  id: string;
  name: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
};

type HomeResponse = {
  success: true;
  data: Record<string, unknown> & {
    mode: HomeMode;
  };
};

type SectionFallback = {
  state: HomeSectionState;
  reason: string;
  message: string;
};

type SectionError = {
  section: string;
  code: string;
  message: string;
};

type JoinedParticipant = {
  id: string;
  participantStatus: ParticipantStatus;
  joinedAt: Date;
  initialCapitalKrw: Prisma.Decimal;
  cashWallets: Array<{
    currencyCode: CurrencyCode;
    balanceAmount: Prisma.Decimal;
  }>;
  positions: Array<{
    quantity: Prisma.Decimal;
  }>;
};

const CURRENT_SEASON_STATUS_PRIORITY: readonly SeasonStatus[] = [
  SeasonStatus.active,
  SeasonStatus.upcoming,
  SeasonStatus.ended,
  SeasonStatus.settled,
];

@Injectable()
export class HomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolioValuationService: PortfolioValuationService,
  ) {}

  async getHome(userId?: string): Promise<HomeResponse> {
    if (!userId) {
      this.throwApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
    }

    const season = await this.findCurrentSeason();
    if (!season) {
      return {
        success: true,
        data: {
          mode: 'no_current_season',
          season: null,
          guide: this.fallback(
            'unavailable',
            'CURRENT_SEASON_NOT_FOUND',
            'Current season is not configured.',
          ),
          sectionErrors: [],
        },
      };
    }

    if (season.status !== SeasonStatus.active) {
      return this.buildNonActiveSeasonHome(season);
    }

    const participant = await this.prisma.seasonParticipant.findUnique({
      where: {
        seasonId_userId: {
          seasonId: season.id,
          userId,
        },
      },
      select: {
        id: true,
        participantStatus: true,
        joinedAt: true,
        initialCapitalKrw: true,
        cashWallets: {
          select: {
            currencyCode: true,
            balanceAmount: true,
          },
          orderBy: {
            currencyCode: 'asc',
          },
        },
        positions: {
          select: {
            quantity: true,
          },
        },
      },
    });

    if (!participant) {
      return this.buildActiveNotJoinedHome(season);
    }

    return this.buildActiveJoinedHome(season, participant);
  }

  private async buildActiveJoinedHome(
    season: CurrentSeasonRecord,
    participant: JoinedParticipant,
  ): Promise<HomeResponse> {
    const sectionErrors: SectionError[] = [];
    const [summary, ranking] = await Promise.all([
      this.buildSummary(participant, sectionErrors),
      this.buildRanking(season.id, participant.id),
    ]);

    return {
      success: true,
      data: {
        mode: 'active_joined',
        season: this.formatSeason(season),
        participant: {
          id: participant.id,
          status: participant.participantStatus,
          joinedAt: participant.joinedAt.toISOString(),
          initialCapitalKrw: this.formatDecimal(
            participant.initialCapitalKrw,
            8,
          ),
        },
        summary,
        ranking,
        walletSummary: this.buildWalletSummary(participant),
        allocation: this.fallback(
          'unavailable',
          'ALLOCATION_NOT_IMPLEMENTED',
          'Allocation summary is not available in the read-only MVP.',
        ),
        topPositions: this.fallback(
          'unavailable',
          'TOP_POSITIONS_NOT_IMPLEMENTED',
          'Top positions are not available in the read-only MVP.',
        ),
        equityChart: this.fallback(
          'unavailable',
          'EQUITY_CHART_NOT_IMPLEMENTED',
          'Equity chart is not available in the read-only MVP.',
        ),
        sectionErrors,
      },
    };
  }

  private buildActiveNotJoinedHome(season: CurrentSeasonRecord): HomeResponse {
    const blocked = {
      summary: this.fallback(
        'blocked',
        'SEASON_NOT_JOINED',
        'Portfolio summary is available after joining.',
      ),
      ranking: this.fallback(
        'blocked',
        'SEASON_NOT_JOINED',
        'Ranking is available after joining.',
      ),
      allocation: this.fallback(
        'blocked',
        'SEASON_NOT_JOINED',
        'Allocation is available after joining.',
      ),
      topPositions: this.fallback(
        'blocked',
        'SEASON_NOT_JOINED',
        'Positions are available after joining.',
      ),
      equityChart: this.fallback(
        'blocked',
        'SEASON_NOT_JOINED',
        'Equity chart is available after joining.',
      ),
    };

    return {
      success: true,
      data: {
        mode: 'active_not_joined',
        season: this.formatSeason(season),
        guide: {
          ...this.fallback(
            'blocked',
            'SEASON_NOT_JOINED',
            'Join the active season to start trading.',
          ),
          action: 'JOIN_SEASON',
        },
        ...blocked,
        sectionErrors: [],
      },
    };
  }

  private buildNonActiveSeasonHome(season: CurrentSeasonRecord): HomeResponse {
    const base = {
      season: this.formatSeason(season),
      sectionErrors: [],
    };

    if (season.status === SeasonStatus.upcoming) {
      return {
        success: true,
        data: {
          mode: 'upcoming',
          ...base,
          guide: {
            ...this.fallback(
              'blocked',
              'SEASON_UPCOMING',
              'Trading is not available before the season starts.',
            ),
            action: null,
          },
          trading: this.blockedReason('SEASON_UPCOMING'),
          exchange: this.blockedReason('SEASON_UPCOMING'),
        },
      };
    }

    if (season.status === SeasonStatus.ended) {
      return {
        success: true,
        data: {
          mode: 'ended',
          ...base,
          guide: {
            ...this.fallback(
              'blocked',
              'SEASON_ENDED_SETTLEMENT_PENDING',
              'Settlement is in progress.',
            ),
            action: null,
          },
          trading: this.blockedReason('SEASON_ENDED'),
          exchange: this.blockedReason('SEASON_ENDED'),
          summary: this.fallback(
            'unavailable',
            'SETTLEMENT_PENDING',
            'Final portfolio summary is not available before settlement.',
          ),
          ranking: this.fallback(
            'unavailable',
            'SETTLEMENT_PENDING',
            'Final ranking is not available before settlement.',
          ),
        },
      };
    }

    return {
      success: true,
      data: {
        mode: 'settled',
        ...base,
        guide: {
          ...this.fallback(
            'available',
            'SEASON_SETTLED',
            'Final results are available.',
          ),
          action: null,
        },
        trading: this.blockedReason('SEASON_SETTLED'),
        exchange: this.blockedReason('SEASON_SETTLED'),
        finalResult: this.fallback(
          'unavailable',
          'FINAL_RESULT_UNAVAILABLE',
          'Final result API is not available in the read-only MVP.',
        ),
        equityChart: this.fallback(
          'unavailable',
          'EQUITY_CHART_NOT_IMPLEMENTED',
          'Equity chart is not available in the read-only MVP.',
        ),
      },
    };
  }

  private async buildSummary(
    participant: JoinedParticipant,
    sectionErrors: SectionError[],
  ) {
    const snapshot = await this.prisma.dailyPortfolioSnapshot.findFirst({
      where: {
        seasonParticipantId: participant.id,
      },
      orderBy: [
        { snapshotDate: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        snapshotDate: true,
        totalAssetKrw: true,
        returnRate: true,
        krwCash: true,
        usdCashKrw: true,
        assetValueKrw: true,
        realizedPnlKrw: true,
        unrealizedPnlKrw: true,
        capturedAt: true,
      },
    });

    if (snapshot) {
      return {
        state: 'available',
        valuationSource: 'daily_snapshot',
        snapshotDate: this.formatDateOnly(snapshot.snapshotDate),
        valuationCapturedAt: snapshot.capturedAt.toISOString(),
        totalAssetKrw: this.formatDecimal(snapshot.totalAssetKrw, 8),
        returnRate: this.formatDecimal(snapshot.returnRate, 8),
        krwCash: this.formatDecimal(snapshot.krwCash, 8),
        usdCashKrw: this.formatDecimal(snapshot.usdCashKrw, 8),
        assetValueKrw: this.formatDecimal(snapshot.assetValueKrw, 8),
        realizedPnlKrw: this.formatDecimal(snapshot.realizedPnlKrw, 8),
        unrealizedPnlKrw: this.formatDecimal(snapshot.unrealizedPnlKrw, 8),
        dataFreshness: {
          status: 'available',
          asOf: snapshot.capturedAt.toISOString(),
        },
      };
    }

    try {
      const valuation =
        await this.portfolioValuationService.calculateSeasonParticipantValuation(
          participant.id,
        );

      return {
        state: 'available',
        valuationSource: 'live_valuation',
        valuationAt: valuation.valuationAt.toISOString(),
        totalAssetKrw: valuation.totalAssetKrw,
        returnRate: valuation.returnRate,
        krwCash: valuation.krwCash,
        usdCashKrw: valuation.usdCashKrw,
        assetValueKrw: valuation.assetValueKrw,
        realizedPnlKrw: valuation.realizedPnlKrw,
        unrealizedPnlKrw: valuation.unrealizedPnlKrw,
        dataFreshness: {
          status: 'available',
          asOf: valuation.valuationAt.toISOString(),
        },
      };
    } catch (error) {
      const code =
        error instanceof PortfolioValuationError
          ? error.code
          : 'VALUATION_UNAVAILABLE';
      const message =
        error instanceof Error
          ? error.message
          : 'Portfolio valuation is unavailable.';

      sectionErrors.push({
        section: 'summary',
        code,
        message,
      });

      return {
        ...this.fallback(
          'unavailable',
          code,
          'Portfolio valuation is unavailable because required market data is missing.',
        ),
        valuationSource: 'unavailable',
        dataFreshness: {
          status: 'unavailable',
          reason: code,
        },
      };
    }
  }

  private async buildRanking(seasonId: string, seasonParticipantId: string) {
    const ranking = await this.prisma.seasonRanking.findFirst({
      where: {
        seasonId,
        seasonParticipantId,
      },
      orderBy: [
        { rankingDate: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        rank: true,
        rankType: true,
        rankingDate: true,
        totalAssetKrw: true,
        returnRate: true,
        capturedAt: true,
      },
    });

    if (!ranking) {
      return {
        ...this.fallback(
          'unavailable',
          'RANKING_UNAVAILABLE',
          'Ranking is unavailable until season rankings are generated.',
        ),
        rankingSource: 'unavailable',
      };
    }

    const rankedParticipants = await this.prisma.seasonRanking.count({
      where: {
        seasonId,
        rankType: ranking.rankType,
        rankingDate: ranking.rankingDate,
      },
    });

    return {
      state: 'available',
      rankingSource: 'season_rankings',
      currentRank: ranking.rank,
      totalParticipants: rankedParticipants,
      rankedParticipants,
      rankType: ranking.rankType,
      rankingDate: this.formatDateOnly(ranking.rankingDate),
      totalAssetKrw: this.formatDecimal(ranking.totalAssetKrw, 8),
      returnRate: this.formatDecimal(ranking.returnRate, 8),
      capturedAt: ranking.capturedAt.toISOString(),
    };
  }

  private buildWalletSummary(participant: JoinedParticipant) {
    return {
      state: 'available',
      cashWallets: participant.cashWallets.map((wallet) => ({
        currencyCode: wallet.currencyCode,
        balanceAmount: this.formatDecimal(wallet.balanceAmount, 8),
      })),
      positionsCount: participant.positions.length,
      openPositionsCount: participant.positions.filter(
        (position) => !position.quantity.eq(0),
      ).length,
    };
  }

  private async findCurrentSeason(): Promise<CurrentSeasonRecord | null> {
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
        orderBy: this.getOrderBy(status),
      });

      if (season) {
        return season;
      }
    }

    return null;
  }

  private getOrderBy(
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

  private formatSeason(season: CurrentSeasonRecord) {
    return {
      id: season.id,
      name: season.name,
      status: season.status,
      startAt: season.startAt.toISOString(),
      endAt: season.endAt.toISOString(),
    };
  }

  private fallback(
    state: HomeSectionState,
    reason: string,
    message: string,
  ): SectionFallback {
    return {
      state,
      reason,
      message,
    };
  }

  private blockedReason(reason: string) {
    return {
      state: 'blocked',
      reason,
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

  private throwApiError(status: HttpStatus, code: string, message: string): never {
    throw new HttpException(this.createErrorBody(code, message), status);
  }
}
