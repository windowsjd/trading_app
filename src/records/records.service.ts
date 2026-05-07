import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
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

type RecordsType = 'all' | 'exchanges' | 'wallets' | 'orders';
type RecordsState = 'available' | 'not_joined' | 'unavailable';
type SectionState = 'available' | 'unavailable';

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

type SectionPagination = {
  limit: number;
  offset: number;
  total: number;
  returned: number;
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
      this.throwApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
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

  private parseCurrencyCode(value: string | undefined): CurrencyCode | undefined {
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

  private async findSeasonById(seasonId: string): Promise<RecordsSeason | null> {
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

  private formatDecimal(value: Prisma.Decimal, scale: number) {
    return value.toFixed(scale);
  }

  private formatNullableDecimal(value: Prisma.Decimal | null, scale: number) {
    return value ? this.formatDecimal(value, scale) : null;
  }

  private formatNullableDate(value: Date | null) {
    return value ? value.toISOString() : null;
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
