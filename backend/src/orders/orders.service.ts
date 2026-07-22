import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
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
  SnapshotReason,
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
import { isFxSnapshotStaleForPortfolioValuation } from '../portfolio/portfolio-valuation.policy';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildAdminManualFallbackDecision,
  isPositiveDecimal,
  resolveAssetProviderEligibility,
  resolveFxProviderEligibility,
  selectFreshProviderSnapshotBySourcePriority,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
} from '../providers/source-eligibility.policy';
import {
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
import {
  assertSeasonTradable,
  SeasonLifecycleError,
} from '../seasons/season-lifecycle.policy';
import { buildPagination, type Pagination } from '../common/pagination';
import {
  calculateMaxDrawdown,
  RankingRefreshService,
} from '../ranking/ranking-refresh.service';
import { debitAvailableCash } from '../wallets/cash-wallet-atomic';
import { RedisService } from '../redis/redis.service';
import { assertAssetTradable, MarketHoursError } from './market-hours.policy';
import { isLimitOrderEnabled } from './limit-order.config';
import { readLimitOrderMatchingConfig } from './limit-matching/limit-order-matching.config';
import { LimitOrderMatcherHealthService } from './limit-matching/limit-order-matcher-health.service';
import { LimitOrderProviderHealthService } from './limit-matching/limit-order-provider-health.service';
import { limitOrderErrorCodes } from './limit-order-error-policy';
import type { QuotedLimitReservationBasis } from './limit-order-policy';
import {
  LimitOrderCreateService,
  type LimitOrderCreateResponse,
} from './limit-order-create.service';
import {
  LimitOrderCancelService,
  type CancelLimitOrderResponse,
} from './limit-order-cancel.service';
import {
  formatOrderResponse,
  type OrderResponsePayload,
} from './order-response.presenter';

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
  priceCurrency: CurrencyCode;
  settlementCurrency: CurrencyCode;
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
    pagination: Pagination;
    // Shared presenter shape; additive reservation fields (reservedAmount,
    // reservationReleasedAt, cancelReason) are null for market orders.
    orders: OrderResponsePayload[];
    reason?: string;
    message?: string;
  };
};

type OrderDetailResponse = {
  success: true;
  data: {
    order: NonNullable<OrdersResponse['data']['orders']>[number];
    execution: {
      state: OrderStatus;
      priceSource: 'provider_api' | 'admin_manual' | null;
      quoteId: string | null;
      assetPriceSnapshotId: string | null;
      fxRateSnapshotId: string | null;
    };
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
  /**
   * Limit-buy only: the reservation basis pinned at quote time and persisted
   * on the durable quote. Absent on market quotes, which reprice at execute.
   */
  limitReservationBasis?: QuotedLimitReservationBasis;
  assetPriceSnapshotId: string | null;
  fxRateSnapshotId: string | null;
  fxRate: Prisma.Decimal | null;
  assetPriceSource: PublicSourceMetadata | null;
  fxRateSource: PublicSourceMetadata | null;
  walletBalanceBefore: Prisma.Decimal;
  estimatedWalletBalanceAfter: Prisma.Decimal;
  positionQuantityBefore: Prisma.Decimal;
  estimatedPositionQuantityAfter: Prisma.Decimal;
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
  /** Limit-buy reservation basis pinned at quote time (null on market quotes). */
  quotedFeeRate: Prisma.Decimal | null;
  quotedGrossAmount: Prisma.Decimal | null;
  quotedFeeAmount: Prisma.Decimal | null;
  quotedReservedAmount: Prisma.Decimal | null;
  assetPriceSnapshotId: string | null;
  fxRateSnapshotId: string | null;
  expiresAt: Date;
  requestHash: string;
  asset: OrderAsset;
};

type OrderQuoteResponse = {
  success: true;
  // Additive limit-buy fields are present only on limit quotes.
  data: ReturnType<OrdersService['formatOrderQuoteData']> & {
    limitPrice?: string;
    /**
     * Reservation basis pinned on the durable quote. create reserves exactly
     * quotedReservedAmount at quotedFeeRate regardless of any later
     * Season.tradeFeeRate change. reservedAmount is the pre-existing alias of
     * quotedReservedAmount and is kept for current clients.
     */
    quotedFeeRate?: string;
    quotedGrossAmount?: string;
    quotedFeeAmount?: string;
    quotedReservedAmount?: string;
    reservedAmount?: string;
    walletReservedBefore?: string;
    walletAvailableBefore?: string;
    estimatedReservedAfter?: string;
    estimatedAvailableAfter?: string;
    executionPolicy?: {
      autoExecutionEnabled: boolean;
      mode: 'live_trade_event' | 'reservation_only';
      triggerType: 'provider_trade_price' | null;
      fullFillOnly: true;
    };
  };
};

type CreateOrderResponse = {
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
      equitySnapshotId?: string | null;
      duplicate: boolean;
    };
  };
};

