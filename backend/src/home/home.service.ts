import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import {
  isFxSnapshotStaleForPortfolioValuation,
  PortfolioValuationError,
  PortfolioValuationResult,
} from '../portfolio/portfolio-valuation.policy';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildAdminManualFallbackDecision,
  isPositiveDecimal,
  resolveAssetProviderEligibility,
  resolveFxProviderEligibility,
  selectFreshProviderSnapshotBySourcePriority,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
} from '../providers/source-eligibility.policy';
import { presentSourceDecision } from '../providers/source-metadata.presenter';
import {
  getEffectiveSeasonMode,
  type SeasonLifecycleMode,
} from '../seasons/season-lifecycle.policy';

type HomeSectionState = 'available' | 'blocked' | 'unavailable' | 'error';
type HomeMode =
  | 'active_joined'
  | 'active_not_joined'
  | 'upcoming'
  | 'ended'
  | 'settled_joined'
  | 'settled_not_joined'
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

type SettledParticipant = {
  id: string;
  participantStatus: ParticipantStatus;
  joinedAt: Date;
  initialCapitalKrw: Prisma.Decimal;
  finalTier: string | null;
  rewardGrantedAt: Date | null;
};

const CURRENT_SEASON_STATUS_PRIORITY: readonly SeasonStatus[] = [
  SeasonStatus.active,
  SeasonStatus.upcoming,
  SeasonStatus.ended,
  SeasonStatus.settled,
];
const TOP_POSITIONS_LIMIT = 5;
const EQUITY_CHART_LIMIT = 30;

