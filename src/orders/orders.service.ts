import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  QuoteStatus,
  QuoteType,
  SeasonStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
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
import {
  buildAdminManualFallbackDecision,
  isPositiveDecimal,
  resolveAssetProviderEligibility,
  resolveFxProviderEligibility,
  selectFreshProviderSnapshot,
  type SourceDecision,
} from '../providers/source-eligibility.policy';
import {
  presentLimitPriceSource,
  presentSourceDecision,
  type PublicSourceMetadata,
} from '../providers/source-metadata.presenter';
import {
  buildQuoteExpiresAt,
  computeOrderQuoteRequestHash,
} from '../providers/durable-quote.policy';
import {
  calculateChangeBps,
  resolveDefaultMaxChangeBps,
} from '../providers/realtime-execution-policy';

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
  quoteId?: unknown;
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
  assetType: AssetType;
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

type OrderQuoteSourceWorkflow = 'orders_quote' | 'orders_create';

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
      quoteId: string | null;
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
  fxRate: Prisma.Decimal | null;
  assetPriceSource: PublicSourceMetadata | null;
  fxRateSource: PublicSourceMetadata | null;
  quoteAt: Date;
  quoteId: string | null;
  expiresAt: Date | null;
  maxChangeBps: Prisma.Decimal | null;
  requestHash: string | null;
};

type DurableOrderQuoteForCreate = {
  id: string;
  seasonParticipantId: string | null;
  status: QuoteStatus;
  assetId: string | null;
  side: OrderSide | null;
  orderType: OrderType | null;
  quantity: Prisma.Decimal | null;
  limitPrice: Prisma.Decimal | null;
  currencyCode: CurrencyCode | null;
  quotedPrice: Prisma.Decimal;
  assetPriceSnapshotId: string | null;
  fxRateSnapshotId: string | null;
  expiresAt: Date;
  requestHash: string;
  asset: OrderAsset;
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

type ExecuteOrderResponse = {
  success: true;
  data: {
    order: NonNullable<OrdersResponse['data']['orders']>[number];
    execution: {
      state: 'executed' | 'already_executed';
      executedAt: string | null;
      priceSource: 'provider_api' | 'admin_manual';
      quoteId: string | null;
      quotedPrice?: string | null;
      executePrice?: string | null;
      priceChangeBps?: string | null;
      quotedRate?: string | null;
      executeRate?: string | null;
      rateChangeBps?: string | null;
      assetPriceSource?: PublicSourceMetadata | null;
      fxRateSource?: PublicSourceMetadata | null;
      assetPriceSnapshotId: string | null;
      fxRateSnapshotId: string | null;
      walletTransactionId: string | null;
      walletBalanceAfter: string | null;
      positionId: string | null;
      duplicate: boolean;
    };
  };
};

type OrderExecutionRecord = {
  id: string;
  seasonParticipantId: string;
  assetId: string;
  quoteId: string | null;
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
    assetType: AssetType;
    currencyCode: CurrencyCode;
  };
  quote: {
    id: string;
    userId: string;
    seasonParticipantId: string | null;
    status: QuoteStatus;
    assetId: string | null;
    side: OrderSide | null;
    orderType: OrderType | null;
    quantity: Prisma.Decimal | null;
    limitPrice: Prisma.Decimal | null;
    currencyCode: CurrencyCode | null;
    quotedPrice: Prisma.Decimal | null;
    quotedRate: Prisma.Decimal | null;
    maxChangeBps: Prisma.Decimal;
    expiresAt: Date;
    requestHash: string;
  } | null;
  seasonParticipant: {
    id: string;
    participantStatus: ParticipantStatus;
    joinedAt: Date;
    season: ActiveOrderSeason;
  };
};

type OrderExecutionPlan = {
  executedAt: Date;
  executedPrice: Prisma.Decimal;
  quotedPrice: Prisma.Decimal;
  priceChangeBps: Prisma.Decimal | null;
  grossAmount: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  netAmount: Prisma.Decimal;
  assetPriceSnapshotId: string;
  assetPriceSource: PublicSourceMetadata | null;
  fxRateSnapshotId: string | null;
  quotedRate: Prisma.Decimal | null;
  executeRate: Prisma.Decimal | null;
  rateChangeBps: Prisma.Decimal | null;
  fxRateSource: PublicSourceMetadata | null;
};

type OrderExecutionTransactionResult = {
  order: NonNullable<OrdersResponse['data']['orders']>[number];
  walletTransactionId: string;
  walletBalanceAfter: string;
  positionId: string | null;
  plan: OrderExecutionPlan;
};

