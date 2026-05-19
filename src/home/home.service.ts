import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  AssetPriceSourceType,
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
    const getLiveValuation = this.createLiveValuationLoader(participant.id);
    const [summary, ranking, allocation, topPositions, equityChart] =
      await Promise.all([
        this.buildSummary(participant, sectionErrors, getLiveValuation),
        this.buildRanking(season.id, participant.id),
        this.buildAllocation(sectionErrors, getLiveValuation),
        this.buildTopPositions(participant.id, sectionErrors),
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
          'EQUITY_CHART_UNAVAILABLE',
          'Equity chart is unavailable for settled seasons until a participant-specific final result view is defined.',
        ),
      },
    };
  }

  private createLiveValuationLoader(seasonParticipantId: string) {
    let valuationPromise: Promise<PortfolioValuationResult> | null = null;

    return () => {
      valuationPromise ??=
        this.portfolioValuationService.calculateSeasonParticipantValuation(
          seasonParticipantId,
        );

      return valuationPromise;
    };
  }

  private async buildSummary(
    participant: JoinedParticipant,
    sectionErrors: SectionError[],
    getLiveValuation: () => Promise<PortfolioValuationResult>,
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
  ) {
    const valuationAt = new Date();

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
      const usdKrwRate = needsUsdConversion
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
            position.assetId,
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
            : currentPrice.sub(averageCost).div(averageCost);

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

  private async findLatestEligibleAssetPriceSnapshot(
    assetId: string,
    currencyCode: CurrencyCode,
    valuationAt: Date,
  ) {
    const snapshot = await this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId,
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
        effectiveAt: true,
        capturedAt: true,
      },
    });

    if (!snapshot) {
      throw new PortfolioValuationError(
        'ASSET_PRICE_UNAVAILABLE',
        `Asset price snapshot is unavailable for asset ${assetId}.`,
      );
    }

    return snapshot;
  }

  private async findLatestEligibleUsdKrwSnapshot(valuationAt: Date) {
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

    return snapshot;
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
    if (
      snapshot.sourceType !== FxRateSourceType.admin_manual ||
      !snapshot.approvedByUserId
    ) {
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