@Injectable()
export class HomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolioValuationService: PortfolioValuationService,
  ) {}

  async getHome(userId?: string): Promise<HomeResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
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

    const effectiveMode = getEffectiveSeasonMode(season, new Date());
    if (effectiveMode !== 'active') {
      return this.buildNonActiveSeasonHome(season, userId, effectiveMode);
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
    const valuationAt = new Date();
    const getLiveValuation = this.createLiveValuationLoader(
      participant.id,
      valuationAt,
    );
    const [summary, ranking, allocation, topPositions, equityChart] =
      await Promise.all([
        this.buildSummary(sectionErrors, getLiveValuation),
        this.buildRanking(season.id, participant.id),
        this.buildAllocation(sectionErrors, getLiveValuation),
        this.buildTopPositions(participant.id, sectionErrors, valuationAt),
        this.buildEquityChart(participant.id),
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
        allocation,
        topPositions,
        equityChart,
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

  private async buildNonActiveSeasonHome(
    season: CurrentSeasonRecord,
    userId: string,
    effectiveMode: Exclude<SeasonLifecycleMode, 'active'>,
  ): Promise<HomeResponse> {
    const base = {
      season: this.formatSeason(season),
      sectionErrors: [],
    };

    if (effectiveMode === 'upcoming') {
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

    if (effectiveMode === 'ended') {
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

    return this.buildSettledSeasonHome(season, userId);
  }

  private async buildSettledSeasonHome(
    season: CurrentSeasonRecord,
    userId: string,
  ): Promise<HomeResponse> {
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
        finalTier: true,
        rewardGrantedAt: true,
      },
    });

    if (!participant) {
      return this.buildSettledNotJoinedHome(season);
    }

    return this.buildSettledJoinedHome(season, participant);
  }

  private buildSettledNotJoinedHome(season: CurrentSeasonRecord): HomeResponse {
    const message = 'Final result is available only to season participants.';

    return {
      success: true,
      data: {
        mode: 'settled_not_joined',
        season: this.formatSeason(season),
        guide: {
          ...this.fallback('blocked', 'SEASON_NOT_JOINED', message),
          action: null,
        },
        trading: this.blockedReason('SEASON_SETTLED'),
        exchange: this.blockedReason('SEASON_SETTLED'),
        finalResult: this.fallback('blocked', 'SEASON_NOT_JOINED', message),
        equityChart: this.fallback(
          'blocked',
          'SEASON_NOT_JOINED',
          'Equity chart is available only to season participants.',
        ),
        sectionErrors: [
          {
            section: 'finalResult',
            code: 'SEASON_NOT_JOINED',
            message,
          },
        ],
      },
    };
  }

  private async buildSettledJoinedHome(
    season: CurrentSeasonRecord,
    participant: SettledParticipant,
  ): Promise<HomeResponse> {
    const sectionErrors: SectionError[] = [];
    const [finalResult, equityChart] = await Promise.all([
      this.buildFinalResult(season.id, participant, sectionErrors),
      this.buildSettledEquityChart(participant.id, sectionErrors),
    ]);

    return {
      success: true,
      data: {
        mode: 'settled_joined',
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
        finalResult,
        equityChart,
        sectionErrors,
      },
    };
  }

  private async buildFinalResult(
    seasonId: string,
    participant: SettledParticipant,
    sectionErrors: SectionError[],
  ) {
    const ranking = await this.findLatestFinalRanking(seasonId, participant.id);
    const tier = this.buildFinalTier(participant, sectionErrors);
    const reward = this.buildRewardState(participant, sectionErrors);

    if (!ranking) {
      const message =
        'Final ranking is unavailable for the settled season participant.';
      sectionErrors.push({
        section: 'finalResult',
        code: 'FINAL_RANKING_UNAVAILABLE',
        message,
      });

      return {
        ...this.fallback('unavailable', 'FINAL_RANKING_UNAVAILABLE', message),
        resultSource: 'season_rankings',
        rankType: SeasonRankingType.final,
        tier,
        reward,
      };
    }

    const totalParticipants = await this.prisma.seasonRanking.count({
      where: {
        seasonId,
        rankType: SeasonRankingType.final,
        rankingDate: ranking.rankingDate,
      },
    });

    return {
      state: 'available',
      resultSource: 'season_rankings',
      rankType: SeasonRankingType.final,
      rank: ranking.rank,
      totalParticipants,
      totalAssetKrw: this.formatDecimal(ranking.totalAssetKrw, 8),
      returnRate: this.formatDecimal(ranking.returnRate, 8),
      maxDrawdown: this.formatDecimal(ranking.maxDrawdown, 8),
      totalFillCount: ranking.totalFillCount,
      reachedReturnAt: ranking.reachedReturnAt?.toISOString() ?? null,
      rankingDate: this.formatDateOnly(ranking.rankingDate),
      capturedAt: ranking.capturedAt.toISOString(),
      tier,
      reward,
    };
  }

  private async findLatestFinalRanking(
    seasonId: string,
    seasonParticipantId: string,
  ) {
    return this.prisma.seasonRanking.findFirst({
      where: {
        seasonId,
        seasonParticipantId,
        rankType: SeasonRankingType.final,
      },
      orderBy: [
        { rankingDate: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        rank: true,
        totalAssetKrw: true,
        returnRate: true,
        maxDrawdown: true,
        totalFillCount: true,
        reachedReturnAt: true,
        rankingDate: true,
        capturedAt: true,
      },
    });
  }

  private buildFinalTier(
    participant: SettledParticipant,
    sectionErrors: SectionError[],
  ) {
    if (participant.finalTier) {
      return {
        state: 'available',
        finalTier: participant.finalTier,
      };
    }

    const message = 'Final tier assignment is not available yet.';
    sectionErrors.push({
      section: 'finalResult.tier',
      code: 'FINAL_TIER_UNAVAILABLE',
      message,
    });

    return {
      state: 'unavailable',
      code: 'FINAL_TIER_UNAVAILABLE',
      message,
    };
  }

  private buildRewardState(
    participant: SettledParticipant,
    sectionErrors: SectionError[],
  ) {
    if (participant.rewardGrantedAt) {
      return {
        state: 'granted',
        grantedAt: participant.rewardGrantedAt.toISOString(),
      };
    }

    const message = 'Reward has not been granted yet.';
    sectionErrors.push({
      section: 'finalResult.reward',
      code: 'REWARD_NOT_GRANTED',
      message,
    });

    return {
      state: 'pending',
      grantedAt: null,
      code: 'REWARD_NOT_GRANTED',
      message,
    };
  }

  private async buildSettledEquityChart(
    seasonParticipantId: string,
    sectionErrors: SectionError[],
  ) {
    const equityChart = await this.buildEquityChart(seasonParticipantId);

    if (equityChart.state !== 'available') {
      const message =
        'Final equity chart is unavailable because daily portfolio snapshots are missing.';
      sectionErrors.push({
        section: 'equityChart',
        code: 'FINAL_SNAPSHOT_UNAVAILABLE',
        message,
      });

      return {
        ...equityChart,
        reason: 'FINAL_SNAPSHOT_UNAVAILABLE',
        message,
      };
    }

    return equityChart;
  }

  private createLiveValuationLoader(
    seasonParticipantId: string,
    valuationAt: Date,
  ) {
    let valuationPromise: Promise<PortfolioValuationResult> | null = null;

    return () => {
      valuationPromise ??=
        this.portfolioValuationService.calculateSeasonParticipantValuation(
          seasonParticipantId,
          valuationAt,
          'home_live_valuation',
        );

      return valuationPromise;
    };
  }

  private async buildSummary(
    sectionErrors: SectionError[],
    getLiveValuation: () => Promise<PortfolioValuationResult>,
  ) {
    try {
      const valuation = await getLiveValuation();

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
        sourceSummary: valuation.sourceSummary ?? null,
        fxRateSource: presentSourceDecision(valuation.fxRateSourceDecision),
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

  private async buildAllocation(
    sectionErrors: SectionError[],
    getLiveValuation: () => Promise<PortfolioValuationResult>,
  ) {
    try {
      const valuation = await getLiveValuation();
      const totalAssetKrw = new Prisma.Decimal(valuation.totalAssetKrw);

      if (totalAssetKrw.eq(0)) {
        throw new PortfolioValuationError(
          'ALLOCATION_TOTAL_ASSET_ZERO',
          'Allocation cannot be calculated when totalAssetKrw is zero.',
        );
      }

      return {
        state: 'available',
        allocationSource: 'live_valuation',
        totalAssetKrw: valuation.totalAssetKrw,
        valuationAt: valuation.valuationAt.toISOString(),
        sourceSummary: valuation.sourceSummary ?? null,
        fxRateSource: presentSourceDecision(valuation.fxRateSourceDecision),
        items: [
          this.buildAllocationItem({
            category: 'krw_cash',
            label: 'KRW cash',
            amountKrw: valuation.krwCash,
            totalAssetKrw,
          }),
          this.buildAllocationItem({
            category: 'usd_cash',
            label: 'USD cash',
            amountKrw: valuation.usdCashKrw,
            totalAssetKrw,
          }),
          this.buildAllocationItem({
            category: 'domestic_stock',
            label: 'Domestic stock',
            amountKrw: valuation.domesticStockValueKrw,
            totalAssetKrw,
          }),
          this.buildAllocationItem({
            category: 'us_stock',
            label: 'US stock',
            amountKrw: valuation.usStockValueKrw,
            totalAssetKrw,
          }),
          this.buildAllocationItem({
            category: 'crypto',
            label: 'Crypto',
            amountKrw: valuation.cryptoValueKrw,
            totalAssetKrw,
          }),
        ],
      };
    } catch (error) {
      return this.sectionUnavailableFromError({
        section: 'allocation',
        error,
        sectionErrors,
        fallbackMessage:
          'Allocation is unavailable because required market data is missing.',
      });
    }
  }

  private buildAllocationItem(input: {
    category: string;
    label: string;
    amountKrw: string;
    totalAssetKrw: Prisma.Decimal;
  }) {
    const amountKrw = new Prisma.Decimal(input.amountKrw);
    const rate = amountKrw.div(input.totalAssetKrw);

    return {
      category: input.category,
      label: input.label,
      amountKrw: this.formatDecimal(amountKrw, 8),
      rate: this.formatDecimal(rate, 8),
      percentage: this.formatDecimal(rate.mul(100), 8),
    };
  }

  private async buildTopPositions(
    seasonParticipantId: string,
    sectionErrors: SectionError[],
    valuationAt: Date,
  ) {
    try {
      const positions = await this.prisma.position.findMany({
        where: {
          seasonParticipantId,
          quantity: {
            gt: 0,
          },
        },
        select: {
          id: true,
          assetId: true,
          quantity: true,
          averageCost: true,
          currencyCode: true,
          asset: {
            select: {
              symbol: true,
              name: true,
              market: true,
              assetType: true,
              currencyCode: true,
            },
          },
        },
      });

      const openPositions = positions.filter(
        (position) => !position.quantity.eq(0),
      );

      if (openPositions.length === 0) {
        return {
          state: 'available',
          positionsSource: 'positions',
          valuationAt: valuationAt.toISOString(),
          limit: TOP_POSITIONS_LIMIT,
          items: [],
        };
      }

      const needsUsdConversion = openPositions.some(
        (position) => position.currencyCode === CurrencyCode.USD,
      );
      const usdKrwSnapshot = needsUsdConversion
        ? await this.findLatestEligibleUsdKrwSnapshot(valuationAt)
        : null;
      const usdKrwRate = usdKrwSnapshot
        ? this.selectUsableUsdKrwRate(usdKrwSnapshot, valuationAt)
        : null;

      const itemsWithSortValue = await Promise.all(
        openPositions.map(async (position) => {
          if (position.asset.currencyCode !== position.currencyCode) {
            throw new PortfolioValuationError(
              'ASSET_PRICE_UNAVAILABLE',
              `Position currency mismatch for asset ${position.assetId}.`,
            );
          }

          const priceSnapshot = await this.findLatestEligibleAssetPriceSnapshot(
            {
              id: position.assetId,
              assetType: position.asset.assetType,
              market: position.asset.market,
              currencyCode: position.asset.currencyCode,
            },
            position.currencyCode,
            valuationAt,
          );
          const quantity = position.quantity;
          const averageCost = position.averageCost;
          const currentPrice = priceSnapshot.price;
          const positionValue = quantity.mul(currentPrice);
          const positionValueKrw = this.convertToKrw(
            positionValue,
            position.currencyCode,
            usdKrwRate,
          );
          const unrealizedPnl = currentPrice.sub(averageCost).mul(quantity);
          const unrealizedPnlKrw = this.convertToKrw(
            unrealizedPnl,
            position.currencyCode,
            usdKrwRate,
          );
          const returnRate = averageCost.eq(0)
            ? new Prisma.Decimal(0)
            : currentPrice.sub(averageCost).div(averageCost).mul(100);

          return {
            sortValueKrw: positionValueKrw,
            item: {
              positionId: position.id,
              assetId: position.assetId,
              symbol: position.asset.symbol,
              name: position.asset.name,
              market: position.asset.market,
              assetType: position.asset.assetType,
              currencyCode: position.asset.currencyCode,
              quantity: this.formatDecimal(quantity, 8),
              averageCost: this.formatDecimal(averageCost, 8),
              currentPrice: this.formatDecimal(currentPrice, 8),
              priceCurrency: priceSnapshot.currencyCode,
              positionValueKrw: this.formatDecimal(positionValueKrw, 8),
              unrealizedPnlKrw: this.formatDecimal(unrealizedPnlKrw, 8),
              returnRate: this.formatDecimal(returnRate, 8),
              assetPriceSnapshotId: priceSnapshot.id,
              priceEffectiveAt: priceSnapshot.effectiveAt.toISOString(),
              priceCapturedAt: priceSnapshot.capturedAt.toISOString(),
              priceSource: presentSourceDecision(priceSnapshot.sourceDecision),
              ...(position.currencyCode === CurrencyCode.USD && usdKrwSnapshot
                ? {
                    fxRateSource: presentSourceDecision(
                      usdKrwSnapshot.sourceDecision,
                    ),
                  }
                : {}),
            },
          };
        }),
      );

      const items = itemsWithSortValue
        .sort((left, right) => {
          if (right.sortValueKrw.gt(left.sortValueKrw)) {
            return 1;
          }

          if (right.sortValueKrw.lt(left.sortValueKrw)) {
            return -1;
          }

          return left.item.assetId.localeCompare(right.item.assetId);
        })
        .slice(0, TOP_POSITIONS_LIMIT)
        .map(({ item }) => item);

      return {
        state: 'available',
        positionsSource: 'positions',
        valuationAt: valuationAt.toISOString(),
        limit: TOP_POSITIONS_LIMIT,
        items,
      };
    } catch (error) {
      return this.sectionUnavailableFromError({
        section: 'topPositions',
        error,
        sectionErrors,
        fallbackMessage:
          'Top positions are unavailable because required market data is missing.',
      });
    }
  }

  private async buildEquityChart(seasonParticipantId: string) {
    const snapshots = await this.prisma.dailyPortfolioSnapshot.findMany({
      where: {
        seasonParticipantId,
      },
      orderBy: [
        { snapshotDate: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: EQUITY_CHART_LIMIT,
      select: {
        snapshotDate: true,
        totalAssetKrw: true,
        returnRate: true,
        capturedAt: true,
      },
    });

    if (snapshots.length === 0) {
      return {
        ...this.fallback(
          'unavailable',
          'EQUITY_CHART_UNAVAILABLE',
          'Equity chart is unavailable until daily portfolio snapshots exist.',
        ),
        chartSource: 'daily_portfolio_snapshots',
        items: [],
      };
    }

    return {
      state: 'available',
      chartSource: 'daily_portfolio_snapshots',
      limit: EQUITY_CHART_LIMIT,
      items: snapshots.reverse().map((snapshot) => ({
        snapshotDate: this.formatDateOnly(snapshot.snapshotDate),
        date: this.formatDateOnly(snapshot.snapshotDate),
        totalAssetKrw: this.formatDecimal(snapshot.totalAssetKrw, 8),
        returnRate: this.formatDecimal(snapshot.returnRate, 8),
        capturedAt: snapshot.capturedAt.toISOString(),
      })),
    };
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
        maxDrawdown: true,
        totalFillCount: true,
        reachedReturnAt: true,
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
      maxDrawdown: this.formatDecimal(ranking.maxDrawdown, 8),
      totalFillCount: ranking.totalFillCount,
      reachedReturnAt: ranking.reachedReturnAt?.toISOString() ?? null,
      capturedAt: ranking.capturedAt.toISOString(),
    };
  }

  private buildWalletSummary(participant: JoinedParticipant) {
    const walletByCurrency = new Map(
      participant.cashWallets.map((wallet) => [wallet.currencyCode, wallet]),
    );
    const zeroAmount = new Prisma.Decimal(0);

    return {
      state: 'available',
      KRW: this.formatDecimal(
        walletByCurrency.get(CurrencyCode.KRW)?.balanceAmount ?? zeroAmount,
        8,
      ),
      USD: this.formatDecimal(
        walletByCurrency.get(CurrencyCode.USD)?.balanceAmount ?? zeroAmount,
        8,
      ),
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

  private async findLatestEligibleAssetPriceSnapshot(
    asset: {
      id: string;
      assetType: AssetType;
      market: string;
      currencyCode: CurrencyCode;
    },
    currencyCode: CurrencyCode,
    valuationAt: Date,
  ) {
    const providerEligibility = resolveAssetProviderEligibility({
      workflow: 'home_live_valuation',
      asset,
    });
    const providerCandidates = providerEligibility.eligible
      ? ((await this.prisma.assetPriceSnapshot.findMany({
          where: {
            assetId: asset.id,
            currencyCode,
            sourceType: AssetPriceSourceType.provider_api,
          },
          orderBy: [
            { effectiveAt: 'desc' },
            { capturedAt: 'desc' },
            { createdAt: 'desc' },
          ],
          take: 10,
          select: {
            id: true,
            price: true,
            currencyCode: true,
            sourceType: true,
            sourceName: true,
            effectiveAt: true,
            capturedAt: true,
          },
        })) ?? [])
      : [];
    const providerSelection = providerEligibility.eligible
      ? selectMarketAwareAssetPriceSnapshotBySourcePriority({
          asset,
          workflow: 'home_live_valuation',
          candidates: providerCandidates,
          expectedSourceNames: providerEligibility.sourceNames,
          now: valuationAt,
          freshnessThresholdSeconds:
            providerEligibility.freshnessThresholdSeconds,
          isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
        })
      : {
          state: 'not_selected' as const,
          decision: {
            selectedSourceType: null,
            selectedSourceName: null,
            selectedSnapshotId: null,
            selectedEffectiveAt: null,
            selectedCapturedAt: null,
            fallbackUsed: true,
            fallbackReason: providerEligibility.reason,
            rejectedProviderReason: null,
            freshnessAgeSeconds: null,
          },
        };

    if (providerSelection.state === 'selected') {
      return {
        ...providerSelection.snapshot,
        sourceDecision: providerSelection.decision,
      };
    }

    const snapshot = await this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: asset.id,
        currencyCode,
        sourceType: AssetPriceSourceType.admin_manual,
        effectiveAt: {
          lte: valuationAt,
        },
        price: {
          gt: 0,
        },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        price: true,
        currencyCode: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });

    if (!snapshot) {
      throw new PortfolioValuationError(
        'ASSET_PRICE_UNAVAILABLE',
        `Asset price snapshot is unavailable for asset ${asset.id}.`,
      );
    }

    const sourceDecision = buildAdminManualFallbackDecision({
      selectedSnapshotId: snapshot.id,
      selectedSourceName: snapshot.sourceName,
      selectedEffectiveAt: snapshot.effectiveAt,
      selectedCapturedAt: snapshot.capturedAt,
      providerDecision: providerSelection.decision,
    });

    return {
      ...snapshot,
      sourceDecision,
    };
  }

  private async findLatestEligibleUsdKrwSnapshot(valuationAt: Date) {
    const providerEligibility = resolveFxProviderEligibility({
      workflow: 'home_live_valuation',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    });
    const providerCandidates = providerEligibility.eligible
      ? ((await this.prisma.fxRateSnapshot.findMany({
          where: {
            baseCurrency: CurrencyCode.USD,
            quoteCurrency: CurrencyCode.KRW,
            sourceType: FxRateSourceType.provider_api,
          },
          orderBy: [
            { effectiveAt: 'desc' },
            { capturedAt: 'desc' },
            { createdAt: 'desc' },
          ],
          take: 10,
          select: {
            id: true,
            rate: true,
            sourceType: true,
            sourceName: true,
            effectiveAt: true,
            capturedAt: true,
            approvedByUserId: true,
          },
        })) ?? [])
      : [];
    const providerSelection = providerEligibility.eligible
      ? selectFreshProviderSnapshotBySourcePriority({
          candidates: providerCandidates,
          expectedSourceNames: providerEligibility.sourceNames,
          now: valuationAt,
          freshnessThresholdSeconds:
            providerEligibility.freshnessThresholdSeconds,
          isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
        })
      : {
          state: 'not_selected' as const,
          decision: {
            selectedSourceType: null,
            selectedSourceName: null,
            selectedSnapshotId: null,
            selectedEffectiveAt: null,
            selectedCapturedAt: null,
            fallbackUsed: true,
            fallbackReason: providerEligibility.reason,
            rejectedProviderReason: null,
            freshnessAgeSeconds: null,
          },
        };

    if (providerSelection.state === 'selected') {
      return {
        ...providerSelection.snapshot,
        sourceDecision: providerSelection.decision,
      };
    }

    const snapshot = await this.prisma.fxRateSnapshot.findFirst({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        sourceType: FxRateSourceType.admin_manual,
        approvedByUserId: {
          not: null,
        },
        effectiveAt: {
          lte: valuationAt,
        },
        rate: {
          gt: 0,
        },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        rate: true,
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
        approvedByUserId: true,
      },
    });

    if (!snapshot) {
      throw new PortfolioValuationError(
        'FX_RATE_UNAVAILABLE',
        'USD/KRW FX rate snapshot is unavailable.',
      );
    }

    const sourceDecision = buildAdminManualFallbackDecision({
      selectedSnapshotId: snapshot.id,
      selectedSourceName: snapshot.sourceName,
      selectedEffectiveAt: snapshot.effectiveAt,
      selectedCapturedAt: snapshot.capturedAt,
      providerDecision: providerSelection.decision,
    });

    return {
      ...snapshot,
      sourceDecision,
    };
  }

  private selectUsableUsdKrwRate(
    snapshot: {
      rate: Prisma.Decimal;
      sourceType: FxRateSourceType;
      effectiveAt: Date;
      approvedByUserId: string | null;
    },
    valuationAt: Date,
  ) {
    if (snapshot.sourceType === FxRateSourceType.provider_api) {
      return snapshot.rate;
    }

    if (!snapshot.approvedByUserId) {
      throw new PortfolioValuationError(
        'FX_RATE_UNAVAILABLE',
        'No approved admin_manual USD/KRW FX rate snapshot is available.',
      );
    }

    if (
      isFxSnapshotStaleForPortfolioValuation(snapshot.effectiveAt, valuationAt)
    ) {
      throw new PortfolioValuationError(
        'FX_RATE_STALE',
        'USD/KRW FX rate snapshot is stale.',
      );
    }

    return snapshot.rate;
  }

  private convertToKrw(
    amount: Prisma.Decimal,
    currencyCode: CurrencyCode,
    usdKrwRate: Prisma.Decimal | null,
  ) {
    if (currencyCode === CurrencyCode.KRW) {
      return amount;
    }

    if (!usdKrwRate) {
      throw new PortfolioValuationError(
        'FX_RATE_UNAVAILABLE',
        'USD/KRW FX rate snapshot is required for USD conversion.',
      );
    }

    return amount.mul(usdKrwRate);
  }

  private sectionUnavailableFromError(input: {
    section: string;
    error: unknown;
    sectionErrors: SectionError[];
    fallbackMessage: string;
  }) {
    const code =
      input.error instanceof PortfolioValuationError
        ? input.error.code
        : `${input.section.toUpperCase()}_UNAVAILABLE`;
    const message =
      input.error instanceof Error
        ? input.error.message
        : input.fallbackMessage;

    input.sectionErrors.push({
      section: input.section,
      code,
      message,
    });

    return this.fallback('unavailable', code, input.fallbackMessage);
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

  private throwApiError(
    status: HttpStatus,
    code: string,
    message: string,
  ): never {
    throw new HttpException(this.createErrorBody(code, message), status);
  }
}
