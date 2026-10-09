import {
  buildSelectionFailureEvidence,
  describeManualFallback,
} from '../providers/source-selection-diagnostics';
import { fxExecuteSnapshotFreshnessThresholdMs } from '../fx/fx-execute-snapshot-policy';
import {
  buildAdminPartialFailureDiagnostic,
  preserveAdminFailureCause,
  type AdminDiagnostic,
  type DiagnosticContextUpdate,
} from '../common/admin-diagnostics';
import {
  MARKET_EXECUTION_SELECT,
  presentMarketExecution,
  type OrderResponsePayload,
} from '../orders/order-response.presenter';
import {
  readPortfolioAccess,
  type PortfolioAccess,
} from '../friends/friendship.policy';
import type { FriendPortfolio } from '../friends/friend-portfolio.types';
import { PositionsService } from '../positions/positions.service';
import { readFuturesHoldingSummaries } from '../futures/futures-position-display';
import {
  closedMarketPriceScope,
  findMarketAwareAssetPriceCandidates,
} from '../providers/asset-price-snapshot-query';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  AssetPriceSourceType,
  CurrencyCode,
  AssetType,
  FxRateSourceType,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import { buildPagination, type Pagination } from '../common/pagination';
import { isFxSnapshotStaleForPortfolioValuation } from '../portfolio/portfolio-valuation.policy';
import {
  calculatePositionValuation,
  PortfolioValuationError,
  type PortfolioValuationResult,
} from '../portfolio/portfolio-valuation.policy';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertSeasonRankingScope,
  assertSeasonRankingScopeForParticipant,
  SEASON_RANKING_SCOPE_SELECT,
} from '../ranking/season-ranking-scope';
import { assertSeasonRankingSetScope } from '../ranking/season-ranking-set-scope';
import {
  calculateMaxDrawdownPercent,
  type RankingHistoricalSnapshotInput,
} from '../ranking/ranking-calculation.policy';
import {
  assignRankingTier,
  calculateRankingPercentile,
} from '../ranking/ranking-tier.policy';
import {
  isPositiveDecimal,
  resolveAssetProviderEligibility,
  resolveFxProviderEligibility,
  selectFreshProviderSnapshotBySourcePriority,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
} from '../providers/source-eligibility.policy';
import { findUsdKrwProviderSnapshotCandidates } from '../providers/fx-rate-snapshot-query';

export type RecordsQuery = {
  seasonId?: string;
  type?: string;
  limit?: string;
  offset?: string;
  currencyCode?: string;
};

export type MySeasonRecordsQuery = {
  limit?: string;
  offset?: string;
  seasonStatus?: string;
};

export type MySeasonOrdersQuery = {
  status?: string;
  side?: string;
  assetId?: string;
  limit?: string;
  offset?: string;
};

export type MySeasonExchangesQuery = {
  fromCurrency?: string;
  toCurrency?: string;
  limit?: string;
  offset?: string;
};

export type MySeasonEquityQuery = {
  limit?: string;
  offset?: string;
};

type RecordsType = 'all' | 'exchanges' | 'wallets' | 'orders';
type RecordsState = 'available' | 'not_joined' | 'unavailable';
type SeasonHistoryState = 'available' | 'empty';
type SeasonRecordDetailState = 'available' | 'not_joined';
type SeasonEquityState = 'available' | 'empty' | 'not_joined';
type SectionState = 'available' | 'unavailable';
type PerformanceState = 'available' | 'unavailable';
type ProfitAnalysisState = 'available' | 'unavailable' | 'partial_unavailable';
type ValuationErrorCode =
  | 'ASSET_PRICE_UNAVAILABLE'
  | 'PRICE_STALE'
  | 'FX_RATE_UNAVAILABLE'
  | 'FX_RATE_STALE';

type RecordsSeason = {
  id: string;
  name: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
};

type RecordsParticipant = {
  id: string;
  tradingAccountId: string;
  participantStatus: ParticipantStatus;
  joinedAt: Date;
};

type ParticipantPublicVisibility = {
  participantStatus: ParticipantStatus;
  rankingHiddenAt: Date | null;
};

type ParsedRecordsQuery = {
  seasonId?: string;
  type: RecordsType;
  limit: number;
  offset: number;
  currencyCode?: CurrencyCode;
};

type ParsedMySeasonRecordsQuery = {
  seasonStatus?: SeasonStatus;
  limit: number;
  offset: number;
};

type ParsedMySeasonOrdersQuery = {
  status?: OrderStatus;
  side?: OrderSide;
  assetId?: string;
  limit: number;
  offset: number;
};

type ParsedMySeasonExchangesQuery = {
  fromCurrency?: CurrencyCode;
  toCurrency?: CurrencyCode;
  limit: number;
  offset: number;
};

type ParsedMySeasonEquityQuery = {
  limit: number;
  offset: number;
};

type SectionPagination = Pagination;
type ListPagination = Pagination;

type SeasonRecordMetric = {
  totalAssetKrw: Prisma.Decimal;
  returnRate: Prisma.Decimal;
  metricDate: Date;
  capturedAt: Date;
};

type ProfitPositionRecord = {
  id: string;
  assetId: string;
  quantity: Prisma.Decimal;
  averageCost: Prisma.Decimal;
  currencyCode: CurrencyCode;
  realizedPnl: Prisma.Decimal;
  realizedPnlKrw: Prisma.Decimal;
  asset: {
    id: string;
    symbol: string;
    name: string;
    market: string;
    assetType: AssetType;
    currencyCode: CurrencyCode;
  };
};

type AssetPriceForRecords = {
  id: string;
  price: Prisma.Decimal;
  currencyCode: CurrencyCode;
  sourceType: AssetPriceSourceType;
  sourceName: string | null;
  effectiveAt: Date;
  capturedAt: Date;
};

type UsdKrwForRecords =
  | {
      state: 'available';
      rate: Prisma.Decimal;
    }
  | {
      state: 'unavailable';
      code: 'FX_RATE_UNAVAILABLE' | 'FX_RATE_STALE';
      message: string;
      diagnosticContext?: DiagnosticContextUpdate;
    };

type ProfitAnalysisItem = {
  assetId: string;
  symbol: string;
  name: string;
  market: string;
  assetType: AssetType;
  currencyCode: CurrencyCode;
  realizedPnlLocal: string;
  realizedPnlKrw: string;
  unrealizedPnlLocal: string;
  unrealizedPnlKrw: string;
  totalPnlKrw: string;
  returnRate: string | null;
  returnRateState: 'available' | 'unavailable';
  positionState: 'open' | 'fully_sold';
  valuationState: 'available' | 'unavailable';
};

type ProfitAnalysis = {
  state: ProfitAnalysisState;
  totalRealizedPnlKrw: string;
  totalUnrealizedPnlKrw: string;
  totalPnlKrw: string;
  bestAsset: ProfitAnalysisItem | null;
  worstAsset: ProfitAnalysisItem | null;
  items: ProfitAnalysisItem[];
  valuationErrors: Array<{
    assetId: string;
    code: ValuationErrorCode;
    message: string;
    diagnostic?: AdminDiagnostic;
  }>;
};

type RecordsResponse = {
  success: true;
  data: {
    state: RecordsState;
    season: ReturnType<RecordsService['formatSeason']> | null;
    participant: ReturnType<RecordsService['formatParticipant']> | null;
    type: RecordsType;
    filters: {
      currencyCode: CurrencyCode | null;
    };
    exchanges?: {
      state: SectionState;
      pagination: SectionPagination;
      records: Array<{
        exchangeId: string;
        executedAt: string;
        fromCurrency: CurrencyCode;
        toCurrency: CurrencyCode;
        sourceAmount: string;
        grossTargetAmount: string;
        feeRate: string;
        feeAmount: string;
        feeCurrency: CurrencyCode;
        appliedRate: string;
        netTargetAmount: string;
        fxRateSnapshotId: string | null;
        createdAt: string;
      }>;
    };
    walletTransactions?: {
      state: SectionState;
      pagination: SectionPagination;
      records: Array<{
        walletTransactionId: string;
        walletId: string;
        currencyCode: CurrencyCode;
        direction: string;
        transactionType: string;
        amount: string;
        balanceAfter: string;
        referenceType: string;
        referenceId: string | null;
        occurredAt: string;
        createdAt: string;
      }>;
    };
    orders?: {
      state: SectionState;
      pagination: SectionPagination;
      records: Array<{
        orderId: string;
        submittedAt: string;
        executedAt: string | null;
        canceledAt: string | null;
        rejectedAt: string | null;
        assetId: string;
        symbol: string;
        name: string;
        side: OrderSide;
        orderType: OrderType;
        status: OrderStatus;
        quantity: string;
        marketExecution?: OrderResponsePayload['marketExecution'];
        limitPrice: string | null;
        executedPrice: string | null;
        currencyCode: CurrencyCode;
        grossAmount: string | null;
        feeAmount: string | null;
        netAmount: string | null;
        assetPriceSnapshotId: string | null;
        fxRateSnapshotId: string | null;
        createdAt: string;
      }>;
    };
    reason?: string;
    message?: string;
  };
};

type MySeasonRecordsResponse = {
  success: true;
  data: {
    state: SeasonHistoryState;
    seasons: Array<{
      seasonId: string;
      seasonName: string;
      seasonStatus: SeasonStatus;
      joinedAt: string;
      participantStatus: ParticipantStatus;
      initialCapitalKrw: string;
      finalRank: number | null;
      finalTier: string | null;
      rewardGrantedAt: string | null;
      latestTotalAssetKrw: string | null;
      latestReturnRate: string | null;
      orderCount: number;
      exchangeCount: number;
      walletTransactionCount: number;
    }>;
    pagination: ListPagination;
    filters: {
      seasonStatus: SeasonStatus | null;
    };
  };
};

type MySeasonRecordDetailResponse = {
  success: true;
  data: {
    state: SeasonRecordDetailState;
    season: ReturnType<RecordsService['formatSeason']>;
    participant: {
      id: string;
      joinedAt: string;
      participantStatus: ParticipantStatus;
      initialCapitalKrw: string;
      finalRank: number | null;
      finalTier: string | null;
      rewardGrantedAt: string | null;
    } | null;
    performance: {
      state: PerformanceState;
      totalAssetKrw: string | null;
      returnRate: string | null;
      maxDrawdown: string | null;
      snapshotDate: string | null;
      capturedAt: string | null;
      reason?: string;
      message?: string;
    };
    activitySummary: {
      orders: {
        total: number;
        submitted: number;
        executed: number;
        canceled: number;
        rejected: number;
      };
      exchanges: {
        total: number;
      };
      walletTransactions: {
        total: number;
      };
      positions: {
        open: number;
      };
    };
    profitAnalysis: ProfitAnalysis;
    reason?: string;
    message?: string;
  };
};

