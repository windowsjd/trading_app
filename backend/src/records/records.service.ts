import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  AssetType,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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

type RecordsType = 'all' | 'exchanges' | 'wallets' | 'orders';
type RecordsState = 'available' | 'not_joined' | 'unavailable';
type SeasonHistoryState = 'available' | 'empty';
type SeasonRecordDetailState = 'available' | 'not_joined';
type SectionState = 'available' | 'unavailable';
type PerformanceState = 'available' | 'unavailable';

type RecordsSeason = {
  id: string;
  name: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
};

type RecordsParticipant = {
  id: string;
  participantStatus: ParticipantStatus;
  joinedAt: Date;
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

type SectionPagination = {
  limit: number;
  offset: number;
  total: number;
  returned: number;
};

type ListPagination = {
  limit: number;
  offset: number;
  returned: number;
};

type SeasonRecordMetric = {
  totalAssetKrw: Prisma.Decimal;
  returnRate: Prisma.Decimal;
  metricDate: Date;
  capturedAt: Date;
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
      limitPrice: string | null;
      executedPrice: string | null;
      currencyCode: CurrencyCode;
      grossAmount: string | null;
      feeAmount: string | null;
      netAmount: string | null;
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
      finalRank: number | null;
      finalTier: string | null;
      rewardGranted: boolean;
      totalAssetKrw: string | null;
      returnRate: string | null;
      orderCount: number;
      exchangeCount: number;
    } | null;
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
export class RecordsService {
  constructor(private readonly prisma: PrismaService) {}

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
        ? this.buildExchangeSection(participant.id, parsedQuery)
        : Promise.resolve(undefined),
      parsedQuery.type === 'all' || parsedQuery.type === 'wallets'
        ? this.buildWalletTransactionSection(participant.id, parsedQuery)
        : Promise.resolve(undefined),
      parsedQuery.type === 'all' || parsedQuery.type === 'orders'
        ? this.buildOrderSection(participant.id, parsedQuery)
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
          pagination: this.listPagination(parsedQuery, 0),
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
        seasonId: true,
        joinedAt: true,
        participantStatus: true,
        initialCapitalKrw: true,
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
            totalAssetKrw: true,
            returnRate: true,
            rankingDate: true,
            capturedAt: true,
          },
        },
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
    });

    return {
      success: true,
      data: {
        state: 'available',
        seasons: participants.map((participant) => {
          const metric = this.selectBestMetric(
            participant.seasonRankings[0],
            participant.dailyPortfolioSnapshots[0],
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
            orderCount: participant._count.orders,
            exchangeCount: participant._count.exchangeTransactions,
            walletTransactionCount: participant._count.walletTransactions,
          };
        }),
        pagination: this.listPagination(parsedQuery, participants.length),
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
    ] = await Promise.all([
      this.countOrders(participant.id, OrderStatus.submitted),
      this.countOrders(participant.id, OrderStatus.executed),
      this.countOrders(participant.id, OrderStatus.canceled),
      this.countOrders(participant.id, OrderStatus.rejected),
      this.prisma.position.count({
        where: {
          seasonParticipantId: participant.id,
          quantity: {
            gt: 0,
          },
        },
      }),
    ]);

    return {
      success: true,
      data: {
        state: 'available',
        season: this.formatSeason(season),
        participant: this.formatDetailedParticipant(participant),
        performance: this.formatPerformance(
          participant.dailyPortfolioSnapshots[0],
          participant.seasonRankings[0],
        ),
        activitySummary: {
          orders: {
            total: participant._count.orders,
            submitted: submittedOrders,
            executed: executedOrders,
            canceled: canceledOrders,
            rejected: rejectedOrders,
          },
          exchanges: {
            total: participant._count.exchangeTransactions,
          },
          walletTransactions: {
            total: participant._count.walletTransactions,
          },
          positions: {
            open: openPositions,
          },
        },
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
          pagination: this.listPagination(parsedQuery, 0),
          reason: 'SEASON_NOT_JOINED',
          message: 'Order records are available after joining the season.',
        },
      };
    }

    const where = {
      seasonParticipantId: participant.id,
      ...(parsedQuery.status ? { status: parsedQuery.status } : {}),
      ...(parsedQuery.side ? { side: parsedQuery.side } : {}),
      ...(parsedQuery.assetId ? { assetId: parsedQuery.assetId } : {}),
    };
    const orders = await this.prisma.order.findMany({
      where,
      orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      skip: parsedQuery.offset,
      take: parsedQuery.limit,
      select: {
        id: true,
        assetId: true,
        side: true,
        orderType: true,
        status: true,
        quantity: true,
        limitPrice: true,
        executedPrice: true,
        currencyCode: true,
        grossAmount: true,
        feeAmount: true,
        netAmount: true,
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
    });

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
          limitPrice: this.formatNullableDecimal(order.limitPrice, 8),
          executedPrice: this.formatNullableDecimal(order.executedPrice, 8),
          currencyCode: order.currencyCode,
          grossAmount: this.formatNullableDecimal(order.grossAmount, 8),
          feeAmount: this.formatNullableDecimal(order.feeAmount, 8),
          netAmount: this.formatNullableDecimal(order.netAmount, 8),
          submittedAt: order.submittedAt.toISOString(),
          executedAt: this.formatNullableDate(order.executedAt),
          canceledAt: this.formatNullableDate(order.canceledAt),
          rejectedAt: this.formatNullableDate(order.rejectedAt),
          rejectReason: order.rejectReason,
        })),
        pagination: this.listPagination(parsedQuery, orders.length),
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
          pagination: this.listPagination(parsedQuery, 0),
          reason: 'SEASON_NOT_JOINED',
          message: 'Exchange records are available after joining the season.',
        },
      };
    }

    const where = {
      seasonParticipantId: participant.id,
      ...(parsedQuery.fromCurrency
        ? { fromCurrency: parsedQuery.fromCurrency }
        : {}),
      ...(parsedQuery.toCurrency ? { toCurrency: parsedQuery.toCurrency } : {}),
    };
    const exchanges = await this.prisma.exchangeTransaction.findMany({
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
    });

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
        pagination: this.listPagination(parsedQuery, exchanges.length),
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
          reason: 'SEASON_NOT_JOINED',
          message: 'The user has not joined this season.',
        },
      };
    }

    const [orderCount, exchangeCount] = await Promise.all([
      this.prisma.order.count({
        where: {
          seasonParticipantId: participant.id,
        },
      }),
      this.prisma.exchangeTransaction.count({
        where: {
          seasonParticipantId: participant.id,
        },
      }),
    ]);
    const metric = this.selectBestMetric(
      participant.seasonRankings[0],
      participant.dailyPortfolioSnapshots[0],
    );

    return {
      success: true,
      data: {
        state: 'available',
        user: targetUser,
        season: publicSeason,
        summary: {
          finalRank: participant.finalRank,
          finalTier: participant.finalTier,
          rewardGranted: participant.rewardGrantedAt !== null,
          totalAssetKrw: metric
            ? this.formatDecimal(metric.totalAssetKrw, 8)
            : null,
          returnRate: metric ? this.formatDecimal(metric.returnRate, 8) : null,
          orderCount,
          exchangeCount,
        },
      },
    };
  }

  private async buildExchangeSection(
    seasonParticipantId: string,
    query: ParsedRecordsQuery,
  ): Promise<NonNullable<RecordsResponse['data']['exchanges']>> {
    const where = {
      seasonParticipantId,
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
    seasonParticipantId: string,
    query: ParsedRecordsQuery,
  ): Promise<NonNullable<RecordsResponse['data']['walletTransactions']>> {
    const where = {
      seasonParticipantId,
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
    seasonParticipantId: string,
    query: ParsedRecordsQuery,
  ): Promise<NonNullable<RecordsResponse['data']['orders']>> {
    const where = {
      seasonParticipantId,
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
        participantStatus: true,
        joinedAt: true,
      },
    });
  }

  private async findDetailedParticipant(seasonId: string, userId: string) {
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
        initialCapitalKrw: true,
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
            totalAssetKrw: true,
            returnRate: true,
            rankingDate: true,
            capturedAt: true,
          },
        },
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
    });
  }

  private countOrders(
    seasonParticipantId: string,
    status: OrderStatus,
  ): Promise<number> {
    return this.prisma.order.count({
      where: {
        seasonParticipantId,
        status,
      },
    });
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
    return {
      limit: query.limit,
      offset: query.offset,
      total,
      returned,
    };
  }

  private listPagination(
    query:
      | ParsedMySeasonRecordsQuery
      | ParsedMySeasonOrdersQuery
      | ParsedMySeasonExchangesQuery,
    returned: number,
  ): ListPagination {
    return {
      limit: query.limit,
      offset: query.offset,
      returned,
    };
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
  ): MySeasonRecordDetailResponse['data']['performance'] {
    if (snapshot) {
      return {
        state: 'available',
        totalAssetKrw: this.formatDecimal(snapshot.totalAssetKrw, 8),
        returnRate: this.formatDecimal(snapshot.returnRate, 8),
        snapshotDate: this.formatDateOnly(snapshot.snapshotDate),
        capturedAt: snapshot.capturedAt.toISOString(),
      };
    }

    if (finalRanking) {
      return {
        state: 'available',
        totalAssetKrw: this.formatDecimal(finalRanking.totalAssetKrw, 8),
        returnRate: this.formatDecimal(finalRanking.returnRate, 8),
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