type OrderExecuteTransactionClient = Prisma.TransactionClient;

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
const ZERO_MONEY = '0.00000000';
const ORDER_EXECUTION_SELECT = {
  id: true,
  seasonParticipantId: true,
  assetId: true,
  quoteId: true,
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
      assetType: true,
      currencyCode: true,
    },
  },
  quote: {
    select: {
      id: true,
      userId: true,
      seasonParticipantId: true,
      status: true,
      assetId: true,
      side: true,
      orderType: true,
      quantity: true,
      limitPrice: true,
      currencyCode: true,
      quotedPrice: true,
      quotedRate: true,
      maxChangeBps: true,
      expiresAt: true,
      requestHash: true,
    },
  },
  seasonParticipant: {
    select: {
      id: true,
      participantStatus: true,
      joinedAt: true,
      season: {
        select: {
          id: true,
          name: true,
          status: true,
          startAt: true,
          endAt: true,
          tradeFeeRate: true,
        },
      },
    },
  },
} as const;

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async quoteOrder(
    userId: string | undefined,
    body: OrderRequestBody = {},
  ): Promise<OrderQuoteResponse> {
    const quote = await this.buildOrderQuote(
      userId,
      body,
      new Date(),
      'orders_quote',
    );
    const durableQuote = await this.createDurableOrderQuote(userId, quote);

    return {
      success: true,
      data: this.formatOrderQuoteData(durableQuote),
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
    const submittedAt = new Date();
    const season = await this.findActiveSeasonOrThrow();
    const participant = await this.findParticipantOrThrow(season.id, userId);
    const existingOrder = await this.findIdempotentCreateOrder(
      participant.id,
      idempotency.idempotencyKey,
    );

    if (existingOrder) {
      return this.replayIdempotentCreateOrder(existingOrder, idempotency);
    }

    const quoteId = this.parseQuoteId(body.quoteId);
    const quote = await this.findActiveOrderQuoteForCreateOrThrow({
      quoteId,
      userId,
      seasonParticipantId: participant.id,
      request,
      now: submittedAt,
    });
    const price = roundDecimalHalfUp(quote.quotedPrice, monetaryScale);
    const grossAmount = roundDecimalHalfUp(
      request.quantity.mul(price),
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

    await this.assertOrderResourcesAvailable({
      participantId: participant.id,
      assetId: quote.asset.id,
      side: request.side,
      currencyCode: quote.asset.currencyCode,
      quantity: request.quantity,
      netAmount,
    });
    const orderId = randomUUID();
    const responsePayloadJson = this.buildCreateOrderResponse(
      this.formatOrder({
        id: orderId,
        quoteId: quote.id,
        side: request.side,
        orderType: request.orderType,
        status: OrderStatus.submitted,
        quantity: request.quantity,
        limitPrice:
          request.orderType === OrderType.limit
            ? request.limitPrice
            : null,
        executedPrice: null,
        currencyCode: quote.asset.currencyCode,
        grossAmount,
        feeAmount,
        netAmount,
        assetPriceSnapshotId: quote.assetPriceSnapshotId,
        fxRateSnapshotId: quote.fxRateSnapshotId,
        submittedAt,
        executedAt: null,
        canceledAt: null,
        rejectedAt: null,
        rejectReason: null,
        createdAt: submittedAt,
        updatedAt: submittedAt,
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
          seasonParticipantId: participant.id,
          assetId: quote.asset.id,
          quoteId: quote.id,
          side: request.side,
          orderType: request.orderType,
          status: OrderStatus.submitted,
          quantity: this.formatDecimal(request.quantity, monetaryScale),
          limitPrice:
            request.orderType === OrderType.limit
              ? this.formatNullableDecimal(
                  request.limitPrice,
                  monetaryScale,
                )
              : null,
          executedPrice: null,
          currencyCode: quote.asset.currencyCode,
          grossAmount: this.formatDecimal(grossAmount, monetaryScale),
          feeAmount: this.formatDecimal(feeAmount, monetaryScale),
          netAmount: this.formatDecimal(netAmount, monetaryScale),
          assetPriceSnapshotId: quote.assetPriceSnapshotId,
          fxRateSnapshotId: quote.fxRateSnapshotId,
          idempotencyKey: idempotency.idempotencyKey,
          requestHash: idempotency.requestHash,
          responsePayloadJson,
          submittedAt,
          executedAt: null,
          canceledAt: null,
          rejectedAt: null,
          rejectReason: null,
          createdAt: submittedAt,
          updatedAt: submittedAt,
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
        participant.id,
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
        quoteId: true,
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

  async executeOrder(
    userId: string | undefined,
    orderId: string | undefined,
  ): Promise<ExecuteOrderResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedOrderId = this.parseOrderId(orderId);
    const executedAt = new Date();

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const order = await this.findOwnedOrderForExecution(
          tx,
          parsedOrderId,
          userId,
        );

        if (!order) {
          this.throwApiError(
            HttpStatus.NOT_FOUND,
            'ORDER_NOT_FOUND',
            'Order not found.',
          );
        }

        this.assertExecutableSeasonAndAsset(order);

        if (order.status === OrderStatus.executed) {
          return this.buildAlreadyExecutedOrderResponse(order);
        }

        if (order.status !== OrderStatus.submitted) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'ORDER_NOT_EXECUTABLE',
            'Only submitted orders can be executed.',
          );
        }

        const plan = await this.buildOrderExecutionPlan(tx, order, executedAt);

        return order.side === OrderSide.buy
          ? this.executeBuyOrderInTransaction(tx, order, plan)
          : this.executeSellOrderInTransaction(tx, order, plan);
      });

      if (
        typeof result === 'object' &&
        result !== null &&
        'data' in result &&
        typeof result.data === 'object' &&
        result.data !== null &&
        'execution' in result.data
      ) {
        return result as ExecuteOrderResponse;
      }

      return this.buildExecutedOrderResponse(
        result as OrderExecutionTransactionResult,
      );
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'ORDER_EXECUTION_TRANSACTION_FAILED',
        'Order execution transaction failed.',
      );
    }
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
          quoteId: true,
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

  private async findOwnedOrderForExecution(
    tx: OrderExecuteTransactionClient,
    orderId: string,
    userId: string,
  ): Promise<OrderExecutionRecord | null> {
    const order = await tx.order.findFirst({
      where: {
        id: orderId,
        seasonParticipant: {
          userId,
        },
      },
      select: ORDER_EXECUTION_SELECT,
    });

    return order as OrderExecutionRecord | null;
  }

  private assertExecutableSeasonAndAsset(order: OrderExecutionRecord) {
    if (order.seasonParticipant.season.status !== SeasonStatus.active) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'SEASON_NOT_ACTIVE',
        'Season is not active.',
      );
    }

    if (order.asset.currencyCode !== order.currencyCode) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'ORDER_EXECUTION_TRANSACTION_FAILED',
        'Order asset currency does not match order currency.',
      );
    }
  }

  private async buildOrderExecutionPlan(
    tx: OrderExecuteTransactionClient,
    order: OrderExecutionRecord,
    executedAt: Date,
  ): Promise<OrderExecutionPlan> {
    const quote = await this.assertActiveOrderQuoteForExecution(
      tx,
      order,
      executedAt,
    );
    const priceContext = await this.resolveProviderExecutionPrice(
      tx,
      order,
      quote,
      executedAt,
    );
    const tradeFeeRate = roundDecimalHalfUp(
      order.seasonParticipant.season.tradeFeeRate,
      feeRateScale,
    );
    const grossAmount = roundDecimalHalfUp(
      order.quantity.mul(priceContext.price),
      monetaryScale,
    );
    const feeAmount = roundDecimalHalfUp(
      grossAmount.mul(tradeFeeRate),
      monetaryScale,
    );
    const netAmount =
      order.side === OrderSide.buy
        ? roundDecimalHalfUp(grossAmount.add(feeAmount), monetaryScale)
        : roundDecimalHalfUp(grossAmount.sub(feeAmount), monetaryScale);

    if (netAmount.lt(0)) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'ORDER_EXECUTION_TRANSACTION_FAILED',
        'Trade fee rate makes order net amount negative.',
      );
    }

    const fxSnapshot =
      order.currencyCode === CurrencyCode.USD
        ? await this.findFreshProviderUsdKrwSnapshotForOrderExecution(
            tx,
            quote,
            executedAt,
          )
        : null;

    return {
      executedAt,
      executedPrice: priceContext.price,
      quotedPrice: quote.quotedPrice,
      priceChangeBps: priceContext.priceChangeBps,
      grossAmount,
      feeAmount,
      netAmount,
      assetPriceSnapshotId: priceContext.assetPriceSnapshotId,
      assetPriceSource: priceContext.assetPriceSource,
      fxRateSnapshotId: fxSnapshot?.id ?? null,
      quotedRate: quote.quotedRate,
      executeRate: fxSnapshot?.rate ?? null,
      rateChangeBps: fxSnapshot?.rateChangeBps ?? null,
      fxRateSource: fxSnapshot?.fxRateSource ?? null,
    };
  }

  private async assertActiveOrderQuoteForExecution(
    tx: OrderExecuteTransactionClient,
    order: OrderExecutionRecord,
    executedAt: Date,
  ): Promise<NonNullable<OrderExecutionRecord['quote']> & {
    quotedPrice: Prisma.Decimal;
  }> {
    const quote = order.quote;
    if (!order.quoteId || !quote) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'QUOTE_REQUIRED',
        'quoteId is required for order execution.',
      );
    }

    if (quote.status !== QuoteStatus.active) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_NOT_ACTIVE',
        'Quote is not active.',
      );
    }

    if (executedAt.getTime() > quote.expiresAt.getTime()) {
      await tx.quote.updateMany({
        where: {
          id: quote.id,
          status: QuoteStatus.active,
        },
        data: {
          status: QuoteStatus.expired,
        },
      });
      this.throwApiError(HttpStatus.CONFLICT, 'QUOTE_EXPIRED', 'Quote has expired.');
    }

    const expectedHash = computeOrderQuoteRequestHash({
      userId: quote.userId,
      seasonParticipantId: order.seasonParticipantId,
      assetId: order.assetId,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      limitPrice:
        order.orderType === OrderType.limit ? order.limitPrice : null,
      currencyCode: order.currencyCode,
    });

    if (
      quote.seasonParticipantId !== order.seasonParticipantId ||
      quote.assetId !== order.assetId ||
      quote.side !== order.side ||
      quote.orderType !== order.orderType ||
      !quote.quantity ||
      this.formatDecimal(quote.quantity, monetaryScale) !==
        this.formatDecimal(order.quantity, monetaryScale) ||
      this.formatNullableDecimal(quote.limitPrice, monetaryScale) !==
        this.formatNullableDecimal(order.limitPrice, monetaryScale) ||
      quote.currencyCode !== order.currencyCode ||
      quote.requestHash !== expectedHash ||
      !quote.quotedPrice
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_MISMATCH',
        'Quote does not match the submitted order.',
      );
    }

    return {
      ...quote,
      quotedPrice: quote.quotedPrice,
    };
  }

  private async resolveProviderExecutionPrice(
    tx: OrderExecuteTransactionClient,
    order: OrderExecutionRecord,
    quote: NonNullable<OrderExecutionRecord['quote']> & {
      quotedPrice: Prisma.Decimal;
    },
    executedAt: Date,
  ): Promise<{
    price: Prisma.Decimal;
    assetPriceSnapshotId: string;
    priceChangeBps: Prisma.Decimal | null;
    assetPriceSource: PublicSourceMetadata | null;
  }> {
    const providerEligibility = resolveAssetProviderEligibility({
      workflow: 'orders_execute',
      asset: {
        id: order.assetId,
        assetType: order.asset.assetType,
        market: order.asset.market,
        currencyCode: order.currencyCode,
      },
    });

    if (!providerEligibility.eligible) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'EXECUTION_SOURCE_INELIGIBLE',
        'Order execution source is ineligible.',
      );
    }

    const candidates = await tx.assetPriceSnapshot.findMany({
      where: {
        assetId: order.assetId,
        currencyCode: order.currencyCode,
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
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });
    const selection = selectFreshProviderSnapshot({
      candidates,
      expectedSourceName: providerEligibility.sourceName,
      now: executedAt,
      freshnessThresholdSeconds: providerEligibility.freshnessThresholdSeconds,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
    });

    if (selection.state !== 'selected') {
      if (selection.decision.rejectedProviderReason === 'captured_at_stale') {
        this.throwApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'PROVIDER_PRICE_STALE',
          'Provider asset price is stale.',
        );
      }

      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'PROVIDER_PRICE_UNAVAILABLE',
        'Provider asset price is unavailable.',
      );
    }

    const price = roundDecimalHalfUp(selection.snapshot.price, monetaryScale);
    let priceChangeBps: Prisma.Decimal | null = null;

    if (order.orderType === OrderType.market) {
      priceChangeBps = calculateChangeBps(quote.quotedPrice, price);
      if (priceChangeBps.gt(quote.maxChangeBps)) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'PRICE_CHANGED_REQUOTE_REQUIRED',
          'Order price changed; requote is required.',
        );
      }
    }

    if (order.orderType === OrderType.limit) {
      if (!order.limitPrice) {
        this.throwApiError(
          HttpStatus.INTERNAL_SERVER_ERROR,
          'ORDER_EXECUTION_TRANSACTION_FAILED',
          'Limit order is missing limitPrice.',
        );
      }

      const limitPrice = roundDecimalHalfUp(order.limitPrice, monetaryScale);
      const isMarketable =
        order.side === OrderSide.buy
          ? price.lte(limitPrice)
          : price.gte(limitPrice);

      if (!isMarketable) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'ORDER_LIMIT_NOT_MARKETABLE',
          'Limit order is not marketable at the selected execution price.',
        );
      }
    }

    return {
      price,
      assetPriceSnapshotId: selection.snapshot.id,
      priceChangeBps,
      assetPriceSource: presentSourceDecision(selection.decision),
    };
  }

  private async findFreshProviderUsdKrwSnapshotForOrderExecution(
    tx: OrderExecuteTransactionClient,
    quote: NonNullable<OrderExecutionRecord['quote']>,
    executedAt: Date,
  ): Promise<{
    id: string;
    rate: Prisma.Decimal;
    rateChangeBps: Prisma.Decimal | null;
    fxRateSource: PublicSourceMetadata | null;
  }> {
    const providerEligibility = resolveFxProviderEligibility({
      workflow: 'orders_execute',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    });

    if (!providerEligibility.eligible) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'EXECUTION_SOURCE_INELIGIBLE',
        'FX execution source is ineligible.',
      );
    }

    const candidates = await tx.fxRateSnapshot.findMany({
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
      },
    });
    const selection = selectFreshProviderSnapshot({
      candidates,
      expectedSourceName: providerEligibility.sourceName,
      now: executedAt,
      freshnessThresholdSeconds: providerEligibility.freshnessThresholdSeconds,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
    });

    if (selection.state !== 'selected') {
      if (selection.decision.rejectedProviderReason === 'captured_at_stale') {
        this.throwApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'PROVIDER_RATE_STALE',
          'Provider FX rate is stale.',
        );
      }

      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'PROVIDER_RATE_UNAVAILABLE',
        'Provider FX rate is unavailable.',
      );
    }

    let rateChangeBps: Prisma.Decimal | null = null;
    if (quote.quotedRate) {
      rateChangeBps = calculateChangeBps(
        quote.quotedRate,
        selection.snapshot.rate,
      );
      const maxFxChangeBps = new Prisma.Decimal(
        resolveDefaultMaxChangeBps({
          quoteType: 'fx',
          baseCurrency: CurrencyCode.USD,
          quoteCurrency: CurrencyCode.KRW,
        }),
      );
      if (rateChangeBps.gt(maxFxChangeBps)) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'RATE_CHANGED_REQUOTE_REQUIRED',
          'FX rate changed; requote is required.',
        );
      }
    }

    return {
      id: selection.snapshot.id,
      rate: selection.snapshot.rate,
      rateChangeBps,
      fxRateSource: presentSourceDecision(selection.decision),
    };
  }

  private async executeBuyOrderInTransaction(
    tx: OrderExecuteTransactionClient,
    order: OrderExecutionRecord,
    plan: OrderExecutionPlan,
  ): Promise<OrderExecutionTransactionResult> {
    await this.consumeOrderQuoteInTransaction(tx, order, plan.executedAt);
    const wallet = await this.findCashWalletForExecution(
      tx,
      order.seasonParticipantId,
      order.currencyCode,
    );
    const netAmount = this.formatDecimal(plan.netAmount, monetaryScale);
    const debitResult = await tx.cashWallet.updateMany({
      where: {
        id: wallet.id,
        seasonParticipantId: order.seasonParticipantId,
        currencyCode: order.currencyCode,
        balanceAmount: {
          gte: netAmount,
        },
      },
      data: {
        balanceAmount: {
          decrement: netAmount,
        },
      },
    });

    if (debitResult.count !== 1) {
      await this.throwCashDebitFailure(tx, {
        walletId: wallet.id,
        seasonParticipantId: order.seasonParticipantId,
        currencyCode: order.currencyCode,
        amount: plan.netAmount,
      });
    }

    const postWallet = await this.findCashWalletAfterUpdateOrThrow(tx, {
      walletId: wallet.id,
      seasonParticipantId: order.seasonParticipantId,
      currencyCode: order.currencyCode,
    });
    const positionId = await this.createOrUpdateBuyPosition(tx, order, plan);
    const walletTransaction = await tx.walletTransaction.create({
      data: {
        seasonParticipantId: order.seasonParticipantId,
        walletId: wallet.id,
        currencyCode: order.currencyCode,
        direction: WalletTransactionDirection.debit,
        txType: WalletTransactionType.order_buy,
        referenceType: WalletTransactionReferenceType.order,
        referenceId: order.id,
        amount: netAmount,
        balanceAfter: this.formatDecimal(
          postWallet.balanceAmount,
          monetaryScale,
        ),
        occurredAt: plan.executedAt,
      },
      select: {
        id: true,
      },
    });
    const finalizedOrder = await this.finalizeExecutedOrder(tx, order, plan);

    return {
      order: this.formatOrder(finalizedOrder),
      walletTransactionId: walletTransaction.id,
      walletBalanceAfter: this.formatDecimal(
        postWallet.balanceAmount,
        monetaryScale,
      ),
      positionId,
      plan,
    };
  }

  private async executeSellOrderInTransaction(
    tx: OrderExecuteTransactionClient,
    order: OrderExecutionRecord,
    plan: OrderExecutionPlan,
  ): Promise<OrderExecutionTransactionResult> {
    await this.consumeOrderQuoteInTransaction(tx, order, plan.executedAt);
    const position = await tx.position.findUnique({
      where: {
        seasonParticipantId_assetId: {
          seasonParticipantId: order.seasonParticipantId,
          assetId: order.assetId,
        },
      },
      select: {
        id: true,
        quantity: true,
        averageCost: true,
        currencyCode: true,
      },
    });

    if (!position) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_POSITION_NOT_FOUND',
        'Order position was not found.',
      );
    }

    if (position.currencyCode !== order.currencyCode) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'ORDER_EXECUTION_TRANSACTION_FAILED',
        'Position currency does not match order currency.',
      );
    }

    const costBasis = roundDecimalHalfUp(
      position.averageCost.mul(order.quantity),
      monetaryScale,
    );
    const realizedPnlDelta = roundDecimalHalfUp(
      plan.netAmount.sub(costBasis),
      monetaryScale,
    );
    const positionUpdateResult = await tx.position.updateMany({
      where: {
        id: position.id,
        seasonParticipantId: order.seasonParticipantId,
        assetId: order.assetId,
        quantity: {
          gte: this.formatDecimal(order.quantity, monetaryScale),
        },
      },
      data: {
        quantity: {
          decrement: this.formatDecimal(order.quantity, monetaryScale),
        },
        realizedPnl: this.buildDecimalDeltaUpdate(realizedPnlDelta),
      },
    });

    if (positionUpdateResult.count !== 1) {
      await this.throwPositionDecrementFailure(tx, {
        positionId: position.id,
        seasonParticipantId: order.seasonParticipantId,
        assetId: order.assetId,
        quantity: order.quantity,
      });
    }

    const wallet = await this.findCashWalletForExecution(
      tx,
      order.seasonParticipantId,
      order.currencyCode,
    );
    const netAmount = this.formatDecimal(plan.netAmount, monetaryScale);
    const creditResult = await tx.cashWallet.updateMany({
      where: {
        id: wallet.id,
        seasonParticipantId: order.seasonParticipantId,
        currencyCode: order.currencyCode,
      },
      data: {
        balanceAmount: {
          increment: netAmount,
        },
      },
    });

    if (creditResult.count !== 1) {
      await this.throwCashCreditFailure(tx, {
        walletId: wallet.id,
        seasonParticipantId: order.seasonParticipantId,
        currencyCode: order.currencyCode,
      });
    }

    const postWallet = await this.findCashWalletAfterUpdateOrThrow(tx, {
      walletId: wallet.id,
      seasonParticipantId: order.seasonParticipantId,
      currencyCode: order.currencyCode,
    });
    const walletTransaction = await tx.walletTransaction.create({
      data: {
        seasonParticipantId: order.seasonParticipantId,
        walletId: wallet.id,
        currencyCode: order.currencyCode,
        direction: WalletTransactionDirection.credit,
        txType: WalletTransactionType.order_sell,
        referenceType: WalletTransactionReferenceType.order,
        referenceId: order.id,
        amount: netAmount,
        balanceAfter: this.formatDecimal(
          postWallet.balanceAmount,
          monetaryScale,
        ),
        occurredAt: plan.executedAt,
      },
      select: {
        id: true,
      },
    });
    const finalizedOrder = await this.finalizeExecutedOrder(tx, order, plan);

    return {
      order: this.formatOrder(finalizedOrder),
      walletTransactionId: walletTransaction.id,
      walletBalanceAfter: this.formatDecimal(
        postWallet.balanceAmount,
        monetaryScale,
      ),
      positionId: position.id,
      plan,
    };
  }

  private async consumeOrderQuoteInTransaction(
    tx: OrderExecuteTransactionClient,
    order: OrderExecutionRecord,
    consumedAt: Date,
  ) {
    if (!order.quoteId) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'QUOTE_REQUIRED',
        'quoteId is required for order execution.',
      );
    }

    const result = await tx.quote.updateMany({
      where: {
        id: order.quoteId,
        status: QuoteStatus.active,
      },
      data: {
        status: QuoteStatus.consumed,
        consumedAt,
      },
    });

    if (result.count !== 1) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_NOT_ACTIVE',
        'Quote is not active.',
      );
    }
  }

  private async findCashWalletForExecution(
    tx: OrderExecuteTransactionClient,
    seasonParticipantId: string,
    currencyCode: CurrencyCode,
  ) {
    const wallet = await tx.cashWallet.findUnique({
      where: {
        seasonParticipantId_currencyCode: {
          seasonParticipantId,
          currencyCode,
        },
      },
      select: {
        id: true,
        seasonParticipantId: true,
        currencyCode: true,
        balanceAmount: true,
      },
    });

    if (!wallet) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_CASH_WALLET_NOT_FOUND',
        'Order cash wallet was not found.',
      );
    }

    return wallet;
  }

  private async findCashWalletAfterUpdateOrThrow(
    tx: OrderExecuteTransactionClient,
    input: {
      walletId: string;
      seasonParticipantId: string;
      currencyCode: CurrencyCode;
    },
  ) {
    const wallet = await tx.cashWallet.findFirst({
      where: {
        id: input.walletId,
        seasonParticipantId: input.seasonParticipantId,
        currencyCode: input.currencyCode,
      },
      select: {
        id: true,
        seasonParticipantId: true,
        currencyCode: true,
        balanceAmount: true,
      },
    });

    if (!wallet) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_CASH_WALLET_NOT_FOUND',
        'Order cash wallet was not found.',
      );
    }

    return wallet;
  }

  private async throwCashDebitFailure(
    tx: OrderExecuteTransactionClient,
    input: {
      walletId: string;
      seasonParticipantId: string;
      currencyCode: CurrencyCode;
      amount: Prisma.Decimal;
    },
  ): Promise<never> {
    const wallet = await tx.cashWallet.findFirst({
      where: {
        id: input.walletId,
        seasonParticipantId: input.seasonParticipantId,
        currencyCode: input.currencyCode,
      },
      select: {
        balanceAmount: true,
      },
    });

    if (!wallet) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_CASH_WALLET_NOT_FOUND',
        'Order cash wallet was not found.',
      );
    }

    if (wallet.balanceAmount.lt(input.amount)) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_CASH_BALANCE',
        'Cash wallet balance is insufficient.',
      );
    }

    this.throwApiError(
      HttpStatus.CONFLICT,
      'CONCURRENT_WALLET_UPDATE',
      'Cash wallet was updated concurrently.',
    );
  }

  private async throwCashCreditFailure(
    tx: OrderExecuteTransactionClient,
    input: {
      walletId: string;
      seasonParticipantId: string;
      currencyCode: CurrencyCode;
    },
  ): Promise<never> {
    const wallet = await tx.cashWallet.findFirst({
      where: {
        id: input.walletId,
        seasonParticipantId: input.seasonParticipantId,
        currencyCode: input.currencyCode,
      },
      select: {
        id: true,
      },
    });

    if (!wallet) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_CASH_WALLET_NOT_FOUND',
        'Order cash wallet was not found.',
      );
    }

    this.throwApiError(
      HttpStatus.CONFLICT,
      'CONCURRENT_WALLET_UPDATE',
      'Cash wallet was updated concurrently.',
    );
  }

  private async createOrUpdateBuyPosition(
    tx: OrderExecuteTransactionClient,
    order: OrderExecutionRecord,
    plan: OrderExecutionPlan,
  ): Promise<string> {
    const position = await tx.position.findUnique({
      where: {
        seasonParticipantId_assetId: {
          seasonParticipantId: order.seasonParticipantId,
          assetId: order.assetId,
        },
      },
      select: {
        id: true,
        quantity: true,
        averageCost: true,
        currencyCode: true,
      },
    });

    if (!position) {
      const averageCost = roundDecimalHalfUp(
        plan.netAmount.div(order.quantity),
        monetaryScale,
      );
      const created = await tx.position.create({
        data: {
          seasonParticipantId: order.seasonParticipantId,
          assetId: order.assetId,
          quantity: this.formatDecimal(order.quantity, monetaryScale),
          averageCost: this.formatDecimal(averageCost, monetaryScale),
          currencyCode: order.currencyCode,
          realizedPnl: ZERO_MONEY,
        },
        select: {
          id: true,
        },
      });

      return created.id;
    }

    if (position.currencyCode !== order.currencyCode) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'ORDER_EXECUTION_TRANSACTION_FAILED',
        'Position currency does not match order currency.',
      );
    }

    const newQuantity = roundDecimalHalfUp(
      position.quantity.add(order.quantity),
      monetaryScale,
    );
    const oldCostBasis = position.averageCost.mul(position.quantity);
    const newAverageCost = roundDecimalHalfUp(
      oldCostBasis.add(plan.netAmount).div(newQuantity),
      monetaryScale,
    );
    const updateResult = await tx.position.updateMany({
      where: {
        id: position.id,
        seasonParticipantId: order.seasonParticipantId,
        assetId: order.assetId,
        quantity: this.formatDecimal(position.quantity, monetaryScale),
        averageCost: this.formatDecimal(position.averageCost, monetaryScale),
      },
      data: {
        quantity: this.formatDecimal(newQuantity, monetaryScale),
        averageCost: this.formatDecimal(newAverageCost, monetaryScale),
      },
    });

    if (updateResult.count !== 1) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'CONCURRENT_POSITION_UPDATE',
        'Position was updated concurrently.',
      );
    }

    return position.id;
  }

  private buildDecimalDeltaUpdate(delta: Prisma.Decimal) {
    if (delta.gte(0)) {
      return {
        increment: this.formatDecimal(delta, monetaryScale),
      };
    }

    return {
      decrement: this.formatDecimal(delta.abs(), monetaryScale),
    };
  }

  private async throwPositionDecrementFailure(
    tx: OrderExecuteTransactionClient,
    input: {
      positionId: string;
      seasonParticipantId: string;
      assetId: string;
      quantity: Prisma.Decimal;
    },
  ): Promise<never> {
    const position = await tx.position.findFirst({
      where: {
        id: input.positionId,
        seasonParticipantId: input.seasonParticipantId,
        assetId: input.assetId,
      },
      select: {
        quantity: true,
      },
    });

    if (!position) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_POSITION_NOT_FOUND',
        'Order position was not found.',
      );
    }

    if (position.quantity.lt(input.quantity)) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_POSITION_QUANTITY',
        'Position quantity is insufficient.',
      );
    }

    this.throwApiError(
      HttpStatus.CONFLICT,
      'CONCURRENT_POSITION_UPDATE',
      'Position was updated concurrently.',
    );
  }

  private async finalizeExecutedOrder(
    tx: OrderExecuteTransactionClient,
    order: OrderExecutionRecord,
    plan: OrderExecutionPlan,
  ): Promise<OrderExecutionRecord> {
    const finalizationResult = await tx.order.updateMany({
      where: {
        id: order.id,
        seasonParticipantId: order.seasonParticipantId,
        status: OrderStatus.submitted,
      },
      data: {
        status: OrderStatus.executed,
        executedPrice: this.formatDecimal(plan.executedPrice, monetaryScale),
        grossAmount: this.formatDecimal(plan.grossAmount, monetaryScale),
        feeAmount: this.formatDecimal(plan.feeAmount, monetaryScale),
        netAmount: this.formatDecimal(plan.netAmount, monetaryScale),
        assetPriceSnapshotId: plan.assetPriceSnapshotId,
        fxRateSnapshotId: plan.fxRateSnapshotId,
        executedAt: plan.executedAt,
      },
    });

    if (finalizationResult.count !== 1) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_EXECUTION_CONFLICT',
        'Order execution conflicted with another state change.',
      );
    }

    const finalizedOrder = await tx.order.findUnique({
      where: {
        id: order.id,
      },
      select: ORDER_EXECUTION_SELECT,
    });

    if (!finalizedOrder) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_EXECUTION_CONFLICT',
        'Executed order could not be read back.',
      );
    }

    return finalizedOrder as OrderExecutionRecord;
  }

  private buildExecutedOrderResponse(
    result: OrderExecutionTransactionResult,
  ): ExecuteOrderResponse {
    return {
      success: true,
      data: {
        order: result.order,
        execution: {
          state: 'executed',
          executedAt: result.plan.executedAt.toISOString(),
          priceSource: 'provider_api',
          quoteId: result.order.quoteId,
          quotedPrice: this.formatDecimal(result.plan.quotedPrice, monetaryScale),
          executePrice: this.formatDecimal(
            result.plan.executedPrice,
            monetaryScale,
          ),
          priceChangeBps: result.plan.priceChangeBps
            ? this.formatDecimal(result.plan.priceChangeBps, 4)
            : null,
          quotedRate: result.plan.quotedRate
            ? this.formatDecimal(result.plan.quotedRate, monetaryScale)
            : null,
          executeRate: result.plan.executeRate
            ? this.formatDecimal(result.plan.executeRate, monetaryScale)
            : null,
          rateChangeBps: result.plan.rateChangeBps
            ? this.formatDecimal(result.plan.rateChangeBps, 4)
            : null,
          assetPriceSource: result.plan.assetPriceSource,
          fxRateSource: result.plan.fxRateSource,
          assetPriceSnapshotId: result.plan.assetPriceSnapshotId,
          fxRateSnapshotId: result.plan.fxRateSnapshotId,
          walletTransactionId: result.walletTransactionId,
          walletBalanceAfter: result.walletBalanceAfter,
          positionId: result.positionId,
          duplicate: false,
        },
      },
    };
  }

  private buildAlreadyExecutedOrderResponse(
    order: OrderExecutionRecord,
  ): ExecuteOrderResponse {
    return {
      success: true,
      data: {
        order: this.formatOrder(order),
        execution: {
          state: 'already_executed',
          executedAt: this.formatNullableDate(order.executedAt),
          priceSource: 'provider_api',
          quoteId: order.quoteId,
          quotedPrice: order.quote?.quotedPrice
            ? this.formatDecimal(order.quote.quotedPrice, monetaryScale)
            : null,
          executePrice: this.formatNullableDecimal(
            order.executedPrice,
            monetaryScale,
          ),
          priceChangeBps: null,
          quotedRate: order.quote?.quotedRate
            ? this.formatDecimal(order.quote.quotedRate, monetaryScale)
            : null,
          executeRate: null,
          rateChangeBps: null,
          assetPriceSource: null,
          fxRateSource: null,
          assetPriceSnapshotId: order.assetPriceSnapshotId,
          fxRateSnapshotId: order.fxRateSnapshotId,
          walletTransactionId: null,
          walletBalanceAfter: null,
          positionId: null,
          duplicate: true,
        },
      },
    };
  }

  private async buildOrderQuote(
    userId: string | undefined,
    body: OrderRequestBody,
    quoteAt: Date,
    sourceWorkflow: OrderQuoteSourceWorkflow,
  ): Promise<OrderQuoteCalculation> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const request = this.parseOrderRequest(body);
    return this.buildOrderQuoteFromParsedRequest(
      userId,
      request,
      quoteAt,
      sourceWorkflow,
    );
  }

  private async buildOrderQuoteFromParsedRequest(
    userId: string,
    request: ParsedOrderRequest,
    quoteAt: Date,
    sourceWorkflow: OrderQuoteSourceWorkflow,
  ): Promise<OrderQuoteCalculation> {
    const season = await this.findActiveSeasonOrThrow();
    const participant = await this.findParticipantOrThrow(season.id, userId);

    return this.buildOrderQuoteForContext({
      season,
      participant,
      request,
      quoteAt,
      sourceWorkflow,
    });
  }

  private async buildOrderQuoteForContext(input: {
    season: ActiveOrderSeason;
    participant: OrdersParticipant;
    request: ParsedOrderRequest;
    quoteAt: Date;
    sourceWorkflow: OrderQuoteSourceWorkflow;
  }): Promise<OrderQuoteCalculation> {
    const { season, participant, request, quoteAt, sourceWorkflow } = input;
    const asset = await this.findUsableAsset(request.assetId);
    if (request.currencyCode && request.currencyCode !== asset.currencyCode) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'ASSET_CURRENCY_MISMATCH',
        'currencyCode must match asset currencyCode.',
      );
    }

    const priceContext = await this.resolveOrderPrice(
      request,
      asset,
      quoteAt,
      sourceWorkflow,
    );
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
        ? await this.findFreshUsdKrwSnapshot(quoteAt, sourceWorkflow)
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
      fxRate: fxSnapshot?.rate ?? null,
      assetPriceSource: priceContext.assetPriceSource,
      fxRateSource: fxSnapshot?.fxRateSource ?? null,
      quoteAt,
      quoteId: null,
      expiresAt: null,
      maxChangeBps: null,
      requestHash: null,
    };
  }

  private async createDurableOrderQuote(
    userId: string | undefined,
    quote: OrderQuoteCalculation,
  ): Promise<OrderQuoteCalculation> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const expiresAt = buildQuoteExpiresAt(quote.quoteAt);
    const maxChangeBps = new Prisma.Decimal(
      resolveDefaultMaxChangeBps({
        quoteType: 'order',
        assetType: quote.asset.assetType,
        market: quote.asset.market,
      }),
    );
    const requestHash = computeOrderQuoteRequestHash({
      userId,
      seasonParticipantId: quote.participant.id,
      assetId: quote.asset.id,
      side: quote.request.side,
      orderType: quote.request.orderType,
      quantity: quote.request.quantity,
      limitPrice:
        quote.request.orderType === OrderType.limit
          ? quote.request.limitPrice
          : null,
      currencyCode: quote.asset.currencyCode,
    });
    const durableQuote = await this.prisma.quote.create({
      data: {
        userId,
        seasonParticipantId: quote.participant.id,
        quoteType: QuoteType.order,
        status: QuoteStatus.active,
        assetId: quote.asset.id,
        side: quote.request.side,
        orderType: quote.request.orderType,
        quantity: this.formatDecimal(quote.request.quantity, monetaryScale),
        limitPrice:
          quote.request.orderType === OrderType.limit
            ? this.formatNullableDecimal(
                quote.request.limitPrice,
                monetaryScale,
              )
            : null,
        currencyCode: quote.asset.currencyCode,
        quotedPrice: this.formatDecimal(quote.price, monetaryScale),
        quotedRate: quote.fxRate ? this.formatDecimal(quote.fxRate, 8) : null,
        assetPriceSnapshotId: quote.assetPriceSnapshotId,
        fxRateSnapshotId: quote.fxRateSnapshotId,
        assetPriceSourceJson:
          quote.assetPriceSource as unknown as Prisma.InputJsonValue,
        fxRateSourceJson:
          quote.fxRateSource as unknown as Prisma.InputJsonValue,
        maxChangeBps: maxChangeBps.toFixed(4),
        expiresAt,
        requestHash,
      },
      select: {
        id: true,
      },
    });

    return {
      ...quote,
      quoteId: durableQuote.id,
      expiresAt,
      maxChangeBps,
      requestHash,
    };
  }

  private async findActiveOrderQuoteForCreateOrThrow(input: {
    quoteId: string;
    userId: string;
    seasonParticipantId: string;
    request: ParsedOrderRequest;
    now: Date;
  }): Promise<DurableOrderQuoteForCreate> {
    const quote = await this.prisma.quote.findFirst({
      where: {
        id: input.quoteId,
        userId: input.userId,
        quoteType: QuoteType.order,
      },
      select: {
        id: true,
        seasonParticipantId: true,
        status: true,
        assetId: true,
        side: true,
        orderType: true,
        quantity: true,
        limitPrice: true,
        currencyCode: true,
        quotedPrice: true,
        assetPriceSnapshotId: true,
        fxRateSnapshotId: true,
        expiresAt: true,
        requestHash: true,
        asset: {
          select: {
            id: true,
            symbol: true,
            name: true,
            market: true,
            assetType: true,
            currencyCode: true,
            isActive: true,
          },
        },
      },
    });

    if (!quote) {
      this.throwApiError(HttpStatus.NOT_FOUND, 'QUOTE_NOT_FOUND', 'Quote not found.');
    }

    if (quote.status !== QuoteStatus.active) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_NOT_ACTIVE',
        'Quote is not active.',
      );
    }

    if (input.now.getTime() > quote.expiresAt.getTime()) {
      await this.prisma.quote.updateMany({
        where: {
          id: quote.id,
          status: QuoteStatus.active,
        },
        data: {
          status: QuoteStatus.expired,
        },
      });
      this.throwApiError(HttpStatus.CONFLICT, 'QUOTE_EXPIRED', 'Quote has expired.');
    }

    if (!quote.asset) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_MISMATCH',
        'Quote does not match the order create request.',
      );
    }

    const expectedRequestHash = computeOrderQuoteRequestHash({
      userId: input.userId,
      seasonParticipantId: input.seasonParticipantId,
      assetId: input.request.assetId,
      side: input.request.side,
      orderType: input.request.orderType,
      quantity: input.request.quantity,
      limitPrice:
        input.request.orderType === OrderType.limit
          ? input.request.limitPrice
          : null,
      currencyCode: quote.asset.currencyCode,
    });

    if (
      quote.seasonParticipantId !== input.seasonParticipantId ||
      quote.assetId !== input.request.assetId ||
      quote.side !== input.request.side ||
      quote.orderType !== input.request.orderType ||
      !quote.quantity ||
      this.formatDecimal(quote.quantity, monetaryScale) !==
        this.formatDecimal(input.request.quantity, monetaryScale) ||
      this.formatNullableDecimal(quote.limitPrice, monetaryScale) !==
        (input.request.orderType === OrderType.limit
          ? this.formatNullableDecimal(input.request.limitPrice, monetaryScale)
          : null) ||
      quote.currencyCode !== quote.asset.currencyCode ||
      quote.requestHash !== expectedRequestHash ||
      !quote.quotedPrice ||
      !quote.asset.isActive
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_MISMATCH',
        'Quote does not match the order create request.',
      );
    }

    return {
      ...quote,
      quotedPrice: quote.quotedPrice,
      asset: quote.asset,
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
    return this.parseOrderId(orderId);
  }

  private parseOrderId(orderId: string | undefined): string {
    if (typeof orderId !== 'string' || orderId.trim() === '') {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_ORDER_ID',
        'orderId is required.',
      );
    }

    return orderId.trim();
  }

  private parseQuoteId(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'QUOTE_REQUIRED',
        'quoteId is required.',
      );
    }

    return value.trim();
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
        quoteId: true,
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
        assetType: true,
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
    sourceWorkflow: OrderQuoteSourceWorkflow,
  ): Promise<{
    price: Prisma.Decimal;
    assetPriceSnapshotId: string | null;
    assetPriceSource: PublicSourceMetadata | null;
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
        assetPriceSource: presentLimitPriceSource(),
      };
    }

    const providerEligibility = resolveAssetProviderEligibility({
      workflow: sourceWorkflow,
      asset,
    });
    const providerCandidates = providerEligibility.eligible
      ? ((await this.prisma.assetPriceSnapshot.findMany({
          where: {
            assetId: asset.id,
            currencyCode: asset.currencyCode,
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
            sourceType: true,
            sourceName: true,
            effectiveAt: true,
            capturedAt: true,
          },
        })) ?? [])
      : [];
    const providerSelection = providerEligibility.eligible
      ? selectFreshProviderSnapshot({
          candidates: providerCandidates,
          expectedSourceName: providerEligibility.sourceName,
          now: quoteAt,
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
        price: roundDecimalHalfUp(
          providerSelection.snapshot.price,
          monetaryScale,
        ),
        assetPriceSnapshotId: providerSelection.snapshot.id,
        assetPriceSource: presentSourceDecision(providerSelection.decision),
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
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });

    if (!snapshot) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'ASSET_PRICE_UNAVAILABLE',
        'Asset price is unavailable.',
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
      price: roundDecimalHalfUp(snapshot.price, monetaryScale),
      assetPriceSnapshotId: snapshot.id,
      assetPriceSource: presentSourceDecision(sourceDecision),
    };
  }

  private async findFreshUsdKrwSnapshot(
    quoteAt: Date,
    sourceWorkflow: OrderQuoteSourceWorkflow,
  ): Promise<{
    id: string;
    rate: Prisma.Decimal;
    fxRateSource: PublicSourceMetadata | null;
  }> {
    const providerEligibility = resolveFxProviderEligibility({
      workflow: sourceWorkflow,
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
          },
        })) ?? [])
      : [];
    const providerSelection = providerEligibility.eligible
      ? selectFreshProviderSnapshot({
          candidates: providerCandidates,
          expectedSourceName: providerEligibility.sourceName,
          now: quoteAt,
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
        id: providerSelection.snapshot.id,
        rate: providerSelection.snapshot.rate,
        fxRateSource: presentSourceDecision(providerSelection.decision),
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
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
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

    const sourceDecision = buildAdminManualFallbackDecision({
      selectedSnapshotId: snapshot.id,
      selectedSourceName: snapshot.sourceName,
      selectedEffectiveAt: snapshot.effectiveAt,
      selectedCapturedAt: snapshot.capturedAt,
      providerDecision: providerSelection.decision,
    });

    return {
      id: snapshot.id,
      rate: roundDecimalHalfUp(snapshot.rate, monetaryScale),
      fxRateSource: presentSourceDecision(sourceDecision),
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
      assetPriceSource: quote.assetPriceSource,
      ...(quote.fxRateSource ? { fxRateSource: quote.fxRateSource } : {}),
      quoteId: quote.quoteId,
      expiresAt: quote.expiresAt ? quote.expiresAt.toISOString() : null,
      maxChangeBps: quote.maxChangeBps
        ? quote.maxChangeBps.toFixed(4)
        : null,
      quoteAt: quote.quoteAt.toISOString(),
    };
  }

  private formatOrder(order: {
    id: string;
    quoteId?: string | null;
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
      quoteId: order.quoteId ?? null,
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