type MySeasonOrdersResponse = {
  success: true;
  data: {
    state: SeasonRecordDetailState;
    seasonId: string;
    filters: {
      status: OrderStatus | null;
      side: OrderSide | null;
      assetId: string | null;
    };
    orders: Array<{
      orderId: string;
      assetId: string;
      symbol: string;
      name: string;
      market: string;
      assetType: AssetType;
      side: OrderSide;
      orderType: OrderType;
      status: OrderStatus;
      quantity: string;
      marketExecution?: OrderResponsePayload['marketExecution'];
      limitPrice: string | null;
      executedPrice: string | null;
      currencyCode: CurrencyCode;
      grossAmount: string | null;
      feeAmount: string | null;
      netAmount: string | null;
      reservedAmount: string | null;
      reservationReleasedAt: string | null;
      cancelReason: string | null;
      submittedAt: string;
      executedAt: string | null;
      canceledAt: string | null;
      rejectedAt: string | null;
      rejectReason: string | null;
    }>;
    pagination: ListPagination;
    reason?: string;
    message?: string;
  };
};

type MySeasonExchangesResponse = {
  success: true;
  data: {
    state: SeasonRecordDetailState;
    seasonId: string;
    filters: {
      fromCurrency: CurrencyCode | null;
      toCurrency: CurrencyCode | null;
    };
    exchanges: Array<{
      exchangeId: string;
      fromCurrency: CurrencyCode;
      toCurrency: CurrencyCode;
      sourceAmount: string;
      grossTargetAmount: string;
      feeRate: string;
      feeAmount: string;
      feeCurrency: CurrencyCode;
      appliedRate: string;
      netTargetAmount: string;
      executedAt: string;
    }>;
    pagination: ListPagination;
    reason?: string;
    message?: string;
  };
};

type MySeasonEquityResponse = {
  success: true;
  data: {
    state: SeasonEquityState;
    seasonId: string;
    points: Array<{
      time: string;
      totalAssetKrw: string;
      returnRate: string | null;
      capturedAt: string;
    }>;
    pagination: ListPagination;
    reason?: string;
    message?: string;
  };
};

type UserSeasonRecordSummaryResponse = {
  success: true;
  data: {
    state: SeasonRecordDetailState;
    user: {
      id: string;
      nickname: string;
      profileImageUrl: string | null;
    };
    season: {
      id: string;
      name: string;
      status: SeasonStatus;
    };
    summary: {
      currentRank: number | null;
      currentTier: string | null;
      finalRank: number | null;
      finalTier: string | null;
      rewardGranted: boolean;
      totalAssetKrw: string | null;
      returnRate: string | null;
    } | null;
    portfolio: null;
    portfolioAccess: 'unavailable';
    portfolioReason: 'USE_CURRENT_SEASON_SUMMARY';
    reason?: string;
    message?: string;
  };
};