// Cancel responses are built by LimitOrderCancelService
// (CancelLimitOrderResponse); market orders still reject with
// ORDER_CANCEL_NOT_SUPPORTED before any response is built.

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
      equitySnapshotId: string | null;
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
    priceCurrency: CurrencyCode;
    settlementCurrency: CurrencyCode;
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
  seasonId: string;
  seasonParticipantId: string;
  order: NonNullable<OrdersResponse['data']['orders']>[number];
  walletTransactionId: string;
  walletBalanceAfter: string;
  positionId: string | null;
  equitySnapshotId: string | null;
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
const quantityScale = 6;
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
  reservedAmount: true,
  reservationReleasedAt: true,
  cancelReason: true,
  triggerEventId: true,
  triggerEventAt: true,
  matchedAt: true,
  matchingSource: true,
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
      priceCurrency: true,
      settlementCurrency: true,
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
  private readonly limitOrderMatchingConfig = readLimitOrderMatchingConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rankingRefreshService?: RankingRefreshService,
    private readonly limitOrderCreateService?: LimitOrderCreateService,
    private readonly limitOrderCancelService?: LimitOrderCancelService,
    @Optional()
    private readonly limitOrderMatcherHealth?: LimitOrderMatcherHealthService,
    @Optional()
    private readonly redis?: RedisService,
    @Optional()
    private readonly limitOrderProviderHealth?: LimitOrderProviderHealthService,
  ) {}

  private assertLimitOrderFeatureEnabled(): void {
    if (!isLimitOrderEnabled()) {
      this.throwApiError(
        HttpStatus.FORBIDDEN,
        limitOrderErrorCodes.LIMIT_ORDER_DISABLED,
        'Limit orders are not enabled.',
      );
    }
  }

  private requireLimitOrderCreateService(): LimitOrderCreateService {
    if (!this.limitOrderCreateService) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'LIMIT_ORDER_SERVICE_UNAVAILABLE',
        'Limit order create service is not wired.',
      );
    }
    return this.limitOrderCreateService;
  }

  private requireLimitOrderCancelService(): LimitOrderCancelService {
    if (!this.limitOrderCancelService) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'LIMIT_ORDER_SERVICE_UNAVAILABLE',
        'Limit order cancel service is not wired.',
      );
    }
    return this.limitOrderCancelService;
  }

  private isLimitOrderAutoExecutionEnabled(): boolean {
    return this.limitOrderMatchingConfig.enabled;
  }

  private async assertLimitOrderMatcherAvailable(
    tx?: Prisma.TransactionClient,
    now?: Date,
  ): Promise<void> {
    if (!this.isLimitOrderAutoExecutionEnabled()) return;
    if (!this.limitOrderMatcherHealth) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'LIMIT_ORDER_MATCHER_UNAVAILABLE',
        'Limit-order matcher health service is not wired.',
      );
    }
    await this.limitOrderMatcherHealth.assertAvailable(tx, now);
  }

  private assertLimitOrderProviderAvailable(assetType: AssetType): void {
    if (!this.isLimitOrderAutoExecutionEnabled()) return;
    if (!this.limitOrderProviderHealth) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'LIMIT_ORDER_MATCHER_UNAVAILABLE',
        'Limit-order provider health service is not wired.',
      );
    }
    this.limitOrderProviderHealth.assertAvailable(assetType);
  }

  async quoteOrder(
    userId: string | undefined,
    body: OrderRequestBody = {},
  ): Promise<OrderQuoteResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const quoteAt = new Date();
    const request = this.parseOrderRequest(body);

    if (request.orderType === OrderType.limit) {
      return this.quoteLimitBuyOrder(userId, request, quoteAt);
    }

    const quote = await this.buildOrderQuoteFromParsedRequest(
      userId,
      request,
      quoteAt,
      'orders_quote',
    );
    const durableQuote = await this.createDurableOrderQuote(userId, quote);

    return {
      success: true,
      data: this.formatOrderQuoteData(durableQuote),
    };
  }

  /**
   * Limit-buy quote: reservation preview from limitPrice × quantity only.
   * No provider asset price is resolved; the USD/KRW snapshot (USD assets)
   * feeds the KRW display conversion exactly like market quotes. Read-only:
   * the wallet is never mutated at quote time.
   */
  private async quoteLimitBuyOrder(
    userId: string,
    request: ParsedOrderRequest,
    quoteAt: Date,
  ): Promise<OrderQuoteResponse> {
    this.assertLimitOrderFeatureEnabled();
    await this.assertLimitOrderMatcherAvailable();
    const limitOrderCreate = this.requireLimitOrderCreateService();
    if (!request.limitPrice) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        limitOrderErrorCodes.INVALID_LIMIT_PRICE,
        'limitPrice is required for limit orders.',
      );
    }

    const season = await this.findActiveSeasonOrThrow();
    this.assertSeasonTradable(season, quoteAt);
    const participant = await this.findParticipantOrThrow(season.id, userId);
    const asset = await this.findUsableAsset(request.assetId);
    this.assertLimitOrderProviderAvailable(asset.assetType);
    if (
      request.currencyCode &&
      request.currencyCode !== this.getAssetSettlementCurrency(asset)
    ) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'ASSET_CURRENCY_MISMATCH',
        'currencyCode must match asset settlementCurrency.',
      );
    }
    if (
      this.getAssetPriceCurrency(asset) !==
      this.getAssetSettlementCurrency(asset)
    ) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'ORDER_PRICE_SETTLEMENT_CURRENCY_NOT_SUPPORTED',
        'Separate price and settlement currencies are not supported for order execution yet.',
      );
    }
    // Same session policy as market orders: stocks only while the market is
    // open (calendar fail-closed), crypto 24h.
    this.assertOrderAssetTradable(asset, quoteAt);

    const settlementCurrency = this.getAssetSettlementCurrency(asset);
    const preview = await limitOrderCreate.buildLimitBuyQuotePreview({
      participantId: participant.id,
      assetId: asset.id,
      currencyCode: settlementCurrency,
      limitPrice: request.limitPrice,
      quantity: request.quantity,
      tradeFeeRate: season.tradeFeeRate,
    });

    const fxSnapshot =
      settlementCurrency === CurrencyCode.USD
        ? await this.findFreshUsdKrwSnapshot(quoteAt, 'orders_quote')
        : null;
    const krwAmounts = this.calculateKrwAmounts(
      {
        grossAmount: preview.grossAmount,
        feeAmount: preview.feeAmount,
        netAmount: preview.reservedAmount,
      },
      settlementCurrency,
      fxSnapshot?.rate ?? null,
    );

    const calculation: OrderQuoteCalculation = {
      season,
      participant,
      asset,
      request,
      price: request.limitPrice,
      grossAmount: preview.grossAmount,
      feeAmount: preview.feeAmount,
      netAmount: preview.reservedAmount,
      // Pinned on the durable quote: create reserves exactly this basis even
      // if Season.tradeFeeRate changes in between.
      limitReservationBasis: {
        quotedFeeRate: preview.quotedFeeRate,
        quotedGrossAmount: preview.grossAmount,
        quotedFeeAmount: preview.feeAmount,
        quotedReservedAmount: preview.reservedAmount,
      },
      krwGrossAmount: krwAmounts.krwGrossAmount,
      krwFeeAmount: krwAmounts.krwFeeAmount,
      krwNetAmount: krwAmounts.krwNetAmount,
      assetPriceSnapshotId: null,
      fxRateSnapshotId: fxSnapshot?.id ?? null,
      fxRate: fxSnapshot?.rate ?? null,
      assetPriceSource: null,
      fxRateSource: fxSnapshot?.fxRateSource ?? null,
      walletBalanceBefore: preview.walletBalanceBefore,
      // As-if-filled estimates (same meaning as market quotes). The
      // REGISTRATION itself changes neither balance nor position — those
      // effects are exposed via the additive reserved/available fields.
      estimatedWalletBalanceAfter: preview.walletBalanceBefore.sub(
        preview.reservedAmount,
      ),
      positionQuantityBefore: preview.positionQuantityBefore,
      estimatedPositionQuantityAfter: preview.estimatedPositionQuantityAfter,
      quoteAt,
      quoteId: null,
      expiresAt: null,
      maxChangeBps: null,
      requestHash: null,
    };

    const durableQuote = await this.createDurableOrderQuote(
      userId,
      calculation,
    );
    // Every reservation figure below comes from the durable quote row, which
    // is exactly what create will reserve — never a re-read of the season fee
    // rate. quoted* names state that explicitly; reservedAmount is kept as the
    // pre-existing field name for current clients.
    const basis = durableQuote.limitReservationBasis;
    if (!basis) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        limitOrderErrorCodes.QUOTE_RESERVATION_BASIS_INVALID,
        'Limit quote was stored without its reservation basis.',
      );
    }

    return {
      success: true,
      data: {
        ...this.formatOrderQuoteData(durableQuote),
        limitPrice: this.formatDecimal(request.limitPrice, monetaryScale),
        quotedFeeRate: formatDecimalScale(basis.quotedFeeRate, feeRateScale),
        quotedGrossAmount: this.formatDecimal(
          basis.quotedGrossAmount,
          monetaryScale,
        ),
        quotedFeeAmount: this.formatDecimal(
          basis.quotedFeeAmount,
          monetaryScale,
        ),
        quotedReservedAmount: this.formatDecimal(
          basis.quotedReservedAmount,
          monetaryScale,
        ),
        reservedAmount: this.formatDecimal(
          basis.quotedReservedAmount,
          monetaryScale,
        ),
        walletReservedBefore: this.formatDecimal(
          preview.walletReservedBefore,
          monetaryScale,
        ),
        walletAvailableBefore: this.formatDecimal(
          preview.walletAvailableBefore,
          monetaryScale,
        ),
        estimatedReservedAfter: this.formatDecimal(
          preview.estimatedReservedAfter,
          monetaryScale,
        ),
        estimatedAvailableAfter: this.formatDecimal(
          preview.estimatedAvailableAfter,
          monetaryScale,
        ),
        executionPolicy: this.limitOrderExecutionPolicy(),
      },
    };
  }

  async createOrder(
    userId: string | undefined,
    body: OrderRequestBody = {},
  ): Promise<CreateOrderResponse | LimitOrderCreateResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const request = this.parseOrderRequest(body);

    if (request.orderType === OrderType.limit) {
      return this.createLimitBuyOrder(userId, body, request);
    }

    const quoteId = this.parseQuoteId(body.quoteId);
    const idempotency = this.buildOrderCreateIdempotency({
      body,
      request,
      quoteId,
    });
    const submittedAt = new Date();
    const season = await this.findActiveSeasonOrThrow();
    this.assertSeasonTradable(season, submittedAt);
    const participant = await this.findParticipantOrThrow(season.id, userId);
    const existingOrder = await this.findIdempotentCreateOrder(
      participant.id,
      idempotency.idempotencyKey,
    );

    if (existingOrder) {
      return this.replayIdempotentCreateOrder(existingOrder, idempotency);
    }

    try {
      const response = await this.prisma.$transaction(async (tx) => {
        const quote = await this.findActiveOrderQuoteForCreateOrThrow(tx, {
          quoteId,
          userId,
          seasonParticipantId: participant.id,
          request,
          now: submittedAt,
        });
        this.assertOrderAssetTradable(quote.asset, submittedAt);

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
        const orderId = randomUUID();

        await tx.order.create({
          data: {
            id: orderId,
            seasonParticipantId: participant.id,
            assetId: quote.asset.id,
            quoteId: quote.id,
            side: request.side,
            orderType: OrderType.market,
            status: OrderStatus.submitted,
            quantity: this.formatDecimal(request.quantity, quantityScale),
            limitPrice: null,
            executedPrice: null,
            currencyCode: this.getAssetSettlementCurrency(quote.asset),
            grossAmount: this.formatDecimal(grossAmount, monetaryScale),
            feeAmount: this.formatDecimal(feeAmount, monetaryScale),
            netAmount: this.formatDecimal(netAmount, monetaryScale),
            assetPriceSnapshotId: quote.assetPriceSnapshotId,
            fxRateSnapshotId: quote.fxRateSnapshotId,
            idempotencyKey: idempotency.idempotencyKey,
            requestHash: idempotency.requestHash,
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

        const order = await tx.order.findUnique({
          where: {
            id: orderId,
          },
          select: ORDER_EXECUTION_SELECT,
        });

        if (!order) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'ORDER_EXECUTION_CONFLICT',
            'Created order could not be read back.',
          );
        }

        const executionOrder = order as OrderExecutionRecord;
        this.assertExecutableSeasonAndAsset(executionOrder, submittedAt);
        const plan = await this.buildOrderExecutionPlan(
          tx,
          executionOrder,
          submittedAt,
        );
        const result =
          executionOrder.side === OrderSide.buy
            ? await this.executeBuyOrderInTransaction(tx, executionOrder, plan)
            : await this.executeSellOrderInTransaction(
                tx,
                executionOrder,
                plan,
              );
        const responsePayloadJson = this.buildExecutedOrderResponse(result);

        await tx.order.update({
          where: {
            id: result.order.orderId,
          },
          data: {
            responsePayloadJson:
              responsePayloadJson as unknown as Prisma.InputJsonValue,
          },
          select: {
            id: true,
          },
        });

        return responsePayloadJson;
      });

      this.refreshRankingAfterParticipantChange(season.id, participant.id);

      return response;
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

  /**
   * Creates a SUBMITTED limit-buy order with an atomic cash reservation.
   * This request never executes or reads a provider price and never touches
   * balanceAmount / WalletTransaction / Position. Only a later path A stream
   * event can fill the committed submitted order.
   */
  private async createLimitBuyOrder(
    userId: string,
    body: OrderRequestBody,
    request: ParsedOrderRequest,
  ): Promise<CreateOrderResponse | LimitOrderCreateResponse> {
    this.assertLimitOrderFeatureEnabled();
    const limitOrderCreate = this.requireLimitOrderCreateService();
    const quoteId = this.parseQuoteId(body.quoteId);
    const idempotency = this.buildOrderCreateIdempotency({
      body,
      request,
      quoteId,
    });
    const autoExecutionEnabled = this.isLimitOrderAutoExecutionEnabled();
    const submittedAt = new Date();
    // Pre-transaction checks are a fast-fail courtesy only: they give the user
    // a clean error without opening a transaction. They are NOT the basis of
    // financial correctness — every one of them is re-run against locked rows
    // inside the transaction below, because an operator can exclude the
    // participant or end the season in the gap.
    const season = await this.findActiveSeasonOrThrow();
    this.assertSeasonTradable(season, submittedAt);
    const participant = await this.findParticipantOrThrow(season.id, userId);
    const existingOrder = await this.findIdempotentCreateOrder(
      participant.id,
      idempotency.idempotencyKey,
    );

    if (existingOrder) {
      return this.replayIdempotentCreateOrder(existingOrder, idempotency);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Lock order: Quote → SeasonParticipant → Season → CashWallet → Order.
        // See LimitOrderCreateService.lockTradableContextInTransaction for why
        // the participant precedes the season and why both are FOR SHARE.
        await limitOrderCreate.lockQuoteForCreateInTransaction(tx, quoteId);
        // Re-validate season + participant against LOCKED rows. A concurrent
        // exclusion or season-ending either commits first (and this create
        // fails) or waits behind these locks (and its cleanup then cancels the
        // order this transaction is about to commit). No third outcome exists,
        // so no reservation can outlive an exclusion or a season end.
        const lockedContext =
          await limitOrderCreate.lockTradableContextInTransaction(tx, {
            userId,
            seasonParticipantId: participant.id,
          });

        let activationStreamId: string | null = null;
        if (autoExecutionEnabled) {
          if (!this.redis) {
            this.throwApiError(
              HttpStatus.SERVICE_UNAVAILABLE,
              'LIMIT_ORDER_EVENT_STREAM_UNAVAILABLE',
              'Limit-order event stream service is not wired.',
            );
          }
          try {
            activationStreamId = await this.redis.lastStreamId(
              this.limitOrderMatchingConfig.streamKey,
            );
          } catch {
            this.throwApiError(
              HttpStatus.SERVICE_UNAVAILABLE,
              'LIMIT_ORDER_EVENT_STREAM_UNAVAILABLE',
              'Limit-order event stream is unavailable.',
            );
          }
        }

        // PostgreSQL CURRENT_TIMESTAMP/now() are fixed at transaction start.
        // The wall clock is read only after every authorization row lock and
        // the optional Redis activation-cursor read, so neither lock nor
        // network wait time is omitted from final quote/season/market checks.
        const transactionClock = await tx.$queryRaw<Array<{ now: Date }>>`
          SELECT clock_timestamp() AS "now"
        `;
        const transactionNow = transactionClock[0]?.now;
        if (!transactionNow) {
          this.throwApiError(
            HttpStatus.INTERNAL_SERVER_ERROR,
            'ORDER_EXECUTION_TRANSACTION_FAILED',
            'Database transaction clock is unavailable.',
          );
        }
        limitOrderCreate.assertLockedTradableContext(
          lockedContext,
          transactionNow,
        );
        await this.assertLimitOrderMatcherAvailable(tx, transactionNow);

        const quote = await this.findActiveOrderQuoteForCreateOrThrow(tx, {
          quoteId,
          userId,
          seasonParticipantId: participant.id,
          request,
          now: transactionNow,
        });
        this.assertOrderAssetTradable(quote.asset, transactionNow);
        this.assertLimitOrderProviderAvailable(quote.asset.assetType);

        if (!quote.limitPrice) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'QUOTE_MISMATCH',
            'Quote does not match the order create request.',
          );
        }

        const matchingActivation = activationStreamId
          ? { activatedAt: transactionNow, streamId: activationStreamId }
          : null;

        return limitOrderCreate.createSubmittedLimitBuyInTransaction(tx, {
          quote: {
            id: quote.id,
            limitPrice: quote.limitPrice,
            quotedFeeRate: quote.quotedFeeRate,
            quotedGrossAmount: quote.quotedGrossAmount,
            quotedFeeAmount: quote.quotedFeeAmount,
            quotedReservedAmount: quote.quotedReservedAmount,
            asset: {
              id: quote.asset.id,
              settlementCurrency: quote.asset.settlementCurrency,
              currencyCode: quote.asset.currencyCode,
            },
          },
          participant: { id: participant.id },
          quantity: request.quantity,
          idempotency,
          submittedAt: transactionNow,
          matchingActivation,
          autoExecutionEnabled,
        });
      });
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
  ): Promise<CancelLimitOrderResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedOrderId = this.parseOrderId(orderId);
    // Limit buy orders are cancelable; market orders keep the historical
    // ORDER_CANCEL_NOT_SUPPORTED (410) inside the cancel service. Cancel is
    // intentionally NOT gated by LIMIT_ORDER_ENABLED so existing
    // reservations can always be released.
    return this.requireLimitOrderCancelService().cancelOwnedLimitBuyOrder({
      userId,
      orderId: parsedOrderId,
      canceledAt: new Date(),
    });
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

        this.assertExecutableSeasonAndAsset(order, executedAt);

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
        return result;
      }

      const executionResult = result as OrderExecutionTransactionResult;
      this.refreshRankingAfterParticipantChange(
        executionResult.seasonId,
        executionResult.seasonParticipantId,
      );

      return this.buildExecutedOrderResponse(executionResult);
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
          reservedAmount: true,
          reservationReleasedAt: true,
          cancelReason: true,
          triggerEventId: true,
          triggerEventAt: true,
          matchedAt: true,
          matchingSource: true,
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

  async getOrder(
    userId: string | undefined,
    orderId: string | undefined,
  ): Promise<OrderDetailResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedOrderId = this.parseOrderId(orderId);
    const order = await this.prisma.order.findFirst({
      where: {
        id: parsedOrderId,
        seasonParticipant: {
          userId,
        },
      },
      select: {
        ...ORDER_EXECUTION_SELECT,
        assetPriceSnapshot: {
          select: {
            sourceType: true,
          },
        },
      },
    });

    if (!order) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'ORDER_NOT_FOUND',
        'Order not found.',
      );
    }

    const priceSource =
      order.assetPriceSnapshot?.sourceType ===
        AssetPriceSourceType.provider_api ||
      order.assetPriceSnapshot?.sourceType === AssetPriceSourceType.admin_manual
        ? order.assetPriceSnapshot.sourceType
        : null;

    return {
      success: true,
      data: {
        order: this.formatOrder(order),
        execution: {
          state: order.status,
          priceSource,
          quoteId: order.quoteId,
          assetPriceSnapshotId: order.assetPriceSnapshotId,
          fxRateSnapshotId: order.fxRateSnapshotId,
        },
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

  private assertExecutableSeasonAndAsset(
    order: OrderExecutionRecord,
    executedAt: Date,
  ) {
    this.assertSeasonTradable(order.seasonParticipant.season, executedAt);
    this.assertParticipantTradable(order.seasonParticipant.participantStatus);
    this.assertOrderAssetTradable(order.asset, executedAt);

    if (order.orderType !== OrderType.market) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'LIMIT_ORDER_EXECUTION_PATH_NOT_SUPPORTED',
        'Limit orders can only execute from the live-trade matcher.',
      );
    }

    if (this.getAssetSettlementCurrency(order.asset) !== order.currencyCode) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'ORDER_EXECUTION_TRANSACTION_FAILED',
        'Order settlement currency does not match order currency.',
      );
    }

    if (this.getAssetPriceCurrency(order.asset) !== order.currencyCode) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'ORDER_PRICE_SETTLEMENT_CURRENCY_NOT_SUPPORTED',
        'Separate price and settlement currencies are not supported for order execution yet.',
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
  ): Promise<
    NonNullable<OrderExecutionRecord['quote']> & {
      quotedPrice: Prisma.Decimal;
    }
  > {
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
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_EXPIRED',
        'Quote has expired.',
      );
    }

    const expectedHash = computeOrderQuoteRequestHash({
      userId: quote.userId,
      seasonParticipantId: order.seasonParticipantId,
      assetId: order.assetId,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      limitPrice: order.orderType === OrderType.limit ? order.limitPrice : null,
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
        currencyCode: this.getAssetPriceCurrency(order.asset),
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
        currencyCode: this.getAssetPriceCurrency(order.asset),
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
    const selection = selectMarketAwareAssetPriceSnapshotBySourcePriority({
      asset: order.asset,
      workflow: 'orders_execute',
      candidates,
      expectedSourceNames: providerEligibility.sourceNames,
      now: executedAt,
      freshnessThresholdSeconds: providerEligibility.freshnessThresholdSeconds,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
    });

    if (selection.state !== 'selected') {
      if (
        selection.decision.rejectedProviderReason === 'captured_at_stale' ||
        selection.decision.rejectedProviderReason ===
          'effective_at_outside_current_session'
      ) {
        this.throwApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'PRICE_STALE',
          'Provider asset price is stale.',
        );
      }

      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'ASSET_PRICE_UNAVAILABLE',
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
          'RATE_CHANGED_REQUOTE_REQUIRED',
          'Order price changed; requote is required.',
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
    const selection = selectFreshProviderSnapshotBySourcePriority({
      candidates,
      expectedSourceNames: providerEligibility.sourceNames,
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
    // Atomic available-balance debit: cash reserved by submitted limit-buy
    // orders is never spendable by a market buy, even under concurrency.
    const debitCount = await debitAvailableCash(tx, {
      walletId: wallet.id,
      seasonParticipantId: order.seasonParticipantId,
      currencyCode: order.currencyCode,
      amount: netAmount,
    });

    if (debitCount !== 1) {
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
    const equitySnapshotId = await this.recordOrderExecutedPortfolioSnapshot(
      tx,
      order.seasonParticipantId,
      plan.executedAt,
    );

    return {
      seasonId: order.seasonParticipant.season.id,
      seasonParticipantId: order.seasonParticipantId,
      order: this.formatOrder(finalizedOrder),
      walletTransactionId: walletTransaction.id,
      walletBalanceAfter: this.formatDecimal(
        postWallet.balanceAmount,
        monetaryScale,
      ),
      positionId,
      equitySnapshotId,
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
        'INSUFFICIENT_QUANTITY',
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
    const realizedPnlKrwDelta = this.calculateRealizedPnlKrwDeltaForExecution(
      realizedPnlDelta,
      order.currencyCode,
      plan,
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
        realizedPnlKrw: this.buildDecimalDeltaUpdate(realizedPnlKrwDelta),
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
    const equitySnapshotId = await this.recordOrderExecutedPortfolioSnapshot(
      tx,
      order.seasonParticipantId,
      plan.executedAt,
    );

    return {
      seasonId: order.seasonParticipant.season.id,
      seasonParticipantId: order.seasonParticipantId,
      order: this.formatOrder(finalizedOrder),
      walletTransactionId: walletTransaction.id,
      walletBalanceAfter: this.formatDecimal(
        postWallet.balanceAmount,
        monetaryScale,
      ),
      positionId: position.id,
      equitySnapshotId,
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
        'INSUFFICIENT_BALANCE',
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
        'INSUFFICIENT_BALANCE',
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
        reservedAmount: true,
      },
    });

    if (!wallet) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_BALANCE',
        'Order cash wallet was not found.',
      );
    }

    if (
      wallet.balanceAmount
        .sub(wallet.reservedAmount ?? new Prisma.Decimal(0))
        .lt(input.amount)
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_BALANCE',
        'Cash wallet balance is insufficient.',
      );
    }

    this.throwApiError(
      HttpStatus.CONFLICT,
      'CONFLICT',
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
        'INSUFFICIENT_BALANCE',
        'Order cash wallet was not found.',
      );
    }

    this.throwApiError(
      HttpStatus.CONFLICT,
      'CONFLICT',
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
          realizedPnlKrw: ZERO_MONEY,
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
        'CONFLICT',
        'Position was updated concurrently.',
      );
    }

    return position.id;
  }

  private async recordOrderExecutedPortfolioSnapshot(
    tx: OrderExecuteTransactionClient,
    seasonParticipantId: string,
    capturedAt: Date,
  ): Promise<string | null> {
    let valuation: Awaited<
      ReturnType<OrdersService['calculateParticipantValuationInTransaction']>
    >;
    try {
      valuation = await this.calculateParticipantValuationInTransaction(
        tx,
        seasonParticipantId,
        capturedAt,
      );
    } catch (error) {
      if (
        error instanceof HttpException &&
        this.getHttpErrorCode(error) === 'SEASON_PARTICIPANT_NOT_FOUND'
      ) {
        return null;
      }

      throw error;
    }

    const snapshot = await tx.equitySnapshot.create({
      data: {
        seasonParticipantId,
        totalAssetKrw: valuation.totalAssetKrw,
        returnRate: valuation.returnRate,
        krwCash: valuation.krwCash,
        usdCashKrw: valuation.usdCashKrw,
        domesticStockValueKrw: valuation.domesticStockValueKrw,
        usStockValueKrw: valuation.usStockValueKrw,
        cryptoValueKrw: valuation.cryptoValueKrw,
        snapshotReason: SnapshotReason.order_executed,
        capturedAt,
      },
      select: {
        id: true,
      },
    });
    const maxDrawdown =
      await this.calculateParticipantMaxDrawdownFromEquitySnapshots(
        tx,
        seasonParticipantId,
      );

    await tx.seasonParticipant.update({
      where: {
        id: seasonParticipantId,
      },
      data: {
        totalAssetKrw: valuation.totalAssetKrw,
        totalReturnRate: valuation.returnRate,
        maxDrawdown,
        totalFillCount: {
          increment: 1,
        },
      },
      select: {
        id: true,
      },
    });

    return snapshot.id;
  }

  private async calculateParticipantMaxDrawdownFromEquitySnapshots(
    tx: OrderExecuteTransactionClient,
    seasonParticipantId: string,
  ) {
    const snapshots = await tx.equitySnapshot.findMany({
      where: {
        seasonParticipantId,
      },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        totalAssetKrw: true,
        capturedAt: true,
      },
    });

    return this.formatDecimal(calculateMaxDrawdown(snapshots), 8);
  }

  private async calculateParticipantValuationInTransaction(
    tx: OrderExecuteTransactionClient,
    seasonParticipantId: string,
    valuationAt: Date,
  ): Promise<{
    totalAssetKrw: string;
    returnRate: string;
    krwCash: string;
    usdCashKrw: string;
    domesticStockValueKrw: string;
    usStockValueKrw: string;
    cryptoValueKrw: string;
  }> {
    const participant = await tx.seasonParticipant.findUnique({
      where: {
        id: seasonParticipantId,
      },
      select: {
        initialCapitalKrw: true,
        cashWallets: {
          select: {
            currencyCode: true,
            balanceAmount: true,
          },
        },
        positions: {
          where: {
            quantity: {
              gt: ZERO_MONEY,
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
                id: true,
                assetType: true,
                market: true,
                currencyCode: true,
                priceCurrency: true,
                settlementCurrency: true,
              },
            },
          },
        },
      },
    });

    if (!participant) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'SEASON_PARTICIPANT_NOT_FOUND',
        'Season participant not found.',
      );
    }

    const usdKrwRate =
      participant.cashWallets.some(
        (wallet) =>
          wallet.currencyCode === CurrencyCode.USD &&
          !wallet.balanceAmount.eq(0),
      ) ||
      participant.positions.some(
        (position) => position.currencyCode === CurrencyCode.USD,
      )
        ? await this.findLatestUsdKrwRateForPortfolio(tx, valuationAt)
        : null;
    const krwCash = participant.cashWallets
      .filter((wallet) => wallet.currencyCode === CurrencyCode.KRW)
      .reduce(
        (sum, wallet) => sum.add(wallet.balanceAmount),
        new Prisma.Decimal(0),
      );
    const usdCash = participant.cashWallets
      .filter((wallet) => wallet.currencyCode === CurrencyCode.USD)
      .reduce(
        (sum, wallet) => sum.add(wallet.balanceAmount),
        new Prisma.Decimal(0),
      );
    const usdCashKrw = usdCash.eq(0)
      ? new Prisma.Decimal(0)
      : this.convertToKrwForPortfolio(usdCash, CurrencyCode.USD, usdKrwRate);
    let domesticStockValueKrw = new Prisma.Decimal(0);
    let usStockValueKrw = new Prisma.Decimal(0);
    let cryptoValueKrw = new Prisma.Decimal(0);

    for (const position of participant.positions) {
      if (
        this.getAssetPriceCurrency(position.asset) !==
        this.getAssetSettlementCurrency(position.asset)
      ) {
        this.throwApiError(
          HttpStatus.BAD_REQUEST,
          'ORDER_PRICE_SETTLEMENT_CURRENCY_NOT_SUPPORTED',
          'Separate price and settlement currencies are not supported for portfolio valuation yet.',
        );
      }

      const priceSnapshot = await this.findLatestAssetPriceForPortfolio(
        tx,
        {
          assetId: position.assetId,
          assetType: position.asset.assetType,
          market: position.asset.market,
          currencyCode: this.getAssetPriceCurrency(position.asset),
        },
        valuationAt,
      );
      const marketValueLocal = roundDecimalHalfUp(
        position.quantity.mul(priceSnapshot.price),
        monetaryScale,
      );
      const priceKrw =
        priceSnapshot.priceKrw ??
        this.convertToKrwForPortfolio(
          priceSnapshot.price,
          priceSnapshot.currencyCode,
          usdKrwRate,
        );
      const marketValueKrw = roundDecimalHalfUp(
        position.quantity.mul(priceKrw),
        monetaryScale,
      );
      const unrealizedPnlLocal = roundDecimalHalfUp(
        priceSnapshot.price.sub(position.averageCost).mul(position.quantity),
        monetaryScale,
      );
      const unrealizedPnlKrw = this.convertToKrwForPortfolio(
        unrealizedPnlLocal,
        position.currencyCode,
        usdKrwRate,
      );

      await tx.position.update({
        where: {
          id: position.id,
        },
        data: {
          currentPriceLocal: this.formatDecimal(
            priceSnapshot.price,
            monetaryScale,
          ),
          currentPriceKrw: this.formatDecimal(priceKrw, monetaryScale),
          marketValueLocal: this.formatDecimal(marketValueLocal, monetaryScale),
          marketValueKrw: this.formatDecimal(marketValueKrw, monetaryScale),
          unrealizedPnlLocal: this.formatDecimal(
            unrealizedPnlLocal,
            monetaryScale,
          ),
          unrealizedPnlKrw: this.formatDecimal(unrealizedPnlKrw, monetaryScale),
        },
        select: {
          id: true,
        },
      });

      switch (position.asset.assetType) {
        case AssetType.domestic_stock:
          domesticStockValueKrw = domesticStockValueKrw.add(marketValueKrw);
          break;
        case AssetType.us_stock:
          usStockValueKrw = usStockValueKrw.add(marketValueKrw);
          break;
        case AssetType.crypto:
          cryptoValueKrw = cryptoValueKrw.add(marketValueKrw);
          break;
      }
    }

    const totalAssetKrw = krwCash
      .add(usdCashKrw)
      .add(domesticStockValueKrw)
      .add(usStockValueKrw)
      .add(cryptoValueKrw);
    const returnRate = totalAssetKrw
      .sub(participant.initialCapitalKrw)
      .div(participant.initialCapitalKrw)
      .mul(100);

    return {
      totalAssetKrw: this.formatDecimal(totalAssetKrw, monetaryScale),
      returnRate: this.formatDecimal(returnRate, 8),
      krwCash: this.formatDecimal(krwCash, monetaryScale),
      usdCashKrw: this.formatDecimal(usdCashKrw, monetaryScale),
      domesticStockValueKrw: this.formatDecimal(
        domesticStockValueKrw,
        monetaryScale,
      ),
      usStockValueKrw: this.formatDecimal(usStockValueKrw, monetaryScale),
      cryptoValueKrw: this.formatDecimal(cryptoValueKrw, monetaryScale),
    };
  }

  private async findLatestUsdKrwRateForPortfolio(
    tx: OrderExecuteTransactionClient,
    valuationAt: Date,
  ): Promise<Prisma.Decimal> {
    const providerEligibility = resolveFxProviderEligibility({
      workflow: 'live_portfolio_valuation',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    });
    const providerCandidates = providerEligibility.eligible
      ? await tx.fxRateSnapshot.findMany({
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
      return providerSelection.snapshot.rate;
    }

    const snapshot = await tx.fxRateSnapshot.findFirst({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        sourceType: FxRateSourceType.admin_manual,
        approvedByUserId: {
          not: null,
        },
        rate: {
          gt: 0,
        },
        effectiveAt: {
          lte: valuationAt,
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
      if (
        providerSelection.decision.rejectedProviderReason ===
        'captured_at_stale'
      ) {
        this.throwApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'FX_RATE_STALE',
          'USD/KRW FX rate snapshot is stale.',
        );
      }

      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FX_RATE_UNAVAILABLE',
        'USD/KRW FX rate snapshot is unavailable.',
      );
    }

    if (
      snapshot.sourceType !== FxRateSourceType.admin_manual ||
      !snapshot.approvedByUserId
    ) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FX_RATE_UNAVAILABLE',
        'No approved admin_manual USD/KRW FX rate snapshot is available.',
      );
    }

    if (
      isFxSnapshotStaleForPortfolioValuation(snapshot.effectiveAt, valuationAt)
    ) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FX_RATE_STALE',
        'USD/KRW FX rate snapshot is stale.',
      );
    }

    return snapshot.rate;
  }

  private async findLatestAssetPriceForPortfolio(
    tx: OrderExecuteTransactionClient,
    input: {
      assetId: string;
      assetType: AssetType;
      market: string;
      currencyCode: CurrencyCode;
    },
    valuationAt: Date,
  ): Promise<{
    price: Prisma.Decimal;
    priceKrw: Prisma.Decimal | null;
    currencyCode: CurrencyCode;
  }> {
    const providerEligibility = resolveAssetProviderEligibility({
      workflow: 'live_portfolio_valuation',
      asset: {
        id: input.assetId,
        assetType: input.assetType,
        market: input.market,
        currencyCode: input.currencyCode,
      },
    });
    const providerCandidates = providerEligibility.eligible
      ? await tx.assetPriceSnapshot.findMany({
          where: {
            assetId: input.assetId,
            currencyCode: input.currencyCode,
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
            priceKrw: true,
            currencyCode: true,
            sourceType: true,
            sourceName: true,
            effectiveAt: true,
            capturedAt: true,
          },
        })
      : [];
    const providerSelection = providerEligibility.eligible
      ? selectMarketAwareAssetPriceSnapshotBySourcePriority({
          asset: input,
          workflow: 'live_portfolio_valuation',
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
        price: providerSelection.snapshot.price,
        priceKrw: providerSelection.snapshot.priceKrw,
        currencyCode: providerSelection.snapshot.currencyCode,
      };
    }

    const snapshot = await tx.assetPriceSnapshot.findFirst({
      where: {
        assetId: input.assetId,
        currencyCode: input.currencyCode,
        sourceType: AssetPriceSourceType.admin_manual,
        price: {
          gt: 0,
        },
        effectiveAt: {
          lte: valuationAt,
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
        priceKrw: true,
        currencyCode: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });

    if (!snapshot) {
      if (
        providerSelection.decision.rejectedProviderReason ===
          'captured_at_stale' ||
        providerSelection.decision.rejectedProviderReason ===
          'effective_at_outside_current_session'
      ) {
        this.throwApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'PRICE_STALE',
          'Asset price snapshot is stale.',
        );
      }

      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'ASSET_PRICE_UNAVAILABLE',
        'Asset price snapshot is unavailable.',
      );
    }

    return {
      price: snapshot.price,
      priceKrw: snapshot.priceKrw,
      currencyCode: snapshot.currencyCode,
    };
  }

  private convertToKrwForPortfolio(
    amount: Prisma.Decimal,
    currencyCode: CurrencyCode,
    usdKrwRate: Prisma.Decimal | null,
  ): Prisma.Decimal {
    if (currencyCode === CurrencyCode.KRW) {
      return roundDecimalHalfUp(amount, monetaryScale);
    }

    if (!usdKrwRate) {
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FX_RATE_UNAVAILABLE',
        'USD/KRW FX rate snapshot is unavailable.',
      );
    }

    return roundDecimalHalfUp(amount.mul(usdKrwRate), monetaryScale);
  }

  private calculateRealizedPnlKrwDeltaForExecution(
    realizedPnlDelta: Prisma.Decimal,
    currencyCode: CurrencyCode,
    plan: OrderExecutionPlan,
  ): Prisma.Decimal {
    if (currencyCode === CurrencyCode.KRW) {
      return realizedPnlDelta;
    }

    if (!plan.executeRate) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'ORDER_EXECUTION_TRANSACTION_FAILED',
        'USD/KRW execution rate is required for realizedPnlKrw.',
      );
    }

    return roundDecimalHalfUp(
      realizedPnlDelta.mul(plan.executeRate),
      monetaryScale,
    );
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
        'INSUFFICIENT_QUANTITY',
        'Order position was not found.',
      );
    }

    if (position.quantity.lt(input.quantity)) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_QUANTITY',
        'Position quantity is insufficient.',
      );
    }

    this.throwApiError(
      HttpStatus.CONFLICT,
      'CONFLICT',
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
          quotedPrice: this.formatDecimal(
            result.plan.quotedPrice,
            monetaryScale,
          ),
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
          equitySnapshotId: result.equitySnapshotId,
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
          equitySnapshotId: null,
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
    this.assertSeasonTradable(season, quoteAt);
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
    if (
      request.currencyCode &&
      request.currencyCode !== this.getAssetSettlementCurrency(asset)
    ) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'ASSET_CURRENCY_MISMATCH',
        'currencyCode must match asset settlementCurrency.',
      );
    }
    if (
      this.getAssetPriceCurrency(asset) !==
      this.getAssetSettlementCurrency(asset)
    ) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'ORDER_PRICE_SETTLEMENT_CURRENCY_NOT_SUPPORTED',
        'Separate price and settlement currencies are not supported for order execution yet.',
      );
    }
    this.assertOrderAssetTradable(asset, quoteAt);

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
      this.getAssetSettlementCurrency(asset) === CurrencyCode.USD
        ? await this.findFreshUsdKrwSnapshot(quoteAt, sourceWorkflow)
        : null;
    const krwAmounts = this.calculateKrwAmounts(
      {
        grossAmount,
        feeAmount,
        netAmount,
      },
      this.getAssetSettlementCurrency(asset),
      fxSnapshot?.rate ?? null,
    );

    const previewBalances = await this.assertOrderResourcesAvailable({
      participantId: participant.id,
      assetId: asset.id,
      side: request.side,
      currencyCode: this.getAssetSettlementCurrency(asset),
      quantity: request.quantity,
      netAmount,
    });
    const estimatedWalletBalanceAfter =
      request.side === OrderSide.buy
        ? previewBalances.walletBalanceBefore.sub(netAmount)
        : previewBalances.walletBalanceBefore.add(netAmount);
    const estimatedPositionQuantityAfter =
      request.side === OrderSide.buy
        ? previewBalances.positionQuantityBefore.add(request.quantity)
        : previewBalances.positionQuantityBefore.sub(request.quantity);

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
      walletBalanceBefore: previewBalances.walletBalanceBefore,
      estimatedWalletBalanceAfter,
      positionQuantityBefore: previewBalances.positionQuantityBefore,
      estimatedPositionQuantityAfter,
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
      limitPrice: quote.request.limitPrice,
      currencyCode: this.getAssetSettlementCurrency(quote.asset),
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
        quantity: this.formatDecimal(quote.request.quantity, quantityScale),
        limitPrice: quote.request.limitPrice
          ? this.formatDecimal(quote.request.limitPrice, monetaryScale)
          : null,
        currencyCode: this.getAssetSettlementCurrency(quote.asset),
        quotedPrice: this.formatDecimal(quote.price, monetaryScale),
        quotedRate: quote.fxRate ? this.formatDecimal(quote.fxRate, 8) : null,
        // Limit quotes only: the reservation basis create must reuse verbatim.
        // Market quotes leave all four null and keep repricing at execute.
        quotedFeeRate: quote.limitReservationBasis
          ? formatDecimalScale(
              quote.limitReservationBasis.quotedFeeRate,
              feeRateScale,
            )
          : null,
        quotedGrossAmount: quote.limitReservationBasis
          ? this.formatDecimal(
              quote.limitReservationBasis.quotedGrossAmount,
              monetaryScale,
            )
          : null,
        quotedFeeAmount: quote.limitReservationBasis
          ? this.formatDecimal(
              quote.limitReservationBasis.quotedFeeAmount,
              monetaryScale,
            )
          : null,
        quotedReservedAmount: quote.limitReservationBasis
          ? this.formatDecimal(
              quote.limitReservationBasis.quotedReservedAmount,
              monetaryScale,
            )
          : null,
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
        quotedFeeRate: true,
        quotedGrossAmount: true,
        quotedFeeAmount: true,
        quotedReservedAmount: true,
      },
    });

    // Read the reservation basis back from the row that was just written, so
    // the quote RESPONSE and the row CREATE will later reserve against are
    // provably the same numbers at the same stored scale.
    const persistedBasis =
      durableQuote.quotedFeeRate &&
      durableQuote.quotedGrossAmount &&
      durableQuote.quotedFeeAmount &&
      durableQuote.quotedReservedAmount
        ? {
            quotedFeeRate: durableQuote.quotedFeeRate,
            quotedGrossAmount: durableQuote.quotedGrossAmount,
            quotedFeeAmount: durableQuote.quotedFeeAmount,
            quotedReservedAmount: durableQuote.quotedReservedAmount,
          }
        : undefined;

    return {
      ...quote,
      ...(persistedBasis ? { limitReservationBasis: persistedBasis } : {}),
      quoteId: durableQuote.id,
      expiresAt,
      maxChangeBps,
      requestHash,
    };
  }

  private async findActiveOrderQuoteForCreateOrThrow(
    tx: OrderExecuteTransactionClient,
    input: {
      quoteId: string;
      userId: string;
      seasonParticipantId: string;
      request: ParsedOrderRequest;
      now: Date;
    },
  ): Promise<DurableOrderQuoteForCreate> {
    const quote = await tx.quote.findFirst({
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
        quotedFeeRate: true,
        quotedGrossAmount: true,
        quotedFeeAmount: true,
        quotedReservedAmount: true,
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
            priceCurrency: true,
            settlementCurrency: true,
            isActive: true,
          },
        },
      },
    });

    if (!quote) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'QUOTE_NOT_FOUND',
        'Quote not found.',
      );
    }

    if (quote.status !== QuoteStatus.active) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_NOT_ACTIVE',
        'Quote is not active.',
      );
    }

    if (input.now.getTime() > quote.expiresAt.getTime()) {
      await tx.quote.updateMany({
        where: {
          id: quote.id,
          status: QuoteStatus.active,
        },
        data: {
          status: QuoteStatus.expired,
        },
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_EXPIRED',
        'Quote has expired.',
      );
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
      limitPrice: input.request.limitPrice,
      currencyCode: this.getAssetSettlementCurrency(quote.asset),
    });
    // limitPrice must match at canonical scale in BOTH directions: a market
    // request requires a market quote (both null) and a limit request
    // requires the identical stored limit price.
    const quoteLimitPriceText = quote.limitPrice
      ? this.formatDecimal(quote.limitPrice, monetaryScale)
      : null;
    const requestLimitPriceText = input.request.limitPrice
      ? this.formatDecimal(input.request.limitPrice, monetaryScale)
      : null;

    if (
      quote.seasonParticipantId !== input.seasonParticipantId ||
      quote.assetId !== input.request.assetId ||
      quote.side !== input.request.side ||
      quote.orderType !== input.request.orderType ||
      !quote.quantity ||
      this.formatDecimal(quote.quantity, quantityScale) !==
        this.formatDecimal(input.request.quantity, quantityScale) ||
      quoteLimitPriceText !== requestLimitPriceText ||
      quote.currencyCode !== this.getAssetSettlementCurrency(quote.asset) ||
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

    this.assertParticipantTradable(participant.participantStatus);

    return participant;
  }

  private buildOrderCreateIdempotency(input: {
    body: OrderRequestBody;
    request: ParsedOrderRequest;
    quoteId: string;
  }): OrderCreateIdempotency {
    const { body, request, quoteId } = input;
    const idempotencyKey = this.parseIdempotencyKey(body.idempotencyKey);
    const canonicalPayload = {
      apiVersion: ORDER_CREATE_REQUEST_HASH_API_VERSION,
      quoteId,
      assetId: request.assetId,
      side: request.side,
      orderType: request.orderType,
      quantity: this.formatDecimal(request.quantity, quantityScale),
      // Included in the hash so replaying the same idempotencyKey with a
      // different limitPrice is an ORDER_IDEMPOTENCY_CONFLICT. Market
      // requests keep the historical null (hash-compatible).
      limitPrice: request.limitPrice
        ? this.formatDecimal(request.limitPrice, monetaryScale)
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
    const side = this.parseRequiredSide(body.side);

    if (orderType === OrderType.market) {
      // Historical behavior: a market request carrying limitPrice keeps the
      // original ORDER_TYPE_NOT_SUPPORTED rejection.
      if (this.hasProvidedValue(body.limitPrice)) {
        this.throwApiError(
          HttpStatus.BAD_REQUEST,
          'ORDER_TYPE_NOT_SUPPORTED',
          'Only market orders are supported.',
        );
      }

      return {
        assetId: this.parseRequiredText(body.assetId, 'assetId'),
        side,
        orderType,
        quantity: this.parsePositiveQuantityField(body.quantity),
        limitPrice: null,
        currencyCode: this.parseOptionalCurrencyCode(body.currencyCode),
      };
    }

    // Limit orders: phase 1 supports full-quantity BUY only.
    if (side !== OrderSide.buy) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        limitOrderErrorCodes.LIMIT_BUY_ONLY,
        'Limit orders support buy side only.',
      );
    }

    if (!this.hasProvidedValue(body.limitPrice)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        limitOrderErrorCodes.INVALID_LIMIT_PRICE,
        'limitPrice is required for limit orders.',
      );
    }

    return {
      assetId: this.parseRequiredText(body.assetId, 'assetId'),
      side,
      orderType,
      quantity: this.parsePositiveQuantityField(body.quantity),
      limitPrice: this.parsePositiveDecimalField(
        body.limitPrice,
        'limitPrice',
        monetaryScale,
      ),
      currencyCode: this.parseOptionalCurrencyCode(body.currencyCode),
    };
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
        'IDEMPOTENCY_REQUIRED',
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
        reservedAmount: true,
        reservationReleasedAt: true,
        cancelReason: true,
        triggerEventId: true,
        triggerEventAt: true,
        matchedAt: true,
        matchingSource: true,
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
  ): CreateOrderResponse | LimitOrderCreateResponse {
    if (order.requestHash !== idempotency.requestHash) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_IDEMPOTENCY_CONFLICT',
        'Same idempotencyKey was used with a different order create request.',
      );
    }

    if (order.responsePayloadJson) {
      return order.responsePayloadJson as unknown as
        | CreateOrderResponse
        | LimitOrderCreateResponse;
    }

    // Limit-buy creates always persist their payload in the same
    // transaction; reaching here without one means the row predates that
    // guarantee — rebuild a faithful submitted-state payload instead of the
    // market executed-shape below.
    if (order.orderType === OrderType.limit) {
      return {
        success: true,
        data: {
          order: this.formatOrder(order),
          execution: {
            state: 'submitted',
            submittedAt: order.submittedAt.toISOString(),
            quoteId: order.quoteId,
            reservedAmount: this.formatNullableDecimal(
              order.reservedAmount,
              monetaryScale,
            ),
            reservationFeeRate: null,
            duplicate: true,
          },
          executionPolicy: this.limitOrderExecutionPolicy(),
        },
      };
    }

    const formattedOrder = this.formatOrder(order);
    return {
      success: true,
      data: {
        order: formattedOrder,
        execution: {
          state:
            order.status === OrderStatus.executed
              ? 'already_executed'
              : 'executed',
          executedAt: this.formatNullableDate(order.executedAt),
          priceSource: 'provider_api',
          quoteId: order.quoteId,
          quotedPrice: null,
          executePrice: this.formatNullableDecimal(
            order.executedPrice,
            monetaryScale,
          ),
          priceChangeBps: null,
          quotedRate: null,
          executeRate: null,
          rateChangeBps: null,
          assetPriceSource: null,
          fxRateSource: null,
          assetPriceSnapshotId: order.assetPriceSnapshotId,
          fxRateSnapshotId: order.fxRateSnapshotId,
          walletTransactionId: null,
          walletBalanceAfter: null,
          positionId: null,
          equitySnapshotId: null,
          duplicate: true,
        },
      },
    };
  }

  private parseOrderType(value: unknown): OrderType {
    // Omitted orderType keeps the historical market default.
    if (!this.hasProvidedValue(value)) {
      return OrderType.market;
    }

    const text = this.parseRequiredText(value, 'orderType');
    if (text === OrderType.market) {
      return OrderType.market;
    }

    if (text === OrderType.limit) {
      return OrderType.limit;
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
    scale: number = monetaryScale,
  ): Prisma.Decimal {
    try {
      const decimal = parsePositiveDecimalString(value);
      if (decimal.decimalPlaces() > scale) {
        throw new Error(`${fieldName} must fit Decimal(24, ${scale}) scale.`);
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

  private parsePositiveQuantityField(value: unknown): Prisma.Decimal {
    return this.parsePositiveDecimalField(value, 'quantity', quantityScale);
  }

  private hasProvidedValue(value: unknown): boolean {
    return !(value === undefined || value === null || value === '');
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
        priceCurrency: true,
        settlementCurrency: true,
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
        'ASSET_NOT_TRADABLE',
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
    void request;

    const providerEligibility = resolveAssetProviderEligibility({
      workflow: sourceWorkflow,
      asset: {
        id: asset.id,
        assetType: asset.assetType,
        market: asset.market,
        currencyCode: this.getAssetPriceCurrency(asset),
      },
    });
    const providerCandidates = providerEligibility.eligible
      ? ((await this.prisma.assetPriceSnapshot.findMany({
          where: {
            assetId: asset.id,
            currencyCode: this.getAssetPriceCurrency(asset),
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
      ? selectMarketAwareAssetPriceSnapshotBySourcePriority({
          asset,
          workflow: sourceWorkflow,
          candidates: providerCandidates,
          expectedSourceNames: providerEligibility.sourceNames,
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
        currencyCode: this.getAssetPriceCurrency(asset),
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
      ? selectFreshProviderSnapshotBySourcePriority({
          candidates: providerCandidates,
          expectedSourceNames: providerEligibility.sourceNames,
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
  }): Promise<{
    walletBalanceBefore: Prisma.Decimal;
    positionQuantityBefore: Prisma.Decimal;
  }> {
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
          reservedAmount: true,
        },
      });

      // Only the AVAILABLE balance may fund a market buy: cash reserved by
      // submitted limit-buy orders is off-limits (mirrors the atomic guard
      // applied at execution time). A missing reservedAmount (legacy test
      // fixtures) means "no reservations".
      if (
        !wallet ||
        wallet.balanceAmount
          .sub(wallet.reservedAmount ?? new Prisma.Decimal(0))
          .lt(input.netAmount)
      ) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'INSUFFICIENT_BALANCE',
          'Cash wallet balance is insufficient.',
        );
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

      return {
        walletBalanceBefore: wallet.balanceAmount,
        positionQuantityBefore: position?.quantity ?? new Prisma.Decimal(0),
      };
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
        'INSUFFICIENT_QUANTITY',
        'Position quantity is insufficient.',
      );
    }

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

    return {
      walletBalanceBefore: wallet?.balanceAmount ?? new Prisma.Decimal(0),
      positionQuantityBefore: position.quantity,
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
        priceCurrency: this.getAssetPriceCurrency(quote.asset),
        settlementCurrency: this.getAssetSettlementCurrency(quote.asset),
      },
      side: quote.request.side,
      orderType: quote.request.orderType,
      quantity: this.formatDecimal(quote.request.quantity, quantityScale),
      price: this.formatDecimal(quote.price, monetaryScale),
      currencyCode: this.getAssetSettlementCurrency(quote.asset),
      grossAmount: this.formatDecimal(quote.grossAmount, monetaryScale),
      feeRate: formatDecimalScale(quote.season.tradeFeeRate, feeRateScale),
      feeAmount: this.formatDecimal(quote.feeAmount, monetaryScale),
      netAmount: this.formatDecimal(quote.netAmount, monetaryScale),
      krwGrossAmount: this.formatDecimal(quote.krwGrossAmount, monetaryScale),
      krwFeeAmount: this.formatDecimal(quote.krwFeeAmount, monetaryScale),
      krwNetAmount: this.formatDecimal(quote.krwNetAmount, monetaryScale),
      walletBalanceBefore: this.formatDecimal(
        quote.walletBalanceBefore,
        monetaryScale,
      ),
      estimatedWalletBalanceAfter: this.formatDecimal(
        quote.estimatedWalletBalanceAfter,
        monetaryScale,
      ),
      positionQuantityBefore: this.formatDecimal(
        quote.positionQuantityBefore,
        monetaryScale,
      ),
      estimatedPositionQuantityAfter: this.formatDecimal(
        quote.estimatedPositionQuantityAfter,
        monetaryScale,
      ),
      assetPriceSnapshotId: quote.assetPriceSnapshotId,
      fxRateSnapshotId: quote.fxRateSnapshotId,
      assetPriceSource: quote.assetPriceSource,
      ...(quote.fxRateSource ? { fxRateSource: quote.fxRateSource } : {}),
      quoteId: quote.quoteId,
      expiresAt: quote.expiresAt ? quote.expiresAt.toISOString() : null,
      maxChangeBps: quote.maxChangeBps ? quote.maxChangeBps.toFixed(4) : null,
      quoteAt: quote.quoteAt.toISOString(),
    };
  }

  private formatOrder(
    order: Parameters<typeof formatOrderResponse>[0],
  ): OrderResponsePayload {
    return formatOrderResponse(order);
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
    return buildPagination({
      limit: query.limit,
      offset: query.offset,
      total,
      returned,
    });
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

  private assertParticipantTradable(status: ParticipantStatus) {
    if (status === ParticipantStatus.excluded) {
      this.throwApiError(
        HttpStatus.FORBIDDEN,
        'PARTICIPANT_EXCLUDED',
        'Season participant is excluded from trading.',
      );
    }

    if (status !== ParticipantStatus.active) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PARTICIPANT_NOT_ACTIVE',
        'Season participant is not active.',
      );
    }
  }

  private getAssetPriceCurrency(
    asset: Pick<OrderAsset, 'currencyCode'> & {
      priceCurrency?: CurrencyCode | null;
    },
  ): CurrencyCode {
    return asset.priceCurrency ?? asset.currencyCode;
  }

  private getAssetSettlementCurrency(
    asset: Pick<OrderAsset, 'currencyCode'> & {
      settlementCurrency?: CurrencyCode | null;
    },
  ): CurrencyCode {
    return asset.settlementCurrency ?? asset.currencyCode;
  }

  private assertSeasonTradable(season: ActiveOrderSeason, now: Date) {
    try {
      assertSeasonTradable(season, now);
    } catch (error) {
      if (error instanceof SeasonLifecycleError) {
        this.throwApiError(HttpStatus.CONFLICT, error.code, error.message);
      }

      throw error;
    }
  }

  private assertOrderAssetTradable(
    asset: Pick<OrderAsset, 'assetType' | 'market'>,
    now: Date,
  ) {
    try {
      assertAssetTradable(asset, now);
    } catch (error) {
      if (error instanceof MarketHoursError) {
        // MARKET_CLOSED (confirmed closure) and MARKET_CALENDAR_UNAVAILABLE
        // (session undecidable, fail-closed) both block with 409 but keep
        // distinct codes; ASSET_NOT_TRADABLE stays a 400 input problem.
        this.throwApiError(
          error.code === 'ASSET_NOT_TRADABLE'
            ? HttpStatus.BAD_REQUEST
            : HttpStatus.CONFLICT,
          error.code,
          error.message,
        );
      }

      throw error;
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

  private refreshRankingAfterParticipantChange(
    seasonId: string,
    seasonParticipantId: string,
  ) {
    if (!this.rankingRefreshService) {
      return;
    }

    void this.rankingRefreshService
      .refreshCurrentRankingAfterParticipantChange(
        seasonId,
        seasonParticipantId,
      )
      .catch((error) => {
        console.error('Current ranking refresh after order failed.', error);
      });
  }

  private limitOrderExecutionPolicy() {
    const autoExecutionEnabled = this.isLimitOrderAutoExecutionEnabled();
    return {
      autoExecutionEnabled,
      mode: autoExecutionEnabled
        ? ('live_trade_event' as const)
        : ('reservation_only' as const),
      triggerType: autoExecutionEnabled
        ? ('provider_trade_price' as const)
        : null,
      fullFillOnly: true as const,
    };
  }

  private getHttpErrorCode(error: HttpException): string | null {
    const response = error.getResponse();
    if (
      typeof response === 'object' &&
      response !== null &&
      'error' in response
    ) {
      const errorBody = (response as { error?: { code?: unknown } }).error;
      return typeof errorBody?.code === 'string' ? errorBody.code : null;
    }

    return null;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    return (error as { code?: unknown }).code === 'P2002';
  }
}
