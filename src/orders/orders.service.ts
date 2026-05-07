import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  AssetPriceSourceType,
  CurrencyCode,
  FxRateSourceType,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import {
  feeRateScale,
  formatDecimalScale,
  monetaryScale,
  parsePositiveDecimalString,
  roundDecimalHalfUp,
} from '../fx/fx-decimal-policy';
import { isFxSnapshotStale } from '../fx/fx-execute-snapshot-policy';
import { PrismaService } from '../prisma/prisma.service';

export type OrdersQuery = {
  seasonId?: string;
  status?: string;
  side?: string;
  assetId?: string;
  limit?: string;
  offset?: string;
};

export type OrderRequestBody = {
  assetId?: unknown;
  side?: unknown;
  orderType?: unknown;
  quantity?: unknown;
  limitPrice?: unknown;
  currencyCode?: unknown;
  idempotencyKey?: unknown;
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

type ActiveOrderSeason = OrdersSeason & {
  tradeFeeRate: Prisma.Decimal;
};

type OrderAsset = {
  id: string;
  symbol: string;
  name: string;
  market: string;
  currencyCode: CurrencyCode;
  isActive: boolean;
};

type ParsedOrderRequest = {
  assetId: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: Prisma.Decimal;
  limitPrice: Prisma.Decimal | null;
  currencyCode?: CurrencyCode;
};

type OrderCreateIdempotency = {
  idempotencyKey: string;
  requestHash: string;
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

type OrderQuoteCalculation = {
  season: ActiveOrderSeason;
  participant: OrdersParticipant;
  asset: OrderAsset;
  request: ParsedOrderRequest;
  price: Prisma.Decimal;
  grossAmount: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  netAmount: Prisma.Decimal;
  krwGrossAmount: Prisma.Decimal;
  krwFeeAmount: Prisma.Decimal;
  krwNetAmount: Prisma.Decimal;
  assetPriceSnapshotId: string | null;
  fxRateSnapshotId: string | null;
  quoteAt: Date;
};

type OrderQuoteResponse = {
  success: true;
  data: ReturnType<OrdersService['formatOrderQuoteData']>;
};

type CreateOrderResponse = {
  success: true;
  data: {
    order: NonNullable<OrdersResponse['data']['orders']>[number];
    execution: {
      state: 'not_executed';
      reason: 'ORDER_EXECUTION_NOT_IMPLEMENTED';
      message: string;
    };
  };
};

type CancelOrderResponse = {
  success: true;
  data: {
    order: NonNullable<OrdersResponse['data']['orders']>[number];
    execution: {
      state: 'not_executed';
      reason: 'ORDER_CANCELED_BEFORE_EXECUTION';
      message: string;
    };
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
const MAX_DECIMAL_24_8 = new Prisma.Decimal('9999999999999999.99999999');
const ORDER_CREATE_REQUEST_HASH_API_VERSION = 'order-create:v1';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async quoteOrder(
    userId: string | undefined,
    body: OrderRequestBody = {},
  ): Promise<OrderQuoteResponse> {
    const quote = await this.buildOrderQuote(userId, body, new Date());

    return {
      success: true,
      data: this.formatOrderQuoteData(quote),
    };
  }

  async createOrder(
    userId: string | undefined,
    body: OrderRequestBody = {},
  ): Promise<CreateOrderResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const request = this.parseOrderRequest(body);
    const idempotency = this.buildOrderCreateIdempotency(body, request);
    const quoteAt = new Date();
    const season = await this.findActiveSeasonOrThrow();
    const participant = await this.findParticipantOrThrow(season.id, userId);
    const existingOrder = await this.findIdempotentCreateOrder(
      participant.id,
      idempotency.idempotencyKey,
    );

    if (existingOrder) {
      return this.replayIdempotentCreateOrder(existingOrder, idempotency);
    }

    const quote = await this.buildOrderQuoteForContext({
      season,
      participant,
      request,
      quoteAt,
    });
    const orderId = randomUUID();
    const responsePayloadJson = this.buildCreateOrderResponse(
      this.formatOrder({
        id: orderId,
        side: quote.request.side,
        orderType: quote.request.orderType,
        status: OrderStatus.submitted,
        quantity: quote.request.quantity,
        limitPrice:
          quote.request.orderType === OrderType.limit
            ? quote.request.limitPrice
            : null,
        executedPrice: null,
        currencyCode: quote.asset.currencyCode,
        grossAmount: quote.grossAmount,
        feeAmount: quote.feeAmount,
        netAmount: quote.netAmount,
        assetPriceSnapshotId: quote.assetPriceSnapshotId,
        fxRateSnapshotId: quote.fxRateSnapshotId,
        submittedAt: quote.quoteAt,
        executedAt: null,
        canceledAt: null,
        rejectedAt: null,
        rejectReason: null,
        createdAt: quote.quoteAt,
        updatedAt: quote.quoteAt,
        asset: {
          id: quote.asset.id,
          symbol: quote.asset.symbol,
          name: quote.asset.name,
          market: quote.asset.market,
          currencyCode: quote.asset.currencyCode,
        },
      }),
    );

    try {
      await this.prisma.order.create({
        data: {
          id: orderId,
          seasonParticipantId: quote.participant.id,
          assetId: quote.asset.id,
          side: quote.request.side,
          orderType: quote.request.orderType,
          status: OrderStatus.submitted,
          quantity: this.formatDecimal(quote.request.quantity, monetaryScale),
          limitPrice:
            quote.request.orderType === OrderType.limit
              ? this.formatNullableDecimal(
                  quote.request.limitPrice,
                  monetaryScale,
                )
              : null,
          executedPrice: null,
          currencyCode: quote.asset.currencyCode,
          grossAmount: this.formatDecimal(quote.grossAmount, monetaryScale),
          feeAmount: this.formatDecimal(quote.feeAmount, monetaryScale),
          netAmount: this.formatDecimal(quote.netAmount, monetaryScale),
          assetPriceSnapshotId: quote.assetPriceSnapshotId,
          fxRateSnapshotId: quote.fxRateSnapshotId,
          idempotencyKey: idempotency.idempotencyKey,
          requestHash: idempotency.requestHash,
          responsePayloadJson,
          submittedAt: quote.quoteAt,
          executedAt: null,
          canceledAt: null,
          rejectedAt: null,
          rejectReason: null,
          createdAt: quote.quoteAt,
          updatedAt: quote.quoteAt,
        },
        select: {
          id: true,
        },
      });

      return responsePayloadJson;
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }

      const racedOrder = await this.findIdempotentCreateOrder(
        quote.participant.id,
        idempotency.idempotencyKey,
      );

      if (!racedOrder) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'ORDER_IDEMPOTENCY_CONFLICT',
          'Order idempotency conflict.',
        );
      }

      return this.replayIdempotentCreateOrder(racedOrder, idempotency);
    }
  }

  async cancelOrder(
    userId: string | undefined,
    orderId: string | undefined,
  ): Promise<CancelOrderResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedOrderId = this.parseCancelOrderId(orderId);
    const existingOrder = await this.prisma.order.findFirst({
      where: {
        id: parsedOrderId,
        seasonParticipant: {
          userId,
        },
      },
      select: {
        id: true,
        seasonParticipantId: true,
        status: true,
      },
    });

    if (!existingOrder) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'ORDER_NOT_FOUND',
        'Order not found.',
      );
    }

    if (existingOrder.status !== OrderStatus.submitted) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_NOT_CANCELABLE',
        'Only submitted orders can be canceled.',
      );
    }

    const canceledAt = new Date();
    const updateResult = await this.prisma.order.updateMany({
      where: {
        id: existingOrder.id,
        seasonParticipantId: existingOrder.seasonParticipantId,
        status: OrderStatus.submitted,
      },
      data: {
        status: OrderStatus.canceled,
        canceledAt,
      },
    });

    if (updateResult.count !== 1) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_CANCEL_CONFLICT',
        'Order cancel conflicted with another state change.',
      );
    }

    const canceledOrder = await this.prisma.order.findUnique({
      where: {
        id: existingOrder.id,
      },
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
    });

    if (!canceledOrder) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_CANCEL_CONFLICT',
        'Canceled order could not be read back.',
      );
    }

    return {
      success: true,
      data: {
        order: this.formatOrder(canceledOrder),
        execution: {
          state: 'not_executed',
          reason: 'ORDER_CANCELED_BEFORE_EXECUTION',
          message: 'Order was canceled before execution.',
        },
      },
    };
  }

  async getOrders(
    userId: string | undefined,
    query: OrdersQuery = {},
  ): Promise<OrdersResponse> {
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
        orders: orders.map((order) => this.formatOrder(order)),
      },
    };
  }

  private async buildOrderQuote(
    userId: string | undefined,
    body: OrderRequestBody,
    quoteAt: Date,
  ): Promise<OrderQuoteCalculation> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const request = this.parseOrderRequest(body);
    return this.buildOrderQuoteFromParsedRequest(userId, request, quoteAt);
  }

  private async buildOrderQuoteFromParsedRequest(
    userId: string,
    request: ParsedOrderRequest,
    quoteAt: Date,
  ): Promise<OrderQuoteCalculation> {
    const season = await this.findActiveSeasonOrThrow();
    const participant = await this.findParticipantOrThrow(season.id, userId);

    return this.buildOrderQuoteForContext({
      season,
      participant,
      request,
      quoteAt,
    });
  }

  private async buildOrderQuoteForContext(input: {
    season: ActiveOrderSeason;
    participant: OrdersParticipant;
    request: ParsedOrderRequest;
    quoteAt: Date;
  }): Promise<OrderQuoteCalculation> {
    const { season, participant, request, quoteAt } = input;
    const asset = await this.findUsableAsset(request.assetId);
    if (request.currencyCode && request.currencyCode !== asset.currencyCode) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'ASSET_CURRENCY_MISMATCH',
        'currencyCode must match asset currencyCode.',
      );
    }

    const priceContext = await this.resolveOrderPrice(request, asset, quoteAt);
    const grossAmount = roundDecimalHalfUp(
      request.quantity.mul(priceContext.price),
      monetaryScale,
    );
    const feeAmount = roundDecimalHalfUp(
      grossAmount.mul(season.tradeFeeRate),
      monetaryScale,
    );
    const netAmount =
      request.side === OrderSide.buy
        ? roundDecimalHalfUp(grossAmount.add(feeAmount), monetaryScale)
        : roundDecimalHalfUp(grossAmount.sub(feeAmount), monetaryScale);

    if (netAmount.lt(0)) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INVALID_TRADE_FEE_RATE',
        'Trade fee rate makes net amount negative.',
      );
    }

    const fxSnapshot =
      asset.currencyCode === CurrencyCode.USD
        ? await this.findFreshUsdKrwSnapshot(quoteAt)
        : null;
    const krwAmounts = this.calculateKrwAmounts(
      {
        grossAmount,
        feeAmount,
        netAmount,
      },
      asset.currencyCode,
      fxSnapshot?.rate ?? null,
    );

    await this.assertOrderResourcesAvailable({
      participantId: participant.id,
      assetId: asset.id,
      side: request.side,
      currencyCode: asset.currencyCode,
      quantity: request.quantity,
      netAmount,
    });

    return {
      season,
      participant,
      asset,
      request,
      price: priceContext.price,
      grossAmount,
      feeAmount,
      netAmount,
      krwGrossAmount: krwAmounts.krwGrossAmount,
      krwFeeAmount: krwAmounts.krwFeeAmount,
      krwNetAmount: krwAmounts.krwNetAmount,
      assetPriceSnapshotId: priceContext.assetPriceSnapshotId,
      fxRateSnapshotId: fxSnapshot?.id ?? null,
      quoteAt,
    };
  }

  private async findActiveSeasonOrThrow(): Promise<ActiveOrderSeason> {
    const season = await this.findActiveSeason();
    if (!season) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'SEASON_NOT_ACTIVE',
        'Season is not active.',
      );
    }

    return season;
  }

  private async findParticipantOrThrow(
    seasonId: string,
    userId: string,
  ): Promise<OrdersParticipant> {
    const participant = await this.findParticipant(seasonId, userId);
    if (!participant) {
      this.throwApiError(
        HttpStatus.FORBIDDEN,
        'SEASON_NOT_JOINED',
        'Season is not joined.',
      );
    }

    return participant;
  }

  private buildOrderCreateIdempotency(
    body: OrderRequestBody,
    request: ParsedOrderRequest,
  ): OrderCreateIdempotency {
    const idempotencyKey = this.parseIdempotencyKey(body.idempotencyKey);
    const canonicalPayload = {
      apiVersion: ORDER_CREATE_REQUEST_HASH_API_VERSION,
      assetId: request.assetId,
      side: request.side,
      orderType: request.orderType,
      quantity: this.formatDecimal(request.quantity, monetaryScale),
      limitPrice:
        request.orderType === OrderType.limit
          ? this.formatNullableDecimal(request.limitPrice, monetaryScale)
          : null,
      currencyCode: request.currencyCode ?? null,
    };
    const canonicalJson = JSON.stringify(canonicalPayload);
    const requestHash = createHash('sha256')
      .update(canonicalJson, 'utf8')
      .digest('hex');

    return {
      idempotencyKey,
      requestHash,
    };
  }

  private parseOrderRequest(body: OrderRequestBody): ParsedOrderRequest {
    if (!body || typeof body !== 'object') {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_ORDER_REQUEST',
        'Order request body is required.',
      );
    }

    const orderType = this.parseOrderType(body.orderType);
    const limitPrice =
      orderType === OrderType.limit
        ? this.parsePositiveDecimalField(body.limitPrice, 'limitPrice')
        : null;

    return {
      assetId: this.parseRequiredText(body.assetId, 'assetId'),
      side: this.parseRequiredSide(body.side),
      orderType,
      quantity: this.parsePositiveDecimalField(body.quantity, 'quantity'),
      limitPrice,
      currencyCode: this.parseOptionalCurrencyCode(body.currencyCode),
    };
  }

  private parseCancelOrderId(orderId: string | undefined): string {
    if (typeof orderId !== 'string' || orderId.trim() === '') {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_ORDER_ID',
        'orderId is required.',
      );
    }

    return orderId.trim();
  }

  private parseIdempotencyKey(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_IDEMPOTENCY_KEY',
        'idempotencyKey is required.',
      );
    }

    return value.trim();
  }

  private async findIdempotentCreateOrder(
    seasonParticipantId: string,
    idempotencyKey: string,
  ) {
    return this.prisma.order.findFirst({
      where: {
        seasonParticipantId,
        idempotencyKey,
      },
      select: {
        id: true,
        requestHash: true,
        responsePayloadJson: true,
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
    });
  }

  private replayIdempotentCreateOrder(
    order: NonNullable<
      Awaited<ReturnType<OrdersService['findIdempotentCreateOrder']>>
    >,
    idempotency: OrderCreateIdempotency,
  ): CreateOrderResponse {
    if (order.requestHash !== idempotency.requestHash) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_IDEMPOTENCY_CONFLICT',
        'Same idempotencyKey was used with a different order create request.',
      );
    }

    if (order.responsePayloadJson) {
      return order.responsePayloadJson as unknown as CreateOrderResponse;
    }

    return this.buildCreateOrderResponse(this.formatOrder(order));
  }

  private buildCreateOrderResponse(
    order: NonNullable<OrdersResponse['data']['orders']>[number],
  ): CreateOrderResponse {
    return {
      success: true,
      data: {
        order,
        execution: {
          state: 'not_executed',
          reason: 'ORDER_EXECUTION_NOT_IMPLEMENTED',
          message: 'Order execution is not implemented in this MVP.',
        },
      },
    };
  }

  private parseOrderType(value: unknown): OrderType {
    const text = this.parseRequiredText(value, 'orderType');
    if (text === OrderType.market || text === OrderType.limit) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_ORDER_TYPE',
      'Invalid orderType.',
    );
  }

  private parseRequiredSide(value: unknown): OrderSide {
    const text = this.parseRequiredText(value, 'side');
    if (text === OrderSide.buy || text === OrderSide.sell) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_ORDER_SIDE',
      'Invalid order side.',
    );
  }

  private parsePositiveDecimalField(
    value: unknown,
    fieldName: string,
  ): Prisma.Decimal {
    try {
      const decimal = parsePositiveDecimalString(value);
      if (decimal.decimalPlaces() > monetaryScale) {
        throw new Error(`${fieldName} must fit Decimal(24, 8) scale.`);
      }

      if (decimal.gt(MAX_DECIMAL_24_8)) {
        throw new Error(`${fieldName} must fit Decimal(24, 8) precision.`);
      }

      return decimal;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `${fieldName} must be a positive decimal string.`;
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        `INVALID_${this.toErrorFieldName(fieldName)}`,
        message,
      );
    }
  }

  private parseRequiredText(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        `INVALID_${this.toErrorFieldName(fieldName)}`,
        `${fieldName} is required.`,
      );
    }

    return value.trim();
  }

  private parseOptionalCurrencyCode(value: unknown): CurrencyCode | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (value === CurrencyCode.KRW || value === CurrencyCode.USD) {
      return value;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_CURRENCY_CODE',
      'Invalid currencyCode.',
    );
  }

  private toErrorFieldName(fieldName: string) {
    return fieldName.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase();
  }

  private async findActiveSeason(): Promise<ActiveOrderSeason | null> {
    return this.prisma.season.findFirst({
      where: {
        status: SeasonStatus.active,
      },
      select: {
        id: true,
        name: true,
        status: true,
        startAt: true,
        endAt: true,
        tradeFeeRate: true,
      },
      orderBy: this.getSeasonOrderBy(SeasonStatus.active),
    });
  }

  private async findUsableAsset(assetId: string): Promise<OrderAsset> {
    const asset = await this.prisma.asset.findUnique({
      where: {
        id: assetId,
      },
      select: {
        id: true,
        symbol: true,
        name: true,
        market: true,
        currencyCode: true,
        isActive: true,
      },
    });

    if (!asset) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'ASSET_NOT_FOUND',
        'Asset not found.',
      );
    }

    if (!asset.isActive) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'ASSET_INACTIVE',
        'Asset is inactive.',
      );
    }

    return asset;
  }

  private async resolveOrderPrice(
    request: ParsedOrderRequest,
    asset: OrderAsset,
    quoteAt: Date,
  ): Promise<{
    price: Prisma.Decimal;
    assetPriceSnapshotId: string | null;
  }> {
    if (request.orderType === OrderType.limit) {
      if (!request.limitPrice) {
        this.throwApiError(
          HttpStatus.BAD_REQUEST,
          'INVALID_LIMIT_PRICE',
          'limitPrice is required for limit orders.',
        );
      }

      return {
        price: roundDecimalHalfUp(request.limitPrice, monetaryScale),
        assetPriceSnapshotId: null,
      };
    }

    const snapshot = await this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: asset.id,
        currencyCode: asset.currencyCode,
        sourceType: AssetPriceSourceType.admin_manual,
        effectiveAt: {
          lte: quoteAt,
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
      },
    });

    if (!snapshot) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'ASSET_PRICE_UNAVAILABLE',
        'Asset price is unavailable.',
      );
    }

    return {
      price: roundDecimalHalfUp(snapshot.price, monetaryScale),
      assetPriceSnapshotId: snapshot.id,
    };
  }

  private async findFreshUsdKrwSnapshot(quoteAt: Date): Promise<{
    id: string;
    rate: Prisma.Decimal;
  }> {
    const snapshot = await this.prisma.fxRateSnapshot.findFirst({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        sourceType: FxRateSourceType.admin_manual,
        approvedByUserId: {
          not: null,
        },
        effectiveAt: {
          lte: quoteAt,
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
        effectiveAt: true,
      },
    });

    if (!snapshot) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FX_RATE_UNAVAILABLE',
        'FX rate is unavailable.',
      );
    }

    if (isFxSnapshotStale(snapshot.effectiveAt, quoteAt)) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FX_RATE_STALE',
        'FX rate is stale.',
      );
    }

    return {
      id: snapshot.id,
      rate: roundDecimalHalfUp(snapshot.rate, monetaryScale),
    };
  }

  private calculateKrwAmounts(
    amounts: {
      grossAmount: Prisma.Decimal;
      feeAmount: Prisma.Decimal;
      netAmount: Prisma.Decimal;
    },
    currencyCode: CurrencyCode,
    usdKrwRate: Prisma.Decimal | null,
  ) {
    if (currencyCode === CurrencyCode.KRW) {
      return {
        krwGrossAmount: amounts.grossAmount,
        krwFeeAmount: amounts.feeAmount,
        krwNetAmount: amounts.netAmount,
      };
    }

    if (!usdKrwRate) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FX_RATE_UNAVAILABLE',
        'FX rate is unavailable.',
      );
    }

    return {
      krwGrossAmount: roundDecimalHalfUp(
        amounts.grossAmount.mul(usdKrwRate),
        monetaryScale,
      ),
      krwFeeAmount: roundDecimalHalfUp(
        amounts.feeAmount.mul(usdKrwRate),
        monetaryScale,
      ),
      krwNetAmount: roundDecimalHalfUp(
        amounts.netAmount.mul(usdKrwRate),
        monetaryScale,
      ),
    };
  }

  private async assertOrderResourcesAvailable(input: {
    participantId: string;
    assetId: string;
    side: OrderSide;
    currencyCode: CurrencyCode;
    quantity: Prisma.Decimal;
    netAmount: Prisma.Decimal;
  }) {
    if (input.side === OrderSide.buy) {
      const wallet = await this.prisma.cashWallet.findUnique({
        where: {
          seasonParticipantId_currencyCode: {
            seasonParticipantId: input.participantId,
            currencyCode: input.currencyCode,
          },
        },
        select: {
          balanceAmount: true,
        },
      });

      if (!wallet || wallet.balanceAmount.lt(input.netAmount)) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'INSUFFICIENT_CASH_BALANCE',
          'Cash wallet balance is insufficient.',
        );
      }

      return;
    }

    const position = await this.prisma.position.findUnique({
      where: {
        seasonParticipantId_assetId: {
          seasonParticipantId: input.participantId,
          assetId: input.assetId,
        },
      },
      select: {
        quantity: true,
      },
    });

    if (!position || position.quantity.lt(input.quantity)) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_POSITION_QUANTITY',
        'Position quantity is insufficient.',
      );
    }
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

  private formatOrderQuoteData(quote: OrderQuoteCalculation) {
    return {
      state: 'available' as const,
      season: this.formatSeason(quote.season),
      participant: this.formatParticipant(quote.participant),
      asset: {
        id: quote.asset.id,
        symbol: quote.asset.symbol,
        name: quote.asset.name,
        market: quote.asset.market,
        currencyCode: quote.asset.currencyCode,
      },
      side: quote.request.side,
      orderType: quote.request.orderType,
      quantity: this.formatDecimal(quote.request.quantity, monetaryScale),
      price: this.formatDecimal(quote.price, monetaryScale),
      currencyCode: quote.asset.currencyCode,
      grossAmount: this.formatDecimal(quote.grossAmount, monetaryScale),
      feeRate: formatDecimalScale(quote.season.tradeFeeRate, feeRateScale),
      feeAmount: this.formatDecimal(quote.feeAmount, monetaryScale),
      netAmount: this.formatDecimal(quote.netAmount, monetaryScale),
      krwGrossAmount: this.formatDecimal(quote.krwGrossAmount, monetaryScale),
      krwFeeAmount: this.formatDecimal(quote.krwFeeAmount, monetaryScale),
      krwNetAmount: this.formatDecimal(quote.krwNetAmount, monetaryScale),
      assetPriceSnapshotId: quote.assetPriceSnapshotId,
      fxRateSnapshotId: quote.fxRateSnapshotId,
      quoteId: null,
      expiresAt: null,
      quoteAt: quote.quoteAt.toISOString(),
    };
  }

  private formatOrder(order: {
    id: string;
    side: OrderSide;
    orderType: OrderType;
    status: OrderStatus;
    quantity: Prisma.Decimal;
    limitPrice: Prisma.Decimal | null;
    executedPrice: Prisma.Decimal | null;
    currencyCode: CurrencyCode;
    grossAmount: Prisma.Decimal | null;
    feeAmount: Prisma.Decimal | null;
    netAmount: Prisma.Decimal | null;
    assetPriceSnapshotId: string | null;
    fxRateSnapshotId: string | null;
    submittedAt: Date;
    executedAt: Date | null;
    canceledAt: Date | null;
    rejectedAt: Date | null;
    rejectReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    asset: {
      id: string;
      symbol: string;
      name: string;
      market: string;
      currencyCode: CurrencyCode;
    };
  }) {
    return {
      orderId: order.id,
      asset: order.asset,
      side: order.side,
      orderType: order.orderType,
      status: order.status,
      quantity: this.formatDecimal(order.quantity, monetaryScale),
      limitPrice: this.formatNullableDecimal(order.limitPrice, monetaryScale),
      executedPrice: this.formatNullableDecimal(
        order.executedPrice,
        monetaryScale,
      ),
      currencyCode: order.currencyCode,
      grossAmount: this.formatNullableDecimal(order.grossAmount, monetaryScale),
      feeAmount: this.formatNullableDecimal(order.feeAmount, monetaryScale),
      netAmount: this.formatNullableDecimal(order.netAmount, monetaryScale),
      assetPriceSnapshotId: order.assetPriceSnapshotId,
      fxRateSnapshotId: order.fxRateSnapshotId,
      submittedAt: order.submittedAt.toISOString(),
      executedAt: this.formatNullableDate(order.executedAt),
      canceledAt: this.formatNullableDate(order.canceledAt),
      rejectedAt: this.formatNullableDate(order.rejectedAt),
      rejectReason: order.rejectReason,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
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
    return formatDecimalScale(value, scale);
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

  private throwApiError(
    status: HttpStatus,
    code: string,
    message: string,
  ): never {
    throw new HttpException(this.createErrorBody(code, message), status);
  }

  private isUniqueConstraintError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    return (error as { code?: unknown }).code === 'P2002';
  }
}