type UserCurrentSeasonSummaryResponse = {
  success: true;
  data: {
    state: 'available' | 'not_joined' | 'unavailable';
    user: { id: string; nickname: string; profileImageUrl: string | null };
    season: {
      id: string;
      name: string;
      status: SeasonStatus;
      rank: number | null;
      provisionalTier: string | null;
      finalTier: string | null;
      percentile: string | null;
      returnRate: string | null;
      totalAssetKrw: string | null;
      maxDrawdown: string | null;
      totalFillCount: number;
    } | null;
    portfolioAccess: PortfolioAccess;
    portfolioReason?: string;
    portfolio: FriendPortfolio | null;
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
const DEFAULT_EQUITY_LIMIT = 100;
const MAX_EQUITY_LIMIT = 500;

class RecordsValuationError extends Error {
  constructor(
    readonly code: ValuationErrorCode,
    message: string,
    readonly diagnosticContext?: DiagnosticContextUpdate,
  ) {
    super(message);
  }
}

@Injectable()
export class RecordsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly portfolioValuationService?: PortfolioValuationService,
    private readonly positionsService: PositionsService = new PositionsService(
      prisma,
    ),
  ) {}

  async getRecords(
    userId: string | undefined,
    query: RecordsQuery = {},
  ): Promise<RecordsResponse> {
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
        participant: null,
        query: parsedQuery,
        reason: parsedQuery.seasonId
          ? 'SEASON_NOT_FOUND'
          : 'CURRENT_SEASON_NOT_FOUND',
        message: parsedQuery.seasonId
          ? 'Season not found.'
          : 'Current season is not configured.',
      });
    }

    const participant = await this.findParticipant(season.id, userId);
    if (!participant) {
      return {
        success: true,
        data: {
          state: 'not_joined',
          season: this.formatSeason(season),
          participant: null,
          type: parsedQuery.type,
          filters: {
            currencyCode: parsedQuery.currencyCode ?? null,
          },
          ...this.emptyRequestedSections(parsedQuery),
          reason: 'SEASON_NOT_JOINED',
          message: 'Records are available after joining the season.',
        },
      };
    }

    const base = {
      state: 'available',
      season: this.formatSeason(season),
      participant: this.formatParticipant(participant),
      type: parsedQuery.type,
      filters: {
        currencyCode: parsedQuery.currencyCode ?? null,
      },
    } as const;

    const [exchanges, walletTransactions, orders] = await Promise.all([
      parsedQuery.type === 'all' || parsedQuery.type === 'exchanges'
        ? this.buildExchangeSection(participant.tradingAccountId, parsedQuery)
        : Promise.resolve(undefined),
      parsedQuery.type === 'all' || parsedQuery.type === 'wallets'
        ? this.buildWalletTransactionSection(
            participant.tradingAccountId,
            parsedQuery,
          )
        : Promise.resolve(undefined),
      parsedQuery.type === 'all' || parsedQuery.type === 'orders'
        ? this.buildOrderSection(participant.tradingAccountId, parsedQuery)
        : Promise.resolve(undefined),
    ]);

    return {
      success: true,
      data: {
        ...base,
        ...(exchanges ? { exchanges } : {}),
        ...(walletTransactions ? { walletTransactions } : {}),
        ...(orders ? { orders } : {}),
      },
    };
  }

  async getMySeasonRecords(
    userId: string | undefined,
    query: MySeasonRecordsQuery = {},
  ): Promise<MySeasonRecordsResponse> {
    this.assertAuthenticated(userId);

    const parsedQuery = this.parseMySeasonRecordsQuery(query);
    const where = {
      userId,
      ...(parsedQuery.seasonStatus
        ? { season: { status: parsedQuery.seasonStatus } }
        : {}),
    };
    const total = await this.prisma.seasonParticipant.count({ where });

    if (total === 0) {
      return {
        success: true,
        data: {
          state: 'empty',
          seasons: [],
          pagination: this.listPagination(parsedQuery, 0, 0),
          filters: {
            seasonStatus: parsedQuery.seasonStatus ?? null,
          },
        },
      };
    }

    const participants = await this.prisma.seasonParticipant.findMany({
      where,
      orderBy: [
        { season: { startAt: 'desc' } },
        { season: { endAt: 'desc' } },
        { joinedAt: 'desc' },
        { seasonId: 'asc' },
      ],
      skip: parsedQuery.offset,
      take: parsedQuery.limit,
      select: {
        // Scope columns for the ranking verification below (작업 8 §11).
        id: true,
        userId: true,
        tradingAccountId: true,
        tradingAccount: {
          select: {
            id: true,
            mode: true,
            userId: true,
            dailyPortfolioSnapshots: {
              orderBy: [
                { snapshotDate: 'desc' },
                { capturedAt: 'desc' },
                { createdAt: 'desc' },
              ],
              take: 1,
              select: {
                totalAssetKrw: true,
                returnRate: true,
                snapshotDate: true,
                capturedAt: true,
              },
            },
            _count: {
              select: {
                orders: true,
                exchangeTransactions: true,
                walletTransactions: true,
              },
            },
          },
        },
        seasonId: true,
        joinedAt: true,
        participantStatus: true,
        initialCapitalKrw: true,
        maxDrawdown: true,
        totalFillCount: true,
        currentRank: true,
        finalRank: true,
        finalTier: true,
        rewardGrantedAt: true,
        season: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
        seasonRankings: {
          where: {
            rankType: SeasonRankingType.final,
          },
          orderBy: [
            { rankingDate: 'desc' },
            { capturedAt: 'desc' },
            { createdAt: 'desc' },
          ],
          take: 1,
          select: {
            // Scope columns for assertSeasonRankingScopeForParticipant
            // (작업 8 §11); never rendered into a response.
            id: true,
            seasonId: true,
            tradingAccountId: true,
            totalAssetKrw: true,
            returnRate: true,
            rankingDate: true,
            capturedAt: true,
          },
        },
      },
    });

    // Every ranking row backing a record card is verified before ANY card is
    // returned: a mis-scoped row would attribute one account's result to
    // another user's season history (작업 8 §11).
    for (const participant of participants) {
      assertSeasonRankingScopeForParticipant(
        participant,
        participant.seasonRankings,
      );
    }

    return {
      success: true,
      data: {
        state: 'available',
        seasons: participants.map((participant) => {
          const metric = this.selectBestMetric(
            participant.seasonRankings[0],
            participant.tradingAccount.dailyPortfolioSnapshots[0],
          );

          return {
            seasonId: participant.season.id,
            seasonName: participant.season.name,
            seasonStatus: participant.season.status,
            joinedAt: participant.joinedAt.toISOString(),
            participantStatus: participant.participantStatus,
            initialCapitalKrw: this.formatDecimal(
              participant.initialCapitalKrw,
              8,
            ),
            finalRank: participant.finalRank,
            finalTier: participant.finalTier,
            rewardGrantedAt: this.formatNullableDate(
              participant.rewardGrantedAt,
            ),
            latestTotalAssetKrw: metric
              ? this.formatDecimal(metric.totalAssetKrw, 8)
              : null,
            latestReturnRate: metric
              ? this.formatDecimal(metric.returnRate, 8)
              : null,
            orderCount: participant.tradingAccount._count.orders,
            exchangeCount:
              participant.tradingAccount._count.exchangeTransactions,
            walletTransactionCount:
              participant.tradingAccount._count.walletTransactions,
          };
        }),
        pagination: this.listPagination(
          parsedQuery,
          total,
          participants.length,
        ),
        filters: {
          seasonStatus: parsedQuery.seasonStatus ?? null,
        },
      },
    };
  }

  async getMySeasonRecordDetail(
    userId: string | undefined,
    seasonId: string | undefined,
  ): Promise<MySeasonRecordDetailResponse> {
    this.assertAuthenticated(userId);

    const parsedSeasonId = this.parseRequiredText(
      seasonId,
      'INVALID_SEASON_ID',
      'seasonId',
    );
    const season = await this.findSeasonByIdOrThrow(parsedSeasonId);
    const participant = await this.findDetailedParticipant(season.id, userId);

    if (!participant) {
      return {
        success: true,
        data: {
          state: 'not_joined',
          season: this.formatSeason(season),
          participant: null,
          performance: this.unavailablePerformance(),
          activitySummary: this.emptyActivitySummary(),
          profitAnalysis: this.unavailableProfitAnalysis(),
          reason: 'SEASON_NOT_JOINED',
          message: 'Season records are available after joining the season.',
        },
      };
    }

    const [
      submittedOrders,
      executedOrders,
      canceledOrders,
      rejectedOrders,
      openPositions,
      snapshotHistory,
      profitAnalysis,
    ] = await Promise.all([
      this.countOrders(participant.tradingAccountId, OrderStatus.submitted),
      this.countOrders(participant.tradingAccountId, OrderStatus.executed),
      this.countOrders(participant.tradingAccountId, OrderStatus.canceled),
      this.countOrders(participant.tradingAccountId, OrderStatus.rejected),
      this.prisma.position.count({
        where: {
          tradingAccountId: participant.tradingAccountId,
          quantity: {
            gt: 0,
          },
        },
      }),
      this.findSnapshotHistory(participant.id, participant.tradingAccountId),
      this.buildProfitAnalysis(participant.tradingAccountId, new Date()),
    ]);

    return {
      success: true,
      data: {
        state: 'available',
        season: this.formatSeason(season),
        participant: this.formatDetailedParticipant(participant),
        performance: this.formatPerformance(
          participant.tradingAccount.dailyPortfolioSnapshots[0],
          participant.seasonRankings[0],
          this.calculateMdd(participant.maxDrawdown, snapshotHistory),
        ),
        activitySummary: {
          orders: {
            total: participant.tradingAccount._count.orders,
            submitted: submittedOrders,
            executed: executedOrders,
            canceled: canceledOrders,
            rejected: rejectedOrders,
          },
          exchanges: {
            total: participant.tradingAccount._count.exchangeTransactions,
          },
          walletTransactions: {
            total: participant.tradingAccount._count.walletTransactions,
          },
          positions: {
            open: openPositions,
          },
        },
        profitAnalysis,
      },
    };
  }

  async getMySeasonEquity(
    userId: string | undefined,
    seasonId: string | undefined,
    query: MySeasonEquityQuery = {},
  ): Promise<MySeasonEquityResponse> {
    this.assertAuthenticated(userId);

    const parsedSeasonId = this.parseRequiredText(
      seasonId,
      'INVALID_SEASON_ID',
      'seasonId',
    );
    const parsedQuery = this.parseMySeasonEquityQuery(query);
    await this.findSeasonByIdOrThrow(parsedSeasonId);
    const participant = await this.findParticipant(parsedSeasonId, userId);

    if (!participant) {
      return {
        success: true,
        data: {
          state: 'not_joined',
          seasonId: parsedSeasonId,
          points: [],
          pagination: this.listPagination(parsedQuery, 0, 0),
          reason: 'SEASON_NOT_JOINED',
          message:
            'Season equity history is available after joining the season.',
        },
      };
    }

    const where = {
      tradingAccountId: participant.tradingAccountId,
    };
    const [total, snapshots] = await Promise.all([
      this.prisma.dailyPortfolioSnapshot.count({ where }),
      this.prisma.dailyPortfolioSnapshot.findMany({
        where,
        orderBy: [
          { snapshotDate: 'asc' },
          { capturedAt: 'asc' },
          { createdAt: 'asc' },
        ],
        skip: parsedQuery.offset,
        take: parsedQuery.limit,
        select: {
          snapshotDate: true,
          totalAssetKrw: true,
          returnRate: true,
          capturedAt: true,
        },
      }),
    ]);

    if (total === 0) {
      return {
        success: true,
        data: {
          state: 'empty',
          seasonId: parsedSeasonId,
          points: [],
          pagination: this.listPagination(parsedQuery, 0, 0),
          reason: 'EQUITY_HISTORY_EMPTY',
          message: 'Season equity history is not available yet.',
        },
      };
    }

    return {
      success: true,
      data: {
        state: 'available',
        seasonId: parsedSeasonId,
        points: snapshots.map((snapshot) => ({
          time: this.formatDateOnly(snapshot.snapshotDate),
          totalAssetKrw: this.formatDecimal(snapshot.totalAssetKrw, 8),
          returnRate: this.formatNullableDecimal(snapshot.returnRate, 8),
          capturedAt: snapshot.capturedAt.toISOString(),
        })),
        pagination: this.listPagination(parsedQuery, total, snapshots.length),
      },
    };
  }

  async getMySeasonOrders(
    userId: string | undefined,
    seasonId: string | undefined,
    query: MySeasonOrdersQuery = {},
  ): Promise<MySeasonOrdersResponse> {
    this.assertAuthenticated(userId);

    const parsedSeasonId = this.parseRequiredText(
      seasonId,
      'INVALID_SEASON_ID',
      'seasonId',
    );
    const parsedQuery = this.parseMySeasonOrdersQuery(query);
    await this.findSeasonByIdOrThrow(parsedSeasonId);
    const participant = await this.findParticipant(parsedSeasonId, userId);

    if (!participant) {
      return {
        success: true,
        data: {
          state: 'not_joined',
          seasonId: parsedSeasonId,
          filters: {
            status: parsedQuery.status ?? null,
            side: parsedQuery.side ?? null,
            assetId: parsedQuery.assetId ?? null,
          },
          orders: [],
          pagination: this.listPagination(parsedQuery, 0, 0),
          reason: 'SEASON_NOT_JOINED',
          message: 'Order records are available after joining the season.',
        },
      };
    }

    const where = {
      tradingAccountId: participant.tradingAccountId,
      ...(parsedQuery.status ? { status: parsedQuery.status } : {}),
      ...(parsedQuery.side ? { side: parsedQuery.side } : {}),
      ...(parsedQuery.assetId ? { assetId: parsedQuery.assetId } : {}),
    };
    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: [
          { submittedAt: 'desc' },
          { createdAt: 'desc' },
          { id: 'asc' },
        ],
        skip: parsedQuery.offset,
        take: parsedQuery.limit,
        select: {
          id: true,
          assetId: true,
          side: true,
          orderType: true,
          status: true,
          quantity: true,
          ...MARKET_EXECUTION_SELECT,
          cancelReason: true,
          limitPrice: true,
          executedPrice: true,
          currencyCode: true,
          grossAmount: true,
          feeAmount: true,
          netAmount: true,
          reservedAmount: true,
          reservationReleasedAt: true,
          submittedAt: true,
          executedAt: true,
          canceledAt: true,
          rejectedAt: true,
          rejectReason: true,
          asset: {
            select: {
              symbol: true,
              name: true,
              market: true,
              assetType: true,
            },
          },
        },
      }),
    ]);

    return {
      success: true,
      data: {
        state: 'available',
        seasonId: parsedSeasonId,
        filters: {
          status: parsedQuery.status ?? null,
          side: parsedQuery.side ?? null,
          assetId: parsedQuery.assetId ?? null,
        },
        orders: orders.map((order) => ({
          orderId: order.id,
          assetId: order.assetId,
          symbol: order.asset.symbol,
          name: order.asset.name,
          market: order.asset.market,
          assetType: order.asset.assetType,
          side: order.side,
          orderType: order.orderType,
          status: order.status,
          quantity: this.formatDecimal(order.quantity, 8),
          ...presentMarketExecution(order),
          limitPrice: this.formatNullableDecimal(order.limitPrice, 8),
          executedPrice: this.formatNullableDecimal(order.executedPrice, 8),
          currencyCode: order.currencyCode,
          grossAmount: this.formatNullableDecimal(order.grossAmount, 8),
          feeAmount: this.formatNullableDecimal(order.feeAmount, 8),
          netAmount: this.formatNullableDecimal(order.netAmount, 8),
          reservedAmount: this.formatNullableDecimal(order.reservedAmount, 8),
          reservationReleasedAt: this.formatNullableDate(
            order.reservationReleasedAt,
          ),
          cancelReason: order.cancelReason,
          submittedAt: order.submittedAt.toISOString(),
          executedAt: this.formatNullableDate(order.executedAt),
          canceledAt: this.formatNullableDate(order.canceledAt),
          rejectedAt: this.formatNullableDate(order.rejectedAt),
          rejectReason: order.rejectReason,
        })),
        pagination: this.listPagination(parsedQuery, total, orders.length),
      },
    };
  }

  async getMySeasonExchanges(
    userId: string | undefined,
    seasonId: string | undefined,
    query: MySeasonExchangesQuery = {},
  ): Promise<MySeasonExchangesResponse> {
    this.assertAuthenticated(userId);

    const parsedSeasonId = this.parseRequiredText(
      seasonId,
      'INVALID_SEASON_ID',
      'seasonId',
    );
    const parsedQuery = this.parseMySeasonExchangesQuery(query);
    await this.findSeasonByIdOrThrow(parsedSeasonId);
    const participant = await this.findParticipant(parsedSeasonId, userId);

    if (!participant) {
      return {
        success: true,
        data: {
          state: 'not_joined',
          seasonId: parsedSeasonId,
          filters: {
            fromCurrency: parsedQuery.fromCurrency ?? null,
            toCurrency: parsedQuery.toCurrency ?? null,
          },
          exchanges: [],
          pagination: this.listPagination(parsedQuery, 0, 0),
          reason: 'SEASON_NOT_JOINED',
          message: 'Exchange records are available after joining the season.',
        },
      };
    }

    const where = {
      tradingAccountId: participant.tradingAccountId,
      ...(parsedQuery.fromCurrency
        ? { fromCurrency: parsedQuery.fromCurrency }
        : {}),
      ...(parsedQuery.toCurrency ? { toCurrency: parsedQuery.toCurrency } : {}),
    };
    const [total, exchanges] = await Promise.all([
      this.prisma.exchangeTransaction.count({ where }),
      this.prisma.exchangeTransaction.findMany({
        where,
        orderBy: [{ executedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip: parsedQuery.offset,
        take: parsedQuery.limit,
        select: {
          id: true,
          fromCurrency: true,
          toCurrency: true,
          sourceAmount: true,
          grossTargetAmount: true,
          feeRate: true,
          feeAmount: true,
          feeCurrency: true,
          appliedRate: true,
          netTargetAmount: true,
          executedAt: true,
        },
      }),
    ]);

    return {
      success: true,
      data: {
        state: 'available',
        seasonId: parsedSeasonId,
        filters: {
          fromCurrency: parsedQuery.fromCurrency ?? null,
          toCurrency: parsedQuery.toCurrency ?? null,
        },
        exchanges: exchanges.map((exchange) => ({
          exchangeId: exchange.id,
          fromCurrency: exchange.fromCurrency,
          toCurrency: exchange.toCurrency,
          sourceAmount: this.formatDecimal(exchange.sourceAmount, 8),
          grossTargetAmount: this.formatDecimal(exchange.grossTargetAmount, 8),
          feeRate: this.formatDecimal(exchange.feeRate, 6),
          feeAmount: this.formatDecimal(exchange.feeAmount, 8),
          feeCurrency: exchange.feeCurrency,
          appliedRate: this.formatDecimal(exchange.appliedRate, 8),
          netTargetAmount: this.formatDecimal(exchange.netTargetAmount, 8),
          executedAt: exchange.executedAt.toISOString(),
        })),
        pagination: this.listPagination(parsedQuery, total, exchanges.length),
      },
    };
  }

  async getUserSeasonRecordSummary(
    authUserId: string | undefined,
    targetUserId: string | undefined,
    seasonId: string | undefined,
  ): Promise<UserSeasonRecordSummaryResponse> {
    this.assertAuthenticated(authUserId);

    const parsedTargetUserId = this.parseRequiredText(
      targetUserId,
      'INVALID_USER_ID',
      'userId',
    );
    const parsedSeasonId = this.parseRequiredText(
      seasonId,
      'INVALID_SEASON_ID',
      'seasonId',
    );
    const [targetUser, season] = await Promise.all([
      this.prisma.user.findUnique({
        where: {
          id: parsedTargetUserId,
        },
        select: {
          id: true,
          nickname: true,
          profileImageUrl: true,
        },
      }),
      this.findSeasonById(parsedSeasonId),
    ]);

    if (!targetUser) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'USER_NOT_FOUND',
        'User not found.',
      );
    }
    if (!season) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'SEASON_NOT_FOUND',
        'Season not found.',
      );
    }

    const participant = await this.findDetailedParticipant(
      season.id,
      parsedTargetUserId,
    );
    const publicSeason = {
      id: season.id,
      name: season.name,
      status: season.status,
    };

    if (!participant) {
      return {
        success: true,
        data: {
          state: 'not_joined',
          user: targetUser,
          season: publicSeason,
          summary: null,
          portfolio: null,
          portfolioAccess: 'unavailable',
          portfolioReason: 'USE_CURRENT_SEASON_SUMMARY',
          reason: 'SEASON_NOT_JOINED',
          message: 'The user has not joined this season.',
        },
      };
    }

    if (!this.isParticipantPubliclyVisible(participant)) {
      const hiddenReason = this.publicVisibilityReason(participant);

      return {
        success: true,
        data: {
          state: 'available',
          user: targetUser,
          season: publicSeason,
          summary: null,
          portfolio: null,
          portfolioAccess: 'unavailable',
          portfolioReason: 'USE_CURRENT_SEASON_SUMMARY',
          reason: hiddenReason.reason,
          message: hiddenReason.message,
        },
      };
    }

    const metric = this.selectBestMetric(
      participant.seasonRankings[0],
      participant.tradingAccount.dailyPortfolioSnapshots[0],
    );

    return {
      success: true,
      data: {
        state: 'available',
        user: targetUser,
        season: publicSeason,
        summary: {
          currentRank: participant.currentRank,
          currentTier: null,
          finalRank: participant.finalRank,
          finalTier: participant.finalTier,
          rewardGranted: participant.rewardGrantedAt !== null,
          totalAssetKrw: metric
            ? this.formatDecimal(metric.totalAssetKrw, 8)
            : null,
          returnRate: metric ? this.formatDecimal(metric.returnRate, 8) : null,
        },
        portfolio: null,
        portfolioAccess: 'unavailable',
        portfolioReason: 'USE_CURRENT_SEASON_SUMMARY',
      },
    };
  }

  async getUserCurrentSeasonSummary(
    authUserId: string | undefined,
    targetUserId: string | undefined,
  ): Promise<UserCurrentSeasonSummaryResponse> {
    this.assertAuthenticated(authUserId);

    const parsedTargetUserId = this.parseRequiredText(
      targetUserId,
      'INVALID_USER_ID',
      'userId',
    );
    const [targetUser, season] = await Promise.all([
      this.prisma.user.findUnique({
        where: {
          id: parsedTargetUserId,
        },
        select: {
          id: true,
          nickname: true,
          profileImageUrl: true,
        },
      }),
      this.findCurrentSeason(),
    ]);

    if (!targetUser) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'USER_NOT_FOUND',
        'User not found.',
      );
    }

    if (!season) {
      return {
        success: true,
        data: {
          state: 'unavailable',
          user: targetUser,
          season: null,
          portfolioAccess: 'unavailable',
          portfolio: null,
          reason: 'CURRENT_SEASON_NOT_FOUND',
          message: 'Current season is not configured.',
        },
      };
    }

    const participant = await this.findDetailedParticipant(
      season.id,
      parsedTargetUserId,
    );
    if (!participant) {
      return {
        success: true,
        data: {
          state: 'not_joined',
          user: targetUser,
          season: {
            id: season.id,
            name: season.name,
            maxDrawdown: null,
            status: season.status,
            rank: null,
            provisionalTier: null,
            finalTier: null,
            percentile: null,
            returnRate: null,
            totalAssetKrw: null,
            totalFillCount: 0,
          },
          portfolioAccess: 'unavailable',
          portfolio: null,
          reason: 'SEASON_NOT_JOINED',
          message: 'The user has not joined the current season.',
        },
      };
    }

    if (!this.isParticipantPubliclyVisible(participant)) {
      const hiddenReason = this.publicVisibilityReason(participant);

      return {
        success: true,
        data: {
          state: 'unavailable',
          user: targetUser,
          season: {
            id: season.id,
            name: season.name,
            maxDrawdown: null,
            status: season.status,
            rank: null,
            provisionalTier: null,
            finalTier: null,
            percentile: null,
            returnRate: null,
            totalAssetKrw: null,
            totalFillCount: 0,
          },
          portfolioAccess: 'unavailable',
          portfolio: null,
          reason: hiddenReason.reason,
          message: hiddenReason.message,
        },
      };
    }

    const ranking = await this.findLatestPublicRanking(
      season.id,
      participant.id,
      participant.tradingAccountId,
      season.status,
    );
    let portfolioAccess = await readPortfolioAccess(
      this.prisma,
      authUserId,
      parsedTargetUserId,
    );
    let portfolioReason: string | undefined;
    if (
      portfolioAccess === 'available' &&
      (season.status !== SeasonStatus.active ||
        participant.tradingAccount.status !== 'active')
    ) {
      portfolioAccess = 'unavailable';
      portfolioReason = 'CURRENT_ACTIVE_SEASON_UNAVAILABLE';
    }
    let portfolio =
      portfolioAccess === 'available'
        ? await this.buildFriendPortfolio(
            participant.id,
            participant.tradingAccountId,
            new Date(),
          )
        : null;
    const metric =
      ranking ??
      this.selectBestMetric(
        participant.seasonRankings[0],
        participant.tradingAccount.dailyPortfolioSnapshots[0],
      );
    // 작업 8 보완 §A-4: this response publishes a tier and a percentile derived
    // from the whole snapshot, so the whole snapshot is verified — not only the
    // one row belonging to the user being viewed.
    if (ranking) {
      await assertSeasonRankingSetScope(this.prisma, {
        seasonId: season.id,
        rankType: ranking.rankType,
        rankingDate: ranking.rankingDate,
        capturedAt: ranking.capturedAt,
      });
    }

    const rankingTotal = ranking
      ? await this.prisma.seasonRanking.count({
          where: {
            seasonId: season.id,
            rankType: ranking.rankType,
            rankingDate: ranking.rankingDate,
            capturedAt: ranking.capturedAt,
            seasonParticipant: this.publicRankingParticipantWhere(),
          },
        })
      : 0;
    const isFinalRanking = ranking?.rankType === SeasonRankingType.final;
    const isDailyRanking = ranking?.rankType === SeasonRankingType.daily;

    // Recheck after the financial reads, so an in-flight deletion/privacy save
    // cannot return a payload after the permission was revoked.
    if (portfolio) {
      const currentSeason = await this.findCurrentSeason();
      const eligible = await this.prisma.seasonParticipant.findFirst({
        where: {
          id: participant.id,
          userId: parsedTargetUserId,
          seasonId: season.id,
          tradingAccountId: participant.tradingAccountId,
          ...this.publicRankingParticipantWhere(),
          season: { status: SeasonStatus.active },
          tradingAccount: {
            id: participant.tradingAccountId,
            userId: parsedTargetUserId,
            mode: 'season',
            status: 'active',
            seasonParticipant: { id: participant.id },
          },
        },
        select: { id: true },
      });
      if (
        !eligible ||
        currentSeason?.id !== season.id ||
        currentSeason.status !== SeasonStatus.active
      ) {
        portfolioAccess = 'unavailable';
        portfolioReason = 'CURRENT_ACTIVE_SEASON_UNAVAILABLE';
        portfolio = null;
      }
      if (portfolio) {
        portfolioAccess = await readPortfolioAccess(
          this.prisma,
          authUserId,
          parsedTargetUserId,
        );
        if (portfolioAccess !== 'available') portfolio = null;
      }
    }

    return {
      success: true,
      data: {
        state: 'available',
        user: targetUser,
        season: {
          id: season.id,
          name: season.name,
          maxDrawdown: ranking
            ? this.formatDecimal(ranking.maxDrawdown, 8)
            : null,
          status: season.status,
          rank:
            ranking?.rank ?? participant.currentRank ?? participant.finalRank,
          provisionalTier:
            isDailyRanking && rankingTotal > 0
              ? assignRankingTier(ranking.rank, rankingTotal)
              : null,
          finalTier:
            isFinalRanking && rankingTotal > 0
              ? (participant.finalTier ??
                assignRankingTier(ranking.rank, rankingTotal))
              : null,
          percentile:
            ranking && rankingTotal > 0
              ? this.formatDecimal(
                  calculateRankingPercentile(ranking.rank, rankingTotal),
                  8,
                )
              : null,
          returnRate: metric ? this.formatDecimal(metric.returnRate, 8) : null,
          totalAssetKrw: metric
            ? this.formatDecimal(metric.totalAssetKrw, 8)
            : null,
          totalFillCount: ranking?.totalFillCount ?? participant.totalFillCount,
        },
        portfolioAccess,
        portfolioReason,
        portfolio,
      },
    };
  }

  private async buildProfitAnalysis(
    tradingAccountId: string,
    valuationAt: Date,
  ): Promise<ProfitAnalysis> {
    const positions = await this.findProfitPositions(tradingAccountId);

    if (positions.length === 0) {
      return {
        state: 'available',
        totalRealizedPnlKrw: this.formatDecimal(new Prisma.Decimal(0), 8),
        totalUnrealizedPnlKrw: this.formatDecimal(new Prisma.Decimal(0), 8),
        totalPnlKrw: this.formatDecimal(new Prisma.Decimal(0), 8),
        bestAsset: null,
        worstAsset: null,
        items: [],
        valuationErrors: [],
      };
    }

    const usdKrwSelection = await this.findUsdKrwSelectionForRecords(
      positions.some(
        (position) =>
          position.currencyCode === CurrencyCode.USD &&
          !position.quantity.eq(0),
      ),
      valuationAt,
    );
    const valuationErrors: ProfitAnalysis['valuationErrors'] = [];
    const itemRows = await Promise.all(
      positions.map(async (position) => {
        const result = await this.buildProfitAnalysisItem(
          position,
          valuationAt,
          usdKrwSelection,
        );
        if (result.error) {
          valuationErrors.push({
            assetId: position.assetId,
            code: result.error.code,
            message: result.error.message,
            ...(result.error.diagnostic
              ? { diagnostic: result.error.diagnostic }
              : {}),
          });
        }

        return result;
      }),
    );
    const totalRealizedPnlKrw = positions.reduce(
      (sum, position) => sum.add(position.realizedPnlKrw),
      new Prisma.Decimal(0),
    );
    const totalUnrealizedPnlKrw = itemRows.reduce(
      (sum, row) => sum.add(row.unrealizedPnlKrw),
      new Prisma.Decimal(0),
    );
    const totalPnlKrw = totalRealizedPnlKrw.add(totalUnrealizedPnlKrw);
    const sortedByTotalPnl = itemRows.toSorted((left, right) => {
      const totalDiff = right.totalPnlKrw.cmp(left.totalPnlKrw);
      if (totalDiff !== 0) {
        return totalDiff;
      }

      return left.item.assetId.localeCompare(right.item.assetId);
    });

    return {
      state: valuationErrors.length === 0 ? 'available' : 'partial_unavailable',
      totalRealizedPnlKrw: this.formatDecimal(totalRealizedPnlKrw, 8),
      totalUnrealizedPnlKrw: this.formatDecimal(totalUnrealizedPnlKrw, 8),
      totalPnlKrw: this.formatDecimal(totalPnlKrw, 8),
      bestAsset: sortedByTotalPnl[0]?.item ?? null,
      worstAsset:
        sortedByTotalPnl.length > 0
          ? sortedByTotalPnl[sortedByTotalPnl.length - 1].item
          : null,
      items: itemRows
        .toSorted((left, right) => {
          const symbolDiff = left.item.symbol.localeCompare(right.item.symbol);
          if (symbolDiff !== 0) {
            return symbolDiff;
          }

          return left.item.assetId.localeCompare(right.item.assetId);
        })
        .map((row) => row.item),
      valuationErrors,
    };
  }

  private async buildProfitAnalysisItem(
    position: ProfitPositionRecord,
    valuationAt: Date,
    usdKrwSelection: UsdKrwForRecords | null,
  ): Promise<{
    item: ProfitAnalysisItem;
    unrealizedPnlKrw: Prisma.Decimal;
    totalPnlKrw: Prisma.Decimal;
    error: {
      code: ValuationErrorCode;
      message: string;
      diagnostic?: AdminDiagnostic;
    } | null;
  }> {
    let unrealizedPnlLocal = new Prisma.Decimal(0);
    let unrealizedPnlKrw = new Prisma.Decimal(0);
    let returnRate: Prisma.Decimal | null = null;
    let valuationState: ProfitAnalysisItem['valuationState'] = 'available';
    let error: {
      code: ValuationErrorCode;
      message: string;
      diagnostic?: AdminDiagnostic;
    } | null = null;

    if (!position.quantity.eq(0)) {
      let failureStage = 'position_currency_validation';
      let priceSelected = false;
      try {
        if (position.asset.currencyCode !== position.currencyCode) {
          throw new RecordsValuationError(
            'ASSET_PRICE_UNAVAILABLE',
            `Position currency mismatch for asset ${position.assetId}.`,
          );
        }

        failureStage = 'fx_rate_validation';
        if (
          position.currencyCode === CurrencyCode.USD &&
          usdKrwSelection?.state === 'unavailable'
        ) {
          throw new RecordsValuationError(
            usdKrwSelection.code,
            usdKrwSelection.message,
            usdKrwSelection.diagnosticContext,
          );
        }
        if (
          position.currencyCode === CurrencyCode.USD &&
          usdKrwSelection?.state !== 'available'
        ) {
          throw new RecordsValuationError(
            'FX_RATE_UNAVAILABLE',
            'USD/KRW FX rate snapshot is required for USD conversion.',
          );
        }

        failureStage = 'asset_price_selection';
        const priceSnapshot = await this.findLatestEligibleAssetPriceSnapshot(
          position.asset,
          position.currencyCode,
          valuationAt,
        );
        priceSelected = true;
        failureStage = 'position_valuation_calculation';
        const values = calculatePositionValuation({
          currentPrice: priceSnapshot.price,
          quantity: position.quantity,
          averageCost: position.averageCost,
          currencyCode: position.currencyCode,
          usdKrwRate:
            usdKrwSelection?.state === 'available'
              ? usdKrwSelection.rate
              : null,
        });
        unrealizedPnlLocal = values.unrealizedPnlLocal;
        unrealizedPnlKrw = values.unrealizedPnlKrw;
        if (!position.averageCost.eq(0)) returnRate = values.returnRate;
      } catch (caught) {
        const valuationError =
          caught instanceof RecordsValuationError
            ? caught
            : preserveAdminFailureCause(
                new RecordsValuationError(
                  'ASSET_PRICE_UNAVAILABLE',
                  `Asset valuation is unavailable for asset ${position.assetId}.`,
                ),
                caught,
                failureStage,
              );
        const diagnostic = buildAdminPartialFailureDiagnostic(
          valuationError,
          valuationError.code,
          {
            failureStage,
            evidence: {
              valuation: {
                result:
                  caught instanceof RecordsValuationError
                    ? 'unavailable'
                    : 'unexpected_failure',
                priceSelected,
                fxRequired: position.currencyCode === CurrencyCode.USD,
              },
            },
            nextInvestigation: [
              'backend/src/records/records.service.ts',
              'backend/src/portfolio/portfolio-valuation.policy.ts',
            ],
            ...valuationError.diagnosticContext,
            domain: 'RECORDS',
            operation: 'PROFIT_ANALYSIS',
            entities: {
              ...valuationError.diagnosticContext?.entities,
              assetId: position.assetId,
            },
          },
        );
        valuationState = 'unavailable';
        error = {
          code: valuationError.code,
          message: valuationError.message,
          ...(diagnostic ? { diagnostic } : {}),
        };
      }
    }

    const totalPnlKrw = position.realizedPnlKrw.add(unrealizedPnlKrw);
    const item: ProfitAnalysisItem = {
      assetId: position.assetId,
      symbol: position.asset.symbol,
      name: position.asset.name,
      market: position.asset.market,
      assetType: position.asset.assetType,
      currencyCode: position.currencyCode,
      realizedPnlLocal: this.formatDecimal(position.realizedPnl, 8),
      realizedPnlKrw: this.formatDecimal(position.realizedPnlKrw, 8),
      unrealizedPnlLocal: this.formatDecimal(unrealizedPnlLocal, 8),
      unrealizedPnlKrw: this.formatDecimal(unrealizedPnlKrw, 8),
      totalPnlKrw: this.formatDecimal(totalPnlKrw, 8),
      returnRate: returnRate ? this.formatDecimal(returnRate, 8) : null,
      returnRateState: returnRate ? 'available' : 'unavailable',
      positionState: position.quantity.eq(0) ? 'fully_sold' : 'open',
      valuationState,
    };

    return {
      item,
      unrealizedPnlKrw,
      totalPnlKrw,
      error,
    };
  }

  private async findLatestPublicRanking(
    seasonId: string,
    seasonParticipantId: string,
    tradingAccountId: string,
    seasonStatus: SeasonStatus,
  ) {
    const preferredRankType =
      seasonStatus === SeasonStatus.settled
        ? SeasonRankingType.final
        : SeasonRankingType.daily;
    const preferredRanking = await this.findLatestRankingByType(
      seasonId,
      seasonParticipantId,
      tradingAccountId,
      preferredRankType,
    );

    if (preferredRanking) {
      return preferredRanking;
    }

    return preferredRankType === SeasonRankingType.final
      ? this.findLatestRankingByType(
          seasonId,
          seasonParticipantId,
          tradingAccountId,
          SeasonRankingType.daily,
        )
      : this.findLatestRankingByType(
          seasonId,
          seasonParticipantId,
          tradingAccountId,
          SeasonRankingType.final,
        );
  }

  private async findLatestRankingByType(
    seasonId: string,
    seasonParticipantId: string,
    tradingAccountId: string,
    rankType: SeasonRankingType,
  ) {
    const ranking = await this.prisma.seasonRanking.findFirst({
      where: {
        seasonId,
        seasonParticipantId,
        tradingAccountId,
        rankType,
        seasonParticipant: this.publicRankingParticipantWhere(),
      },
      orderBy: [
        { rankingDate: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        ...SEASON_RANKING_SCOPE_SELECT,
        id: true,
        rankType: true,
        rank: true,
        rankingDate: true,
        totalAssetKrw: true,
        maxDrawdown: true,
        returnRate: true,
        totalFillCount: true,
        capturedAt: true,
      },
    });

    // A hidden/excluded participant legitimately yields null here (the WHERE
    // filters them out). A row that came back but is mis-scoped is damage.
    if (ranking) {
      assertSeasonRankingScope(ranking);
    }

    return ranking;
  }

  private async buildFriendPortfolio(
    seasonParticipantId: string,
    tradingAccountId: string,
    valuationAt: Date,
  ): Promise<FriendPortfolio> {
    let valuation: PortfolioValuationResult | null = null;
    try {
      valuation = this.portfolioValuationService
        ? await this.portfolioValuationService.calculateTradingAccountValuation(
            tradingAccountId,
            valuationAt,
            'home_live_valuation',
          )
        : null;
      if (valuation && valuation.seasonParticipantId !== seasonParticipantId) {
        throw new PortfolioValuationError(
          'TRADING_ACCOUNT_SCOPE_MISMATCH',
          'Portfolio account ownership mismatch.',
        );
      }
    } catch (error) {
      // Structural corruption is an error, never a fake empty portfolio.
      if (
        !(error instanceof PortfolioValuationError) ||
        ![
          'FUTURES_MARK_UNAVAILABLE',
          'FUTURES_MARK_STALE',
          'ASSET_PRICE_UNAVAILABLE',
          'ASSET_PRICE_STALE',
          'PRICE_STALE',
          'FX_RATE_UNAVAILABLE',
          'FX_RATE_STALE',
        ].includes(error.code)
      )
        throw error;
    }
    const since = new Date(valuationAt);
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - 29);
    const [positions, futures, snapshots] = await Promise.all([
      this.positionsService.readOpenHoldingProjection(
        tradingAccountId,
        valuationAt,
      ),
      this.prisma.$transaction(
        (tx) => readFuturesHoldingSummaries(tx, tradingAccountId, valuationAt),
        { isolationLevel: 'RepeatableRead' },
      ),
      this.prisma.dailyPortfolioSnapshot.findMany({
        where: {
          tradingAccountId,
          snapshotDate: { gte: since, lte: valuationAt },
        },
        select: { snapshotDate: true, totalAssetKrw: true, returnRate: true },
        orderBy: { snapshotDate: 'asc' },
        take: 30,
      }),
    ]);
    const values = new Map(
      valuation?.positionValues.map((position) => [
        position.assetId,
        position.valueKrw,
      ]),
    );
    const denominator = valuation
      ? new Prisma.Decimal(valuation.totalAssetKrw)
      : null;
    return {
      valuationState: valuation ? 'available' : 'unavailable',
      allocation: valuation
        ? {
            cashKrwValue: new Prisma.Decimal(valuation.krwCash)
              .add(valuation.usdCashKrw)
              .toFixed(8),
            domesticStockValueKrw: valuation.domesticStockValueKrw,
            usStockValueKrw: valuation.usStockValueKrw,
            cryptoValueKrw: valuation.cryptoValueKrw,
          }
        : null,
      holdings: positions.map((position) => ({
        ...position,
        weight:
          denominator?.gt(0) && values.has(position.assetId)
            ? new Prisma.Decimal(values.get(position.assetId)!)
                .div(denominator)
                .mul(100)
                .toFixed(8)
            : null,
      })),
      futures,
      history: snapshots.map((point) => ({
        date: this.formatDateOnly(point.snapshotDate),
        totalAssetKrw: this.formatDecimal(point.totalAssetKrw, 8),
        returnRate: this.formatDecimal(point.returnRate, 8),
      })),
    };
  }

  private async findProfitPositions(
    tradingAccountId: string,
  ): Promise<ProfitPositionRecord[]> {
    return this.prisma.position.findMany({
      where: {
        tradingAccountId,
      },
      select: {
        id: true,
        assetId: true,
        quantity: true,
        averageCost: true,
        currencyCode: true,
        realizedPnl: true,
        realizedPnlKrw: true,
        asset: {
          select: {
            id: true,
            symbol: true,
            name: true,
            market: true,
            assetType: true,
            currencyCode: true,
          },
        },
      },
    });
  }

  private async findLatestEligibleAssetPriceSnapshot(
    asset: ProfitPositionRecord['asset'],
    currencyCode: CurrencyCode,
    valuationAt: Date,
  ): Promise<AssetPriceForRecords> {
    const providerEligibility = resolveAssetProviderEligibility({
      workflow: 'positions_live_valuation',
      asset,
    });
    const priceRead = {
      asset: { ...asset, currencyCode: currencyCode },
      workflow: 'positions_live_valuation' as const,
      now: valuationAt,
    };
    const closedScope = closedMarketPriceScope(priceRead);
    const providerCandidates = providerEligibility.eligible
      ? await findMarketAwareAssetPriceCandidates(this.prisma, {
          ...priceRead,
          sourceNames: providerEligibility.sourceNames,
        })
      : [];
    const providerSelection = providerEligibility.eligible
      ? selectMarketAwareAssetPriceSnapshotBySourcePriority({
          asset,
          workflow: 'positions_live_valuation',
          candidates: providerCandidates,
          expectedSourceNames: providerEligibility.sourceNames,
          now: valuationAt,
          freshnessThresholdSeconds:
            providerEligibility.freshnessThresholdSeconds,
          isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
        })
      : null;

    if (providerSelection?.state === 'selected') {
      return providerSelection.snapshot;
    }

    const providerFailureEvidence = buildSelectionFailureEvidence({
      workflow: 'positions_live_valuation',
      evaluationAt: valuationAt,
      eligibility: providerEligibility,
      candidates: providerCandidates,
      selection: providerSelection,
      asset,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
    });

    const fallbackSnapshot = await this.prisma.assetPriceSnapshot.findFirst({
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
        ...closedScope?.where,
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
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });

    if (fallbackSnapshot) {
      return fallbackSnapshot;
    }

    const diagnosticContext: DiagnosticContextUpdate = {
      failureStage: 'asset_price_selection',
      entities: { assetId: asset.id },
      evidence: {
        ...providerFailureEvidence,
        manualFallback: describeManualFallback({
          snapshot: null,
          evaluationAt: valuationAt,
          queryChecks: [
            'source_type_admin_manual',
            'positive_value',
            'effective_at_lte_evaluation',
            ...(closedScope ? ['last_completed_session'] : []),
          ],
        }),
      },
    };

    if (
      providerSelection?.decision.rejectedProviderReason === 'captured_at_stale'
    ) {
      throw new RecordsValuationError(
        'PRICE_STALE',
        `Provider asset price is stale for asset ${asset.id}.`,
        diagnosticContext,
      );
    }

    throw new RecordsValuationError(
      'ASSET_PRICE_UNAVAILABLE',
      `Asset price snapshot is unavailable for asset ${asset.id}.`,
      diagnosticContext,
    );
  }

  private async findUsdKrwSelectionForRecords(
    needed: boolean,
    valuationAt: Date,
  ): Promise<UsdKrwForRecords | null> {
    if (!needed) {
      return null;
    }

    const providerEligibility = resolveFxProviderEligibility({
      workflow: 'positions_live_valuation',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    });
    const providerCandidates = providerEligibility.eligible
      ? await findUsdKrwProviderSnapshotCandidates(this.prisma, {
          sourceNames: providerEligibility.sourceNames,
          take: 10,
        })
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
      : null;

    if (providerSelection?.state === 'selected') {
      return {
        state: 'available',
        rate: providerSelection.snapshot.rate,
      };
    }

    const providerFailureEvidence = buildSelectionFailureEvidence({
      workflow: 'positions_live_valuation',
      evaluationAt: valuationAt,
      eligibility: providerEligibility,
      candidates: providerCandidates,
      selection: providerSelection,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
    });

    const fallbackSnapshot = await this.prisma.fxRateSnapshot.findFirst({
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

    const diagnosticContext = (reason?: string): DiagnosticContextUpdate => ({
      failureStage: 'fx_rate_selection',
      evidence: {
        ...providerFailureEvidence,
        manualFallback: describeManualFallback({
          snapshot: fallbackSnapshot,
          evaluationAt: valuationAt,
          reason,
          queryChecks: [
            'source_type_admin_manual',
            'approved',
            'positive_value',
            'effective_at_lte_evaluation',
          ],
          freshnessThresholdSeconds:
            fxExecuteSnapshotFreshnessThresholdMs / 1000,
          positiveValue: fallbackSnapshot
            ? isPositiveDecimal(fallbackSnapshot.rate)
            : undefined,
        }),
      },
    });

    if (!fallbackSnapshot) {
      return {
        state: 'unavailable',
        diagnosticContext: diagnosticContext(),
        code:
          providerSelection?.decision.rejectedProviderReason ===
          'captured_at_stale'
            ? 'FX_RATE_STALE'
            : 'FX_RATE_UNAVAILABLE',
        message:
          providerSelection?.decision.rejectedProviderReason ===
          'captured_at_stale'
            ? 'USD/KRW FX rate snapshot is stale.'
            : 'USD/KRW FX rate snapshot is unavailable.',
      };
    }

    if (
      isFxSnapshotStaleForPortfolioValuation(
        fallbackSnapshot.effectiveAt,
        valuationAt,
      )
    ) {
      return {
        state: 'unavailable',
        diagnosticContext: diagnosticContext('effective_at_stale'),
        code: 'FX_RATE_STALE',
        message: 'USD/KRW FX rate snapshot is stale.',
      };
    }

    return {
      state: 'available',
      rate: fallbackSnapshot.rate,
    };
  }

  private unavailableProfitAnalysis(): ProfitAnalysis {
    return {
      state: 'unavailable',
      totalRealizedPnlKrw: this.formatDecimal(new Prisma.Decimal(0), 8),
      totalUnrealizedPnlKrw: this.formatDecimal(new Prisma.Decimal(0), 8),
      totalPnlKrw: this.formatDecimal(new Prisma.Decimal(0), 8),
      bestAsset: null,
      worstAsset: null,
      items: [],
      valuationErrors: [],
    };
  }

  private async buildExchangeSection(
    tradingAccountId: string,
    query: ParsedRecordsQuery,
  ): Promise<NonNullable<RecordsResponse['data']['exchanges']>> {
    const where = {
      tradingAccountId,
      ...(query.currencyCode
        ? {
            OR: [
              { fromCurrency: query.currencyCode },
              { toCurrency: query.currencyCode },
            ],
          }
        : {}),
    };
    const [total, records] = await Promise.all([
      this.prisma.exchangeTransaction.count({ where }),
      this.prisma.exchangeTransaction.findMany({
        where,
        orderBy: [{ executedAt: 'desc' }, { createdAt: 'desc' }],
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          fxRateSnapshotId: true,
          fromCurrency: true,
          toCurrency: true,
          sourceAmount: true,
          grossTargetAmount: true,
          feeRate: true,
          feeAmount: true,
          feeCurrency: true,
          appliedRate: true,
          netTargetAmount: true,
          executedAt: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      state: 'available',
      pagination: this.pagination(query, total, records.length),
      records: records.map((record) => ({
        exchangeId: record.id,
        executedAt: record.executedAt.toISOString(),
        fromCurrency: record.fromCurrency,
        toCurrency: record.toCurrency,
        sourceAmount: this.formatDecimal(record.sourceAmount, 8),
        grossTargetAmount: this.formatDecimal(record.grossTargetAmount, 8),
        feeRate: this.formatDecimal(record.feeRate, 6),
        feeAmount: this.formatDecimal(record.feeAmount, 8),
        feeCurrency: record.feeCurrency,
        appliedRate: this.formatDecimal(record.appliedRate, 8),
        netTargetAmount: this.formatDecimal(record.netTargetAmount, 8),
        fxRateSnapshotId: record.fxRateSnapshotId,
        createdAt: record.createdAt.toISOString(),
      })),
    };
  }

  private async buildWalletTransactionSection(
    tradingAccountId: string,
    query: ParsedRecordsQuery,
  ): Promise<NonNullable<RecordsResponse['data']['walletTransactions']>> {
    const where = {
      tradingAccountId,
      ...(query.currencyCode ? { currencyCode: query.currencyCode } : {}),
    };
    const [total, records] = await Promise.all([
      this.prisma.walletTransaction.count({ where }),
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          walletId: true,
          currencyCode: true,
          direction: true,
          txType: true,
          referenceType: true,
          referenceId: true,
          amount: true,
          balanceAfter: true,
          occurredAt: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      state: 'available',
      pagination: this.pagination(query, total, records.length),
      records: records.map((record) => ({
        walletTransactionId: record.id,
        walletId: record.walletId,
        currencyCode: record.currencyCode,
        direction: record.direction,
        transactionType: record.txType,
        amount: this.formatDecimal(record.amount, 8),
        balanceAfter: this.formatDecimal(record.balanceAfter, 8),
        referenceType: record.referenceType,
        referenceId: record.referenceId,
        occurredAt: record.occurredAt.toISOString(),
        createdAt: record.createdAt.toISOString(),
      })),
    };
  }

  private async buildOrderSection(
    tradingAccountId: string,
    query: ParsedRecordsQuery,
  ): Promise<NonNullable<RecordsResponse['data']['orders']>> {
    const where = {
      tradingAccountId,
      ...(query.currencyCode ? { currencyCode: query.currencyCode } : {}),
    };
    const [total, records] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }],
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          submittedAt: true,
          executedAt: true,
          canceledAt: true,
          rejectedAt: true,
          side: true,
          orderType: true,
          status: true,
          quantity: true,
          ...MARKET_EXECUTION_SELECT,
          cancelReason: true,
          limitPrice: true,
          executedPrice: true,
          currencyCode: true,
          grossAmount: true,
          feeAmount: true,
          netAmount: true,
          assetPriceSnapshotId: true,
          fxRateSnapshotId: true,
          createdAt: true,
          asset: {
            select: {
              id: true,
              symbol: true,
              name: true,
            },
          },
        },
      }),
    ]);

    return {
      state: 'available',
      pagination: this.pagination(query, total, records.length),
      records: records.map((record) => ({
        orderId: record.id,
        submittedAt: record.submittedAt.toISOString(),
        executedAt: this.formatNullableDate(record.executedAt),
        canceledAt: this.formatNullableDate(record.canceledAt),
        rejectedAt: this.formatNullableDate(record.rejectedAt),
        assetId: record.asset.id,
        symbol: record.asset.symbol,
        name: record.asset.name,
        side: record.side,
        orderType: record.orderType,
        status: record.status,
        quantity: this.formatDecimal(record.quantity, 8),
        ...presentMarketExecution(record),
        limitPrice: this.formatNullableDecimal(record.limitPrice, 8),
        executedPrice: this.formatNullableDecimal(record.executedPrice, 8),
        currencyCode: record.currencyCode,
        grossAmount: this.formatNullableDecimal(record.grossAmount, 8),
        feeAmount: this.formatNullableDecimal(record.feeAmount, 8),
        netAmount: this.formatNullableDecimal(record.netAmount, 8),
        assetPriceSnapshotId: record.assetPriceSnapshotId,
        fxRateSnapshotId: record.fxRateSnapshotId,
        createdAt: record.createdAt.toISOString(),
      })),
    };
  }

  private parseQuery(query: RecordsQuery): ParsedRecordsQuery {
    return {
      seasonId: this.parseOptionalText(query.seasonId),
      type: this.parseType(query.type),
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
      currencyCode: this.parseCurrencyCode(query.currencyCode),
    };
  }

  private parseMySeasonRecordsQuery(
    query: MySeasonRecordsQuery,
  ): ParsedMySeasonRecordsQuery {
    return {
      seasonStatus: this.parseSeasonStatus(query.seasonStatus),
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
  }

  private parseMySeasonOrdersQuery(
    query: MySeasonOrdersQuery,
  ): ParsedMySeasonOrdersQuery {
    return {
      status: this.parseOrderStatus(query.status),
      side: this.parseOrderSide(query.side),
      assetId: this.parseOptionalText(query.assetId),
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
  }

  private parseMySeasonExchangesQuery(
    query: MySeasonExchangesQuery,
  ): ParsedMySeasonExchangesQuery {
    return {
      fromCurrency: this.parseCurrencyFilter(
        query.fromCurrency,
        'INVALID_FROM_CURRENCY',
        'fromCurrency',
      ),
      toCurrency: this.parseCurrencyFilter(
        query.toCurrency,
        'INVALID_TO_CURRENCY',
        'toCurrency',
      ),
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
  }

  private parseMySeasonEquityQuery(
    query: MySeasonEquityQuery,
  ): ParsedMySeasonEquityQuery {
    return {
      limit: this.parseEquityLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
  }

  private parseType(value: string | undefined): RecordsType {
    const text = value?.trim() || 'all';
    if (
      text === 'all' ||
      text === 'exchanges' ||
      text === 'wallets' ||
      text === 'orders'
    ) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_RECORD_TYPE',
      'Invalid records type.',
    );
  }

  private parseSeasonStatus(
    value: string | undefined,
  ): SeasonStatus | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (
      text === SeasonStatus.upcoming ||
      text === SeasonStatus.active ||
      text === SeasonStatus.ended ||
      text === SeasonStatus.settled
    ) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_SEASON_STATUS',
      'Invalid seasonStatus.',
    );
  }

  private parseOrderStatus(value: string | undefined): OrderStatus | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (
      text === OrderStatus.submitted ||
      text === OrderStatus.executed ||
      text === OrderStatus.canceled ||
      text === OrderStatus.rejected
    ) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_ORDER_STATUS',
      'Invalid order status.',
    );
  }

  private parseOrderSide(value: string | undefined): OrderSide | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (text === OrderSide.buy || text === OrderSide.sell) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_ORDER_SIDE',
      'Invalid order side.',
    );
  }

  private parseCurrencyCode(
    value: string | undefined,
  ): CurrencyCode | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (text === CurrencyCode.KRW || text === CurrencyCode.USD) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_CURRENCY_CODE',
      'Invalid currencyCode.',
    );
  }

  private parseCurrencyFilter(
    value: string | undefined,
    code: string,
    fieldName: string,
  ): CurrencyCode | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (text === CurrencyCode.KRW || text === CurrencyCode.USD) {
      return text;
    }

    this.throwApiError(HttpStatus.BAD_REQUEST, code, `Invalid ${fieldName}.`);
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

  private parseEquityLimit(value: string | undefined): number {
    if (value === undefined) {
      return DEFAULT_EQUITY_LIMIT;
    }

    const limit = this.parseNonNegativeInteger(value, 'INVALID_LIMIT', 'limit');
    if (limit < 1) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_LIMIT',
        'limit must be greater than 0.',
      );
    }

    return Math.min(limit, MAX_EQUITY_LIMIT);
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

  private parseRequiredText(
    value: string | undefined,
    code: string,
    fieldName: string,
  ): string {
    const text = this.parseOptionalText(value);
    if (!text) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        `${fieldName} must be a non-empty string.`,
      );
    }

    return text;
  }

  private async findCurrentSeason(): Promise<RecordsSeason | null> {
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
  ): Promise<RecordsSeason | null> {
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

  private async findSeasonByIdOrThrow(
    seasonId: string,
  ): Promise<RecordsSeason> {
    const season = await this.findSeasonById(seasonId);
    if (!season) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'SEASON_NOT_FOUND',
        'Season not found.',
      );
    }

    return season;
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

  private async findParticipant(
    seasonId: string,
    userId: string,
  ): Promise<RecordsParticipant | null> {
    return this.prisma.seasonParticipant.findUnique({
      where: {
        seasonId_userId: {
          seasonId,
          userId,
        },
      },
      select: {
        id: true,
        tradingAccountId: true,
        participantStatus: true,
        joinedAt: true,
        rankingHiddenAt: true,
      },
    });
  }

  private async findDetailedParticipant(seasonId: string, userId: string) {
    const participant = await this.prisma.seasonParticipant.findUnique({
      where: {
        seasonId_userId: {
          seasonId,
          userId,
        },
      },
      select: {
        id: true,
        // Scope columns for the ranking verification below (작업 8 §11).
        userId: true,
        seasonId: true,
        tradingAccountId: true,
        tradingAccount: {
          select: {
            id: true,
            mode: true,
            status: true,
            userId: true,
            dailyPortfolioSnapshots: {
              orderBy: [
                { snapshotDate: 'desc' },
                { capturedAt: 'desc' },
                { createdAt: 'desc' },
              ],
              take: 1,
              select: {
                totalAssetKrw: true,
                returnRate: true,
                snapshotDate: true,
                capturedAt: true,
              },
            },
            _count: {
              select: {
                orders: true,
                exchangeTransactions: true,
                walletTransactions: true,
              },
            },
          },
        },
        participantStatus: true,
        joinedAt: true,
        rankingHiddenAt: true,
        initialCapitalKrw: true,
        maxDrawdown: true,
        totalFillCount: true,
        currentRank: true,
        finalRank: true,
        finalTier: true,
        rewardGrantedAt: true,
        seasonRankings: {
          where: {
            rankType: SeasonRankingType.final,
          },
          orderBy: [
            { rankingDate: 'desc' },
            { capturedAt: 'desc' },
            { createdAt: 'desc' },
          ],
          take: 1,
          select: {
            // Scope columns for assertSeasonRankingScopeForParticipant
            // (작업 8 §11); never rendered into a response.
            id: true,
            seasonId: true,
            tradingAccountId: true,
            totalAssetKrw: true,
            returnRate: true,
            rankingDate: true,
            capturedAt: true,
          },
        },
      },
    });

    if (participant) {
      assertSeasonRankingScopeForParticipant(
        participant,
        participant.seasonRankings,
      );
    }

    return participant;
  }

  private countOrders(
    tradingAccountId: string,
    status: OrderStatus,
  ): Promise<number> {
    return this.prisma.order.count({
      where: {
        tradingAccountId,
        status,
      },
    });
  }

  private async findSnapshotHistory(
    seasonParticipantId: string,
    tradingAccountId: string,
  ): Promise<RankingHistoricalSnapshotInput[]> {
    const rows = await this.prisma.dailyPortfolioSnapshot.findMany({
      where: {
        tradingAccountId,
      },
      orderBy: [
        { snapshotDate: 'asc' },
        { capturedAt: 'asc' },
        { createdAt: 'asc' },
      ],
      select: {
        snapshotDate: true,
        totalAssetKrw: true,
        returnRate: true,
        capturedAt: true,
        createdAt: true,
      },
    });

    return rows.map((row) => ({ ...row, seasonParticipantId }));
  }

  private calculateMdd(
    fallbackMaxDrawdown: Prisma.Decimal,
    snapshots: readonly RankingHistoricalSnapshotInput[],
  ): Prisma.Decimal {
    if (snapshots.length > 0) {
      return calculateMaxDrawdownPercent(snapshots);
    }

    return fallbackMaxDrawdown;
  }

  private unavailableResponse(input: {
    season: RecordsSeason | null;
    participant: RecordsParticipant | null;
    query: ParsedRecordsQuery;
    reason: string;
    message: string;
  }): RecordsResponse {
    return {
      success: true,
      data: {
        state: 'unavailable',
        season: input.season ? this.formatSeason(input.season) : null,
        participant: input.participant
          ? this.formatParticipant(input.participant)
          : null,
        type: input.query.type,
        filters: {
          currencyCode: input.query.currencyCode ?? null,
        },
        ...this.emptyRequestedSections(input.query),
        reason: input.reason,
        message: input.message,
      },
    };
  }

  private emptyRequestedSections(query: ParsedRecordsQuery) {
    return {
      ...(query.type === 'all' || query.type === 'exchanges'
        ? { exchanges: this.emptySection(query) }
        : {}),
      ...(query.type === 'all' || query.type === 'wallets'
        ? { walletTransactions: this.emptySection(query) }
        : {}),
      ...(query.type === 'all' || query.type === 'orders'
        ? { orders: this.emptySection(query) }
        : {}),
    };
  }

  private emptySection(query: ParsedRecordsQuery) {
    return {
      state: 'available' as const,
      pagination: this.pagination(query, 0, 0),
      records: [],
    };
  }

  private pagination(
    query: ParsedRecordsQuery,
    total: number,
    returned: number,
  ): SectionPagination {
    return buildPagination({
      limit: query.limit,
      offset: query.offset,
      total,
      returned,
    });
  }

  private listPagination(
    query:
      | ParsedMySeasonRecordsQuery
      | ParsedMySeasonOrdersQuery
      | ParsedMySeasonExchangesQuery
      | ParsedMySeasonEquityQuery,
    total: number,
    returned: number,
  ): ListPagination {
    return buildPagination({
      limit: query.limit,
      offset: query.offset,
      total,
      returned,
    });
  }

  private emptyActivitySummary(): MySeasonRecordDetailResponse['data']['activitySummary'] {
    return {
      orders: {
        total: 0,
        submitted: 0,
        executed: 0,
        canceled: 0,
        rejected: 0,
      },
      exchanges: {
        total: 0,
      },
      walletTransactions: {
        total: 0,
      },
      positions: {
        open: 0,
      },
    };
  }

  private unavailablePerformance(): MySeasonRecordDetailResponse['data']['performance'] {
    return {
      state: 'unavailable',
      totalAssetKrw: null,
      returnRate: null,
      maxDrawdown: null,
      snapshotDate: null,
      capturedAt: null,
      reason: 'PERFORMANCE_UNAVAILABLE',
      message: 'Performance data is unavailable for this season.',
    };
  }

  private formatSeason(season: RecordsSeason) {
    return {
      id: season.id,
      name: season.name,
      status: season.status,
      startAt: season.startAt.toISOString(),
      endAt: season.endAt.toISOString(),
    };
  }

  private formatParticipant(participant: RecordsParticipant) {
    return {
      id: participant.id,
      status: participant.participantStatus,
      joinedAt: participant.joinedAt.toISOString(),
    };
  }

  private formatDetailedParticipant(participant: {
    id: string;
    joinedAt: Date;
    participantStatus: ParticipantStatus;
    initialCapitalKrw: Prisma.Decimal;
    finalRank: number | null;
    finalTier: string | null;
    rewardGrantedAt: Date | null;
  }): NonNullable<MySeasonRecordDetailResponse['data']['participant']> {
    return {
      id: participant.id,
      joinedAt: participant.joinedAt.toISOString(),
      participantStatus: participant.participantStatus,
      initialCapitalKrw: this.formatDecimal(participant.initialCapitalKrw, 8),
      finalRank: participant.finalRank,
      finalTier: participant.finalTier,
      rewardGrantedAt: this.formatNullableDate(participant.rewardGrantedAt),
    };
  }

  private isParticipantPubliclyVisible(
    participant: ParticipantPublicVisibility,
  ) {
    return (
      participant.participantStatus !== ParticipantStatus.excluded &&
      participant.rankingHiddenAt === null
    );
  }

  private publicVisibilityReason(participant: ParticipantPublicVisibility) {
    if (participant.participantStatus === ParticipantStatus.excluded) {
      return {
        reason: 'PARTICIPANT_EXCLUDED',
        message: 'Season participant summary is unavailable.',
      };
    }

    return {
      reason: 'RANKING_HIDDEN',
      message: 'Season participant summary is hidden.',
    };
  }

  private publicRankingParticipantWhere(): Prisma.SeasonParticipantWhereInput {
    return {
      participantStatus: {
        not: ParticipantStatus.excluded,
      },
      rankingHiddenAt: null,
    };
  }

  private formatPerformance(
    snapshot:
      | {
          totalAssetKrw: Prisma.Decimal;
          returnRate: Prisma.Decimal;
          snapshotDate: Date;
          capturedAt: Date;
        }
      | undefined,
    finalRanking:
      | {
          totalAssetKrw: Prisma.Decimal;
          returnRate: Prisma.Decimal;
          rankingDate: Date;
          capturedAt: Date;
        }
      | undefined,
    maxDrawdown: Prisma.Decimal,
  ): MySeasonRecordDetailResponse['data']['performance'] {
    if (snapshot) {
      return {
        state: 'available',
        totalAssetKrw: this.formatDecimal(snapshot.totalAssetKrw, 8),
        returnRate: this.formatDecimal(snapshot.returnRate, 8),
        maxDrawdown: this.formatDecimal(maxDrawdown, 8),
        snapshotDate: this.formatDateOnly(snapshot.snapshotDate),
        capturedAt: snapshot.capturedAt.toISOString(),
      };
    }

    if (finalRanking) {
      return {
        state: 'available',
        totalAssetKrw: this.formatDecimal(finalRanking.totalAssetKrw, 8),
        returnRate: this.formatDecimal(finalRanking.returnRate, 8),
        maxDrawdown: this.formatDecimal(maxDrawdown, 8),
        snapshotDate: this.formatDateOnly(finalRanking.rankingDate),
        capturedAt: finalRanking.capturedAt.toISOString(),
      };
    }

    return this.unavailablePerformance();
  }

  private selectBestMetric(
    finalRanking:
      | {
          totalAssetKrw: Prisma.Decimal;
          returnRate: Prisma.Decimal;
          rankingDate: Date;
          capturedAt: Date;
        }
      | undefined,
    snapshot:
      | {
          totalAssetKrw: Prisma.Decimal;
          returnRate: Prisma.Decimal;
          snapshotDate: Date;
          capturedAt: Date;
        }
      | undefined,
  ): SeasonRecordMetric | null {
    if (finalRanking) {
      return {
        totalAssetKrw: finalRanking.totalAssetKrw,
        returnRate: finalRanking.returnRate,
        metricDate: finalRanking.rankingDate,
        capturedAt: finalRanking.capturedAt,
      };
    }

    if (snapshot) {
      return {
        totalAssetKrw: snapshot.totalAssetKrw,
        returnRate: snapshot.returnRate,
        metricDate: snapshot.snapshotDate,
        capturedAt: snapshot.capturedAt,
      };
    }

    return null;
  }

  private formatDecimal(value: Prisma.Decimal, scale: number) {
    return value.toFixed(scale);
  }

  private formatNullableDecimal(value: Prisma.Decimal | null, scale: number) {
    return value ? this.formatDecimal(value, scale) : null;
  }

  private formatNullableDate(value: Date | null) {
    return value ? value.toISOString() : null;
  }

  private formatDateOnly(value: Date) {
    return value.toISOString().slice(0, 10);
  }

  private assertAuthenticated(
    userId: string | undefined,
  ): asserts userId is string {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }
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
