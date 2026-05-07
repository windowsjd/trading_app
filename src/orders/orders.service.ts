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

export type OrdersQuery = {
  seasonId?: string;
  status?: string;
  side?: string;
  assetId?: string;
  limit?: string;
  offset?: string;
};

type OrdersState = 'available' | 'not_joined' | 'unavailable';

type OrdersSeason = {
  id: string;
  name: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
};

type OrdersParticipant = {
  id: string;
  participantStatus: ParticipantStatus;
  joinedAt: Date;
};

type ParsedOrdersQuery = {
  seasonId?: string;
  status?: OrderStatus;
  side?: OrderSide;
  assetId?: string;
  limit: number;
  offset: number;
};

type OrdersResponse = {
  success: true;
  data: {
    state: OrdersState;
    season: ReturnType<OrdersService['formatSeason']> | null;
    participant: ReturnType<OrdersService['formatParticipant']> | null;
    filters: {
      status: OrderStatus | null;
      side: OrderSide | null;
      assetId: string | null;
    };
    pagination: {
      limit: number;
      offset: number;
      total: number;
      returned: number;
    };
    orders: Array<{
      orderId: string;
      asset: {
        id: string;
        symbol: string;
        name: string;
        market: string;
        currencyCode: CurrencyCode;
      };
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
      submittedAt: string;
      executedAt: string | null;
      canceledAt: string | null;
      rejectedAt: string | null;
      rejectReason: string | null;
      createdAt: string;
      updatedAt: string;
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
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrders(
    userId: string | undefined,
    query: OrdersQuery = {},
  ): Promise<OrdersResponse> {
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
          filters: this.formatFilters(parsedQuery),
          pagination: this.pagination(parsedQuery, 0, 0),
          orders: [],
          reason: 'SEASON_NOT_JOINED',
          message: 'Orders are available after joining the season.',
        },
      };
    }

    const where = {
      seasonParticipantId: participant.id,
      ...(parsedQuery.status ? { status: parsedQuery.status } : {}),
      ...(parsedQuery.side ? { side: parsedQuery.side } : {}),
      ...(parsedQuery.assetId ? { assetId: parsedQuery.assetId } : {}),
    };
    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }],
        skip: parsedQuery.offset,
        take: parsedQuery.limit,
        select: {
          id: true,
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
          submittedAt: true,
          executedAt: true,
          canceledAt: true,
          rejectedAt: true,
          rejectReason: true,
          createdAt: true,
          updatedAt: true,
          asset: {
            select: {
              id: true,
              symbol: true,
              name: true,
              market: true,
              currencyCode: true,
            },
          },
        },
      }),
    ]);

    return {
      success: true,
      data: {
        state: 'available',
        season: this.formatSeason(season),
        participant: this.formatParticipant(participant),
        filters: this.formatFilters(parsedQuery),
        pagination: this.pagination(parsedQuery, total, orders.length),
        orders: orders.map((order) => ({
          orderId: order.id,
          asset: order.asset,
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
          assetPriceSnapshotId: order.assetPriceSnapshotId,
          fxRateSnapshotId: order.fxRateSnapshotId,
          submittedAt: order.submittedAt.toISOString(),
          executedAt: this.formatNullableDate(order.executedAt),
          canceledAt: this.formatNullableDate(order.canceledAt),
          rejectedAt: this.formatNullableDate(order.rejectedAt),
          rejectReason: order.rejectReason,
          createdAt: order.createdAt.toISOString(),
          updatedAt: order.updatedAt.toISOString(),
        })),
      },
    };
  }

  private parseQuery(query: OrdersQuery): ParsedOrdersQuery {
    return {
      seasonId: this.parseOptionalText(query.seasonId),
      status: this.parseStatus(query.status),
      side: this.parseSide(query.side),
      assetId: this.parseOptionalText(query.assetId),
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
  }

  private parseStatus(value: string | undefined): OrderStatus | undefined {
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

  private parseSide(value: string | undefined): OrderSide | undefined {
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

  private async findCurrentSeason(): Promise<OrdersSeason | null> {
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

  private async findSeasonById(seasonId: string): Promise<OrdersSeason | null> {
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
  ): Promise<OrdersParticipant | null> {
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
    season: OrdersSeason | null;
    participant: OrdersParticipant | null;
    query: ParsedOrdersQuery;
    reason: string;
    message: string;
  }): OrdersResponse {
    return {
      success: true,
      data: {
        state: 'unavailable',
        season: input.season ? this.formatSeason(input.season) : null,
        participant: input.participant
          ? this.formatParticipant(input.participant)
          : null,
        filters: this.formatFilters(input.query),
        pagination: this.pagination(input.query, 0, 0),
        orders: [],
        reason: input.reason,
        message: input.message,
      },
    };
  }

  private formatFilters(query: ParsedOrdersQuery) {
    return {
      status: query.status ?? null,
      side: query.side ?? null,
      assetId: query.assetId ?? null,
    };
  }

  private pagination(
    query: ParsedOrdersQuery,
    total: number,
    returned: number,
  ) {
    return {
      limit: query.limit,
      offset: query.offset,
      total,
      returned,
    };
  }

  private formatSeason(season: OrdersSeason) {
    return {
      id: season.id,
      name: season.name,
      status: season.status,
      startAt: season.startAt.toISOString(),
      endAt: season.endAt.toISOString(),
    };
  }

  private formatParticipant(participant: OrdersParticipant) {
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
