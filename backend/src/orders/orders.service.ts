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
  TradingAccountMode,
  TradingAccountStatus,
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
import { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
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
import {
  TradingAccountAccessService,
  type OwnedTradingAccount,
} from '../trading-accounts/trading-account-access.service';
import { assertSeasonAccountOrderScopeIntegrity } from '../trading-accounts/trading-account-financial-integrity';
import { debitAvailableCash } from '../wallets/cash-wallet-atomic';
import { diagnoseCashWalletMutationFailure } from '../wallets/cash-wallet-failure-diagnosis';
import { assertCashWalletTradingAccountScope } from '../wallets/cash-wallet-scope';
import { readGeneralTradeFeeRate } from './general-trading.config';
import { assertAssetTradable, MarketHoursError } from './market-hours.policy';
import { isLimitOrderEnabled } from './limit-order.config';
import { readLimitOrderMatchingConfig } from './limit-order-matching.config';
import { limitOrderErrorCodes } from './limit-order-error-policy';
import type { QuotedLimitReservationBasis } from './limit-order-policy';
import {
  buildLimitOrderExecutionPolicy,
  LimitOrderCreateService,
  type LimitOrderCreateResponse,
  type LimitOrderExecutionPolicy,
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
  tradingAccountId: string | null;
};

/**
 * Validated account trading context. The calculation/execution core consumes
 * this and never infers a mode from whichever related row happens to exist.
 */
type TradingContext = {
  mode: TradingAccountMode;
  season: ActiveOrderSeason | null;
  participant: OrdersParticipant | null;
  tradingAccountId: string;
  feeRate: Prisma.Decimal;
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
  context: TradingContext;
  asset: OrderAsset;
  request: ParsedOrderRequest;
  price: Prisma.Decimal;
  grossAmount: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  netAmount: Prisma.Decimal;
  krwGrossAmount: Prisma.Decimal;
  krwFeeAmount: Prisma.Decimal;
  krwNetAmount: Prisma.Decimal;
  /** Buy-side cash reservation basis pinned on the durable limit quote. */
  limitReservationBasis?: QuotedLimitReservationBasis;
  limitSellBasis?: {
    quotedFeeRate: Prisma.Decimal;
    quotedGrossAmount: Prisma.Decimal;
    quotedFeeAmount: Prisma.Decimal;
    quotedNetAmount: Prisma.Decimal;
  };
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
  tradingAccountId: string | null;
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
  quotedNetAmount: Prisma.Decimal | null;
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
    quotedNetAmount?: string;
    reservedAmount?: string;
    reservedQuantity?: string;
    positionReservedBefore?: string;
    positionAvailableBefore?: string;
    estimatedPositionReservedAfter?: string;
    estimatedPositionAvailableAfter?: string;
    walletReservedBefore?: string;
    walletAvailableBefore?: string;
    estimatedReservedAfter?: string;
    estimatedAvailableAfter?: string;
    executionPolicy?: LimitOrderExecutionPolicy;
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
  seasonParticipantId: string | null;
  tradingAccountId: string | null;
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
    tradingAccountId: string | null;
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
    tradingAccountId: string | null;
    season: ActiveOrderSeason;
  } | null;
  tradingAccount: {
    id: string;
    userId: string;
    mode: TradingAccountMode;
    status: TradingAccountStatus;
    initialCapitalKrw: Prisma.Decimal;
    seasonParticipant: { id: string } | null;
  } | null;
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
  seasonId: string | null;
  seasonParticipantId: string | null;
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
  tradingAccountId: true,
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
  reservedQuantity: true,
  reservationReleasedAt: true,
  cancelReason: true,
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
      tradingAccountId: true,
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
      tradingAccountId: true,
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
  tradingAccount: {
    select: {
      id: true,
      userId: true,
      mode: true,
      status: true,
      initialCapitalKrw: true,
      seasonParticipant: { select: { id: true } },
    },
  },
} as const;

/**
 * Everything the idempotent-create replay needs to return the stored first
 * response (or rebuild a faithful payload for rows predating
 * responsePayloadJson). Shared by the user-scoped replay-first lookup and the
 * participant-scoped race-recovery lookup so the two can never drift.
 */
const IDEMPOTENT_CREATE_ORDER_SELECT = {
  id: true,
  quoteId: true,
  tradingAccountId: true,
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
  reservedQuantity: true,
  reservationReleasedAt: true,
  cancelReason: true,
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
} as const;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rankingRefreshService?: RankingRefreshService,
    private readonly limitOrderCreateService?: LimitOrderCreateService,
    private readonly limitOrderCancelService?: LimitOrderCancelService,
    @Optional()
    private readonly tradingAccountAccessService?: TradingAccountAccessService,
    @Optional()
    private readonly generalPerformanceService?: GeneralAccountPerformanceService,
  ) {}

  private requireTradingAccountAccessService(): TradingAccountAccessService {
    if (!this.tradingAccountAccessService) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_ERROR',
        'Trading account access service unavailable',
      );
    }
    return this.tradingAccountAccessService;
  }

  private requireGeneralPerformanceService(): GeneralAccountPerformanceService {
    if (!this.generalPerformanceService) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_ERROR',
        'General account performance service unavailable',
      );
    }
    return this.generalPerformanceService;
  }

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
   * Account-scoped quote: the SAME calculation/persistence core as the
   * legacy quote — only the season/participant resolution changes (owned
   * account named in the path instead of the implicit current season).
   */
  async quoteOrderForTradingAccount(
    userId: string | undefined,
    tradingAccountId: string,
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
    const context = await this.resolveAccountTradingContext(
      userId,
      tradingAccountId,
      quoteAt,
    );

    if (request.orderType === OrderType.limit) {
      this.assertLimitOrderFeatureEnabled();
      return this.quoteLimitBuyOrderForContext(
        userId,
        request,
        quoteAt,
        context,
      );
    }

    const quote = await this.buildOrderQuoteForContext({
      ...context,
      request,
      quoteAt,
      sourceWorkflow: 'orders_quote',
    });
    const durableQuote = await this.createDurableOrderQuote(userId, quote);

    return {
      success: true,
      data: this.formatOrderQuoteData(durableQuote),
    };
  }

  /**
   * Limit quote: reservation/proceeds preview from limitPrice × quantity only.
   * No provider asset price is resolved; the USD/KRW snapshot (USD assets)
   * feeds the KRW display conversion exactly like market quotes. Read-only:
   * the wallet is never mutated at quote time.
   */
  private async quoteLimitBuyOrder(
    userId: string,
    request: ParsedOrderRequest,
    quoteAt: Date,
  ): Promise<OrderQuoteResponse> {
    // Same gate order as before the account-context refactor: feature flag
    // and service wiring fail before any DB read.
    this.assertLimitOrderFeatureEnabled();
    this.requireLimitOrderCreateService();
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
    const tradingAccountId =
      this.requireParticipantTradingAccountId(participant);

    return this.quoteLimitBuyOrderForContext(userId, request, quoteAt, {
      mode: TradingAccountMode.season,
      season,
      participant,
      tradingAccountId,
      feeRate: season.tradeFeeRate,
    });
  }

  private async quoteLimitBuyOrderForContext(
    userId: string,
    request: ParsedOrderRequest,
    quoteAt: Date,
    context: TradingContext,
  ): Promise<OrderQuoteResponse> {
    if (request.side === OrderSide.sell) {
      return this.quoteLimitSellOrderForContext(
        userId,
        request,
        quoteAt,
        context,
      );
    }
    const { participant, tradingAccountId } = context;
    const limitOrderCreate = this.requireLimitOrderCreateService();
    if (!request.limitPrice) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        limitOrderErrorCodes.INVALID_LIMIT_PRICE,
        'limitPrice is required for limit orders.',
      );
    }

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
    // Same session policy as market orders: stocks only while the market is
    // open (calendar fail-closed), crypto 24h.
    this.assertOrderAssetTradable(asset, quoteAt);

    const settlementCurrency = this.getAssetSettlementCurrency(asset);
    const preview = await limitOrderCreate.buildLimitBuyQuotePreview({
      participantId: participant?.id ?? null,
      tradingAccountId,
      assetId: asset.id,
      currencyCode: settlementCurrency,
      limitPrice: request.limitPrice,
      quantity: request.quantity,
      tradeFeeRate: context.feeRate,
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
      context,
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

  private async quoteLimitSellOrderForContext(
    userId: string,
    request: ParsedOrderRequest,
    quoteAt: Date,
    context: TradingContext,
  ): Promise<OrderQuoteResponse> {
    if (!request.limitPrice) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        limitOrderErrorCodes.INVALID_LIMIT_PRICE,
        'limitPrice is required for limit orders.',
      );
    }
    const asset = await this.findUsableAsset(request.assetId);
    const settlementCurrency = this.getAssetSettlementCurrency(asset);
    if (request.currencyCode && request.currencyCode !== settlementCurrency) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'ASSET_CURRENCY_MISMATCH',
        'currencyCode must match asset settlementCurrency.',
      );
    }
    if (this.getAssetPriceCurrency(asset) !== settlementCurrency) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'ORDER_PRICE_SETTLEMENT_CURRENCY_NOT_SUPPORTED',
        'Separate price and settlement currencies are not supported for order execution yet.',
      );
    }
    this.assertOrderAssetTradable(asset, quoteAt);
    const preview =
      await this.requireLimitOrderCreateService().buildLimitSellQuotePreview({
        participantId: context.participant?.id ?? null,
        tradingAccountId: context.tradingAccountId,
        assetId: asset.id,
        currencyCode: settlementCurrency,
        limitPrice: request.limitPrice,
        quantity: request.quantity,
        tradeFeeRate: context.feeRate,
      });
    const fxSnapshot =
      settlementCurrency === CurrencyCode.USD
        ? await this.findFreshUsdKrwSnapshot(quoteAt, 'orders_quote')
        : null;
    const krwAmounts = this.calculateKrwAmounts(
      preview,
      settlementCurrency,
      fxSnapshot?.rate ?? null,
    );
    const calculation: OrderQuoteCalculation = {
      context,
      asset,
      request,
      price: request.limitPrice,
      grossAmount: preview.grossAmount,
      feeAmount: preview.feeAmount,
      netAmount: preview.netAmount,
      limitSellBasis: {
        quotedFeeRate: preview.quotedFeeRate,
        quotedGrossAmount: preview.grossAmount,
        quotedFeeAmount: preview.feeAmount,
        quotedNetAmount: preview.netAmount,
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
      estimatedWalletBalanceAfter: preview.walletBalanceBefore.add(
        preview.netAmount,
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
    const basis = durableQuote.limitSellBasis;
    if (!basis) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        limitOrderErrorCodes.QUOTE_RESERVATION_BASIS_INVALID,
        'Limit sell quote was stored without its fee basis.',
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
        quotedNetAmount: this.formatDecimal(
          basis.quotedNetAmount,
          monetaryScale,
        ),
        reservedQuantity: this.formatDecimal(request.quantity, quantityScale),
        positionReservedBefore: this.formatDecimal(
          preview.positionReservedBefore,
          quantityScale,
        ),
        positionAvailableBefore: this.formatDecimal(
          preview.positionAvailableBefore,
          quantityScale,
        ),
        estimatedPositionReservedAfter: this.formatDecimal(
          preview.estimatedPositionReservedAfter,
          quantityScale,
        ),
        estimatedPositionAvailableAfter: this.formatDecimal(
          preview.estimatedPositionAvailableAfter,
          quantityScale,
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

    // COMMITTED REPLAY FIRST (작업 5 보완 2) — before season, participant, and
    // market gates.
    //
    // A market create that already COMMITTED (order + fills + wallet + ledger
    // + position) owes its caller the stored first response no matter what
    // has happened since: the season ended, the participant was excluded, the
    // market closed. Re-running those gates would fail a retry whose money has
    // ALREADY moved, and the retry storm this absorbs happens exactly when
    // such a gate has just started failing.
    //
    // The lookup is keyed on the QUOTE, which is user-scoped, single-use, and
    // UNIQUE on Order — so the replay scope equals a real DB uniqueness
    // constraint, needs no active season, and can never resolve to another
    // season's or another user's order. A key reused with a DIFFERENT quote is
    // not visible here; it is caught by the participant/account-scoped lookup
    // and the request-hash comparison further down.
    const replayedOrder = await this.findIdempotentCreateOrderForQuote({
      userId,
      quoteId,
      idempotencyKey: idempotency.idempotencyKey,
      expectedOrderType: OrderType.market,
    });
    if (replayedOrder) {
      return this.replayIdempotentCreateOrder(replayedOrder, idempotency);
    }

    const submittedAt = new Date();
    const season = await this.findActiveSeasonOrThrow();
    this.assertSeasonTradable(season, submittedAt);
    const participant = await this.findParticipantOrThrow(season.id, userId);
    const tradingAccountId =
      this.requireParticipantTradingAccountId(participant);

    return this.createMarketOrderForContext({
      userId,
      request,
      quoteId,
      idempotency,
      submittedAt,
      context: {
        mode: TradingAccountMode.season,
        season,
        participant,
        tradingAccountId,
        feeRate: season.tradeFeeRate,
      },
    });
  }

  /**
   * Account-scoped create: gates on account ownership/mode/status, then the
   * SAME market/limit create cores as the legacy endpoint (fees, quote
   * consumption, wallet/ledger/position writes, idempotency, rollback).
   */
  async createOrderForTradingAccount(
    userId: string | undefined,
    tradingAccountId: string,
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
    const submittedAt = new Date();

    if (request.orderType === OrderType.limit) {
      return this.createLimitBuyOrderForAccount(
        userId,
        tradingAccountId,
        body,
        request,
      );
    }

    const quoteId = this.parseQuoteId(body.quoteId);
    const idempotency = this.buildOrderCreateIdempotency({
      body,
      request,
      quoteId,
    });

    // Ownership FIRST: an unknown or foreign accountId is the same 404 before
    // anything is replayed, so no other user's order can ever be reached
    // through a borrowed accountId.
    const account =
      await this.requireTradingAccountAccessService().getOwnedAccountOrThrow(
        userId,
        tradingAccountId.trim(),
      );

    // COMMITTED REPLAY FIRST (작업 5 보완 2). The lookup replays exactly what
    // the DB uniquely enforces — (tradingAccountId, idempotencyKey), plus the
    // legacy null-scope row pinned to this participant AND user — and runs
    // BEFORE account status, mode-specific integrity, season status/window,
    // participant status, market hours, quote, wallet scope, balance, and
    // price freshness. Those gates decide whether a NEW order may be created;
    // they must not withhold a response the system already committed to.
    // The request-hash comparison inside replayIdempotentCreateOrder still
    // turns a key reused with a different request into a 409.
    const existingOrder = await this.findIdempotentCreateOrder({
      tradingAccountId: account.id,
      seasonParticipantId: account.seasonParticipant?.id ?? null,
      userId,
      idempotencyKey: idempotency.idempotencyKey,
    });
    if (existingOrder) {
      return this.replayIdempotentCreateOrder(existingOrder, idempotency);
    }

    const context = await this.resolveAccountTradingContextForAccount(
      account,
      submittedAt,
    );

    return this.createMarketOrderForContext({
      userId,
      request,
      quoteId,
      idempotency,
      submittedAt,
      context,
    });
  }

  private async createMarketOrderForContext(input: {
    userId: string;
    request: ParsedOrderRequest;
    quoteId: string;
    idempotency: OrderCreateIdempotency;
    submittedAt: Date;
    context: TradingContext;
  }): Promise<CreateOrderResponse | LimitOrderCreateResponse> {
    const { userId, request, quoteId, idempotency, submittedAt } = input;
    const { season, participant, tradingAccountId } = input.context;
    const existingOrder = await this.findIdempotentCreateOrder({
      tradingAccountId,
      seasonParticipantId: participant?.id ?? null,
      userId,
      idempotencyKey: idempotency.idempotencyKey,
    });

    if (existingOrder) {
      return this.replayIdempotentCreateOrder(existingOrder, idempotency);
    }

    try {
      const response = await this.prisma.$transaction(async (tx) => {
        await this.lockGeneralTradingAccountInTransaction(tx, input.context);
        const effectiveSubmittedAt =
          input.context.mode === TradingAccountMode.general
            ? await this.readTransactionWallClock(tx)
            : submittedAt;
        const quote = await this.findActiveOrderQuoteForCreateOrThrow(tx, {
          quoteId,
          userId,
          seasonParticipantId: participant?.id ?? null,
          tradingAccountId,
          request,
          now: effectiveSubmittedAt,
        });
        this.assertOrderAssetTradable(quote.asset, effectiveSubmittedAt);

        const price = roundDecimalHalfUp(quote.quotedPrice, monetaryScale);
        const grossAmount = roundDecimalHalfUp(
          request.quantity.mul(price),
          monetaryScale,
        );
        const feeAmount = roundDecimalHalfUp(
          grossAmount.mul(input.context.feeRate),
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
            seasonParticipantId: participant?.id ?? null,
            tradingAccountId,
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
            submittedAt: effectiveSubmittedAt,
            executedAt: null,
            canceledAt: null,
            rejectedAt: null,
            rejectReason: null,
            createdAt: effectiveSubmittedAt,
            updatedAt: effectiveSubmittedAt,
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
        this.assertExecutableSeasonAndAsset(
          executionOrder,
          effectiveSubmittedAt,
        );
        const plan = await this.buildOrderExecutionPlan(
          tx,
          executionOrder,
          effectiveSubmittedAt,
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

        // The response payload is persisted INSIDE the execution transaction,
        // so a committed market order always has a stored first response for
        // later replays (작업 5 보완 2). If this write fails, the order, the
        // fill, the wallet debit/credit, the ledger row, and the position all
        // roll back with it: a market order can never commit without the
        // response its retries will be answered with.
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

      if (season && participant) {
        this.refreshRankingAfterParticipantChange(season.id, participant.id);
      }

      return response;
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }

      const racedOrder = await this.findIdempotentCreateOrder({
        tradingAccountId,
        seasonParticipantId: participant?.id ?? null,
        userId,
        idempotencyKey: idempotency.idempotencyKey,
      });

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
   * Legacy-endpoint entry into the shared SUBMITTED limit-order core. Create
   * reserves buy cash or sell quantity but never executes or reads a provider
   * price; the common scheduler matcher performs later fills.
   */
  private async createLimitBuyOrder(
    userId: string,
    body: OrderRequestBody,
    request: ParsedOrderRequest,
  ): Promise<CreateOrderResponse | LimitOrderCreateResponse> {
    const quoteId = this.parseQuoteId(body.quoteId);
    const idempotency = this.buildOrderCreateIdempotency({
      body,
      request,
      quoteId,
    });
    // IDEMPOTENT REPLAY FIRST — before the feature flag, before service
    // wiring, before every state check.
    //
    // A create that already COMMITTED owes its caller the stored first
    // response, whatever has happened since: season ended, the feature
    // switched off, this instance deployed without the create service.
    // Re-running any of those gates here would fail a request whose order and
    // reservation already exist, and the retry storm this replay absorbs is
    // most likely EXACTLY when such a gate is failing or a rollback just
    // landed.
    // LIMIT_ORDER_ENABLED stops NEW registrations; it was never meant to
    // withhold a response the system already committed to.
    //
    // The lookup is keyed on the QUOTE, which is user-scoped, single-use and
    // uniquely tied to at most one order — so it needs no active season, and
    // the same idempotencyKey reused in a later season resolves to that
    // season's own order instead of colliding. It never returns another
    // user's order. A different request under the same quote is a conflict;
    // only a genuinely new quote proceeds to the gates below.
    const replayedOrder = await this.findIdempotentCreateOrderForQuote({
      userId,
      quoteId,
      idempotencyKey: idempotency.idempotencyKey,
      expectedOrderType: OrderType.limit,
    });
    if (replayedOrder) {
      return this.replayIdempotentCreateOrder(replayedOrder, idempotency);
    }
    this.assertLimitOrderFeatureEnabled();
    const submittedAt = new Date();
    // Pre-transaction checks are a fast-fail courtesy only: they give the user
    // a clean error without opening a transaction. They are NOT the basis of
    // financial correctness — every one of them is re-run against locked rows
    // inside the transaction below, because an operator can exclude the
    // participant or end the season in the gap.
    const season = await this.findActiveSeasonOrThrow();
    this.assertSeasonTradable(season, submittedAt);
    const participant = await this.findParticipantOrThrow(season.id, userId);
    const tradingAccountId =
      this.requireParticipantTradingAccountId(participant);

    return this.createLimitBuyOrderForContext({
      userId,
      request,
      quoteId,
      idempotency,
      context: {
        mode: TradingAccountMode.season,
        season,
        participant,
        tradingAccountId,
        feeRate: season.tradeFeeRate,
      },
    });
  }

  /**
   * Account-scoped limit create. Ownership resolves FIRST (a foreign or
   * unknown account is always the same 404), then the committed-replay
   * lookup runs — but only an order that belongs to THIS account replays;
   * the same quote consumed under a different account is a conflict. All
   * remaining gates and the create transaction are the shared core.
   */
  private async createLimitBuyOrderForAccount(
    userId: string,
    tradingAccountId: string,
    body: OrderRequestBody,
    request: ParsedOrderRequest,
  ): Promise<CreateOrderResponse | LimitOrderCreateResponse> {
    const quoteId = this.parseQuoteId(body.quoteId);
    const idempotency = this.buildOrderCreateIdempotency({
      body,
      request,
      quoteId,
    });
    const account =
      await this.requireTradingAccountAccessService().getOwnedAccountOrThrow(
        userId,
        tradingAccountId.trim(),
      );

    const replayedOrder = await this.findIdempotentCreateOrderForQuote({
      userId,
      quoteId,
      idempotencyKey: idempotency.idempotencyKey,
      expectedOrderType: OrderType.limit,
    });
    if (replayedOrder) {
      if (replayedOrder.tradingAccountId !== account.id) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'ORDER_IDEMPOTENCY_CONFLICT',
          'This quote was already used by a different order create request.',
        );
      }
      return this.replayIdempotentCreateOrder(replayedOrder, idempotency);
    }

    this.assertLimitOrderFeatureEnabled();
    const submittedAt = new Date();
    const context = await this.resolveAccountTradingContextForAccount(
      account,
      submittedAt,
    );

    return this.createLimitBuyOrderForContext({
      userId,
      request,
      quoteId,
      idempotency,
      context,
    });
  }

  private async createLimitBuyOrderForContext(input: {
    userId: string;
    request: ParsedOrderRequest;
    quoteId: string;
    idempotency: OrderCreateIdempotency;
    context: TradingContext;
  }): Promise<CreateOrderResponse | LimitOrderCreateResponse> {
    const { userId, request, quoteId, idempotency } = input;
    const { participant, tradingAccountId } = input.context;
    const limitOrderCreate = this.requireLimitOrderCreateService();

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Lock order: Quote → SeasonParticipant → Season → CashWallet →
        // Order. Registration is complete against PostgreSQL alone: no Redis
        // or provider-connection state participates in this transaction.
        //
        // See LimitOrderCreateService.lockTradableContextInTransaction for why
        // the participant precedes the season and why both are FOR SHARE.
        await limitOrderCreate.lockQuoteForCreateInTransaction(tx, quoteId);
        // Re-validate season + participant against LOCKED rows. A concurrent
        // exclusion or season-ending either commits first (and this create
        // fails) or waits behind these locks (and its cleanup then cancels the
        // order this transaction is about to commit). No third outcome exists,
        // so no reservation can outlive an exclusion or a season end.
        const lockedContext = participant
          ? await limitOrderCreate.lockTradableContextInTransaction(tx, {
              userId,
              seasonParticipantId: participant.id,
            })
          : null;
        if (participant) {
          // Trading-account link re-verified against the LOCKED participant.
          if (lockedContext?.tradingAccountId !== tradingAccountId) {
            this.throwTradingScopeIntegrityError(
              lockedContext?.tradingAccountId === null
                ? 'TRADING_ACCOUNT_LINK_INTEGRITY'
                : 'TRADING_ACCOUNT_SCOPE_MISMATCH',
              'Participant trading-account link changed while creating the order.',
            );
          }
        } else {
          await this.lockGeneralTradingAccountInTransaction(tx, input.context);
        }

        // PostgreSQL CURRENT_TIMESTAMP/now() are fixed at transaction start.
        // The wall clock is read only after every authorization row lock, so
        // lock wait time is never omitted from final quote/season/market
        // checks.
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
        if (lockedContext) {
          limitOrderCreate.assertLockedTradableContext(
            lockedContext,
            transactionNow,
          );
        }

        const quote = await this.findActiveOrderQuoteForCreateOrThrow(tx, {
          quoteId,
          userId,
          seasonParticipantId: participant?.id ?? null,
          tradingAccountId,
          request,
          now: transactionNow,
        });
        this.assertOrderAssetTradable(quote.asset, transactionNow);

        if (!quote.limitPrice) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'QUOTE_MISMATCH',
            'Quote does not match the order create request.',
          );
        }

        const createInput = {
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
          participant: { id: participant?.id ?? null, tradingAccountId },
          quantity: request.quantity,
          idempotency,
          submittedAt: transactionNow,
          autoExecutionEnabled:
            this.limitOrderExecutionPolicy().autoExecutionEnabled,
        };
        if (request.side === OrderSide.sell) {
          return limitOrderCreate.createSubmittedLimitSellInTransaction(tx, {
            ...createInput,
            quote: {
              ...createInput.quote,
              quotedNetAmount: quote.quotedNetAmount,
            },
          });
        }
        return limitOrderCreate.createSubmittedLimitBuyInTransaction(
          tx,
          createInput,
        );
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }

      // Two unique constraints can raise here and they mean different things.
      // `orders_quote_id_key` — the concurrent winner used the SAME quote, so
      // the quote-scoped lookup finds exactly the order this request wanted
      // and replays it. `(seasonParticipantId, idempotencyKey)` /
      // `(tradingAccountId, idempotencyKey)` — the key was reused with a
      // DIFFERENT quote inside one season/account, which the quote lookup
      // cannot see; the account-scoped fallback finds that order and the
      // request-hash comparison turns it into the conflict it is.
      const racedOrder =
        (await this.findIdempotentCreateOrderForQuote({
          userId,
          quoteId,
          idempotencyKey: idempotency.idempotencyKey,
          expectedOrderType: OrderType.limit,
        })) ??
        (await this.findIdempotentCreateOrder({
          tradingAccountId,
          seasonParticipantId: participant?.id ?? null,
          userId,
          idempotencyKey: idempotency.idempotencyKey,
        }));

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
    // Limit orders are cancelable; market orders keep the historical
    // ORDER_CANCEL_NOT_SUPPORTED (410) inside the cancel service. Cancel is
    // intentionally NOT gated by LIMIT_ORDER_ENABLED so existing
    // reservations can always be released.
    return this.requireLimitOrderCancelService().cancelOwnedLimitBuyOrder({
      userId,
      orderId: parsedOrderId,
      canceledAt: new Date(),
    });
  }

  /**
   * Account-scoped cancel. Cancel releases a reservation — a protective
   * action, not new risk — so like the legacy cancel it is NOT gated on
   * account/participant status: an owner may cancel their own submitted
   * limit order on an active, suspended, or closed account. The order must
   * belong to the named account (a foreign/unknown/other-account orderId is
   * the same 404), and the wallet-scope guard inside the cancel service
   * still fails closed on unscoped or mis-scoped rows.
   */
  async cancelOrderForTradingAccount(
    userId: string | undefined,
    tradingAccountId: string,
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
    const account =
      await this.requireTradingAccountAccessService().getOwnedAccountOrThrow(
        userId,
        tradingAccountId.trim(),
      );

    return this.requireLimitOrderCancelService().cancelOwnedLimitBuyOrder({
      userId,
      orderId: parsedOrderId,
      canceledAt: new Date(),
      expectedTradingAccountId: account.id,
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
      if (executionResult.seasonId && executionResult.seasonParticipantId) {
        this.refreshRankingAfterParticipantChange(
          executionResult.seasonId,
          executionResult.seasonParticipantId,
        );
      }

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
          reservedQuantity: true,
          reservationReleasedAt: true,
          cancelReason: true,
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

  /**
   * Account-scoped order list: rows are selected by the ORDER's own
   * tradingAccountId (never a client-provided participant id). Read-only
   * and status-blind — owners can read active, suspended, and closed
   * accounts alike. A season participant whose orders lost their account
   * scope fails closed (repair required) instead of looking empty.
   */
  async getOrdersForTradingAccount(
    userId: string | undefined,
    tradingAccountId: string,
    query: OrdersQuery = {},
  ) {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const parsedQuery = this.parseQuery(query);
    const account =
      await this.requireTradingAccountAccessService().getOwnedAccountOrThrow(
        userId,
        tradingAccountId.trim(),
      );

    if (account.mode === TradingAccountMode.general) {
      await this.requireGeneralPerformanceService().assertGeneralAccountReady(
        account,
      );
    } else {
      await assertSeasonAccountOrderScopeIntegrity(this.prisma, {
        tradingAccountId: account.id,
        seasonParticipantId: account.seasonParticipant?.id ?? null,
      });
    }

    const where = {
      tradingAccountId: account.id,
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
          reservedQuantity: true,
          reservationReleasedAt: true,
          cancelReason: true,
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
      success: true as const,
      data: {
        state: 'available' as const,
        tradingAccountId: account.id,
        filters: this.formatFilters(parsedQuery),
        pagination: this.pagination(parsedQuery, total, orders.length),
        orders: orders.map((order) => this.formatOrder(order)),
      },
    };
  }

  /**
   * Account-scoped order detail. A nonexistent orderId and another
   * account's orderId are the same 404 (no cross-account existence oracle).
   */
  async getOrderForTradingAccount(
    userId: string | undefined,
    tradingAccountId: string,
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
    const account =
      await this.requireTradingAccountAccessService().getOwnedAccountOrThrow(
        userId,
        tradingAccountId.trim(),
      );

    if (account.mode === TradingAccountMode.general) {
      await this.requireGeneralPerformanceService().assertGeneralAccountReady(
        account,
      );
    } else {
      await assertSeasonAccountOrderScopeIntegrity(this.prisma, {
        tradingAccountId: account.id,
        seasonParticipantId: account.seasonParticipant?.id ?? null,
      });
    }

    const order = await this.prisma.order.findFirst({
      where: {
        id: parsedOrderId,
        tradingAccountId: account.id,
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

  /**
   * Resolve an owned account into a mutation-grade trading context. General
   * accounts require their complete financial/performance foundation and no
   * season. Season accounts retain every existing season/participant gate.
   */
  private async resolveAccountTradingContext(
    userId: string,
    tradingAccountId: string,
    now: Date,
  ): Promise<TradingContext> {
    const account =
      await this.requireTradingAccountAccessService().getOwnedAccountOrThrow(
        userId,
        tradingAccountId.trim(),
      );

    return this.resolveAccountTradingContextForAccount(account, now);
  }

  private async resolveAccountTradingContextForAccount(
    account: OwnedTradingAccount,
    now: Date,
  ): Promise<TradingContext> {
    if (account.status !== TradingAccountStatus.active) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'TRADING_ACCOUNT_NOT_ACTIVE',
        'Trading account is not active',
      );
    }

    if (account.mode === TradingAccountMode.general) {
      await this.requireGeneralPerformanceService().assertGeneralAccountReady(
        account,
      );
      return {
        mode: TradingAccountMode.general,
        season: null,
        participant: null,
        tradingAccountId: account.id,
        feeRate: readGeneralTradeFeeRate(),
      };
    }

    if (!account.seasonParticipant) {
      this.throwTradingScopeIntegrityError(
        'TRADING_ACCOUNT_LINK_INTEGRITY',
        'Season trading account has no participant link.',
      );
    }

    const season = await this.prisma.season.findUnique({
      where: { id: account.seasonParticipant.season.id },
      select: {
        id: true,
        name: true,
        status: true,
        startAt: true,
        endAt: true,
        tradeFeeRate: true,
      },
    });

    if (!season) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'SEASON_NOT_ACTIVE',
        'Season is not active.',
      );
    }

    this.assertSeasonTradable(season, now);
    this.assertParticipantTradable(account.seasonParticipant.participantStatus);

    return {
      mode: TradingAccountMode.season,
      season,
      participant: {
        id: account.seasonParticipant.id,
        participantStatus: account.seasonParticipant.participantStatus,
        joinedAt: account.seasonParticipant.joinedAt,
        tradingAccountId: account.id,
      },
      tradingAccountId: account.id,
      feeRate: season.tradeFeeRate,
    };
  }

  /**
   * Serializes every general-account financial mutation, across both wallet
   * currencies, with external-funding boundaries and account status changes.
   * This exclusive per-account fence keeps ordinary TWR snapshots in commit
   * order even when concurrent trades touch different wallets. The row is
   * never created or repaired here.
   */
  private async lockGeneralTradingAccountInTransaction(
    tx: Prisma.TransactionClient,
    context: TradingContext,
  ): Promise<void> {
    if (context.mode !== TradingAccountMode.general) return;

    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        mode: TradingAccountMode;
        status: TradingAccountStatus;
      }>
    >`
      SELECT "id", "mode", "status"
      FROM "trading_accounts"
      WHERE "id" = ${context.tradingAccountId}
      FOR UPDATE
    `;
    const locked = rows[0];
    if (
      !locked ||
      locked.mode !== TradingAccountMode.general ||
      locked.status !== TradingAccountStatus.active
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'TRADING_ACCOUNT_NOT_ACTIVE',
        'Trading account is not active',
      );
    }

    const account = await tx.tradingAccount.findUnique({
      where: { id: context.tradingAccountId },
      select: {
        id: true,
        mode: true,
        initialCapitalKrw: true,
        seasonParticipant: { select: { id: true } },
      },
    });
    if (!account) {
      this.throwTradingScopeIntegrityError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'General trading account disappeared while creating an order.',
      );
    }
    await this.requireGeneralPerformanceService().assertGeneralAccountReady(
      account,
      tx,
    );
  }

  private async readTransactionWallClock(
    tx: Prisma.TransactionClient,
  ): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = rows[0]?.now;
    if (!now) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'ORDER_EXECUTION_TRANSACTION_FAILED',
        'Database transaction clock is unavailable.',
      );
    }
    return now;
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
    this.requireOrderTradingScope(order);
    if (order.tradingAccount?.status !== TradingAccountStatus.active) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'TRADING_ACCOUNT_NOT_ACTIVE',
        'Trading account is not active',
      );
    }
    if (order.tradingAccount?.mode === TradingAccountMode.season) {
      if (!order.seasonParticipant) {
        this.throwTradingScopeIntegrityError(
          'TRADING_ACCOUNT_SCOPE_MISMATCH',
          'Season order has no season participant.',
        );
      }
      this.assertSeasonTradable(order.seasonParticipant.season, executedAt);
      this.assertParticipantTradable(order.seasonParticipant.participantStatus);
    }
    this.assertOrderAssetTradable(order.asset, executedAt);

    if (order.orderType !== OrderType.market) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'LIMIT_ORDER_EXECUTION_PATH_NOT_SUPPORTED',
        'Limit orders cannot be executed through the order execute path.',
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
      order.tradingAccount?.mode === TradingAccountMode.general
        ? readGeneralTradeFeeRate()
        : (order.seasonParticipant?.season.tradeFeeRate ??
            this.throwTradingScopeIntegrityError(
              'TRADING_ACCOUNT_SCOPE_MISMATCH',
              'Season order has no fee source.',
            )),
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
      tradingAccountId: this.requireOrderTradingScope(order),
      assetId: order.assetId,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      limitPrice: order.orderType === OrderType.limit ? order.limitPrice : null,
      currencyCode: order.currencyCode,
    });

    // Account isolation: a quote minted under a different trading account is
    // never executable, even for the same user. NULL legacy quotes pass and
    // stay pinned to the participant + request hash below.
    if (
      quote.tradingAccountId !== this.requireOrderTradingScope(order) &&
      !(order.seasonParticipantId !== null && quote.tradingAccountId === null)
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_MISMATCH',
        'Quote does not match the submitted order.',
      );
    }

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
    // Verified account scope FIRST: the order's own scope, the participant
    // link, and (via the checks below) the wallet/position/quote must all
    // name the same trading account before any money moves.
    const tradingAccountId = this.requireOrderTradingScope(order);
    await this.consumeOrderQuoteInTransaction(tx, order, plan.executedAt);
    const wallet = await this.findCashWalletForExecution(
      tx,
      order.seasonParticipantId,
      order.currencyCode,
      tradingAccountId,
    );
    const netAmount = this.formatDecimal(plan.netAmount, monetaryScale);
    // Atomic available-balance debit: cash reserved by submitted limit-buy
    // orders is never spendable by a market buy, even under concurrency.
    const debitCount = await debitAvailableCash(tx, {
      walletId: wallet.id,
      seasonParticipantId: order.seasonParticipantId,
      tradingAccountId,
      currencyCode: order.currencyCode,
      amount: netAmount,
    });

    if (debitCount !== 1) {
      await this.throwCashDebitFailure(tx, {
        walletId: wallet.id,
        seasonParticipantId: order.seasonParticipantId,
        tradingAccountId,
        currencyCode: order.currencyCode,
        amount: plan.netAmount,
      });
    }

    const postWallet = await this.findCashWalletAfterUpdateOrThrow(tx, {
      walletId: wallet.id,
      seasonParticipantId: order.seasonParticipantId,
      currencyCode: order.currencyCode,
    });
    const positionId = await this.createOrUpdateBuyPosition(
      tx,
      order,
      plan,
      tradingAccountId,
    );
    const walletTransaction = await tx.walletTransaction.create({
      data: {
        seasonParticipantId: order.seasonParticipantId,
        tradingAccountId,
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
      tradingAccountId,
    );

    return {
      seasonId: order.seasonParticipant?.season.id ?? null,
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
    const tradingAccountId = this.requireOrderTradingScope(order);
    await this.consumeOrderQuoteInTransaction(tx, order, plan.executedAt);
    const position = await tx.position.findUnique({
      where:
        order.seasonParticipantId === null
          ? {
              tradingAccountId_assetId: {
                tradingAccountId,
                assetId: order.assetId,
              },
            }
          : {
              seasonParticipantId_assetId: {
                seasonParticipantId: order.seasonParticipantId,
                assetId: order.assetId,
              },
            },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
        quantity: true,
        reservedQuantity: true,
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

    // Never decrement another account's position: the position must carry
    // the SAME verified account scope as the order (null → repair first).
    this.assertPositionTradingScope(position, {
      seasonParticipantId: order.seasonParticipantId,
      tradingAccountId,
    });

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
        tradingAccountId,
        assetId: order.assetId,
        quantity: { gte: this.formatDecimal(order.quantity, monetaryScale) },
        reservedQuantity: {
          lte: this.formatDecimal(
            position.quantity.sub(order.quantity),
            monetaryScale,
          ),
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
      tradingAccountId,
    );
    const netAmount = this.formatDecimal(plan.netAmount, monetaryScale);
    const creditResult = await tx.cashWallet.updateMany({
      where: {
        id: wallet.id,
        seasonParticipantId: order.seasonParticipantId,
        tradingAccountId,
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
        tradingAccountId,
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
        tradingAccountId,
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
      tradingAccountId,
    );

    return {
      seasonId: order.seasonParticipant?.season.id ?? null,
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

    // Account-conditioned consume: only this participant's quote flips, and
    // only when its scope is the order's verified account (NULL legacy
    // quotes stay consumable — they were already pinned to the participant
    // and request hash by the execution-time validation).
    const result = await tx.quote.updateMany({
      where: {
        id: order.quoteId,
        status: QuoteStatus.active,
        seasonParticipantId: order.seasonParticipantId,
        ...(order.seasonParticipantId === null
          ? { tradingAccountId: this.requireOrderTradingScope(order) }
          : {
              OR: [
                { tradingAccountId: this.requireOrderTradingScope(order) },
                { tradingAccountId: null },
              ],
            }),
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
    seasonParticipantId: string | null,
    currencyCode: CurrencyCode,
    tradingAccountId: string,
  ) {
    const wallet = await tx.cashWallet.findUnique({
      where:
        seasonParticipantId === null
          ? {
              tradingAccountId_currencyCode: {
                tradingAccountId,
                currencyCode,
              },
            }
          : {
              seasonParticipantId_currencyCode: {
                seasonParticipantId,
                currencyCode,
              },
            },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
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

    // Null or mismatched wallet scope fails closed (500) BEFORE any debit
    // or credit — never auto-backfilled mid-trade.
    return assertCashWalletTradingAccountScope(wallet, {
      seasonParticipantId,
      tradingAccountId,
    });
  }

  private async findCashWalletAfterUpdateOrThrow(
    tx: OrderExecuteTransactionClient,
    input: {
      walletId: string;
      seasonParticipantId: string | null;
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

  /**
   * Market-buy debit failure. The shared diagnosis re-reads the wallet by id
   * alone, so a corrupted scope raises its own 500 (repair-required /
   * mismatch) instead of hiding behind INSUFFICIENT_BALANCE or CONFLICT.
   */
  private async throwCashDebitFailure(
    tx: OrderExecuteTransactionClient,
    input: {
      walletId: string;
      seasonParticipantId: string | null;
      tradingAccountId: string;
      currencyCode: CurrencyCode;
      amount: Prisma.Decimal;
    },
  ): Promise<never> {
    const reason = await diagnoseCashWalletMutationFailure(tx, {
      walletId: input.walletId,
      expected: {
        seasonParticipantId: input.seasonParticipantId,
        tradingAccountId: input.tradingAccountId,
        currencyCode: input.currencyCode,
      },
      requires: { available: input.amount },
    });

    if (reason === 'wallet_not_found') {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_BALANCE',
        'Order cash wallet was not found.',
      );
    }

    if (reason !== 'conflict') {
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

  /** Market-sell credit failure; same scope-visible diagnosis as the debit. */
  private async throwCashCreditFailure(
    tx: OrderExecuteTransactionClient,
    input: {
      walletId: string;
      seasonParticipantId: string | null;
      tradingAccountId: string;
      currencyCode: CurrencyCode;
    },
  ): Promise<never> {
    const reason = await diagnoseCashWalletMutationFailure(tx, {
      walletId: input.walletId,
      expected: {
        seasonParticipantId: input.seasonParticipantId,
        tradingAccountId: input.tradingAccountId,
        currencyCode: input.currencyCode,
      },
      // A credit has no amount guard: only scope can fail it.
    });

    if (reason === 'wallet_not_found') {
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
    tradingAccountId: string,
  ): Promise<string> {
    const position = await tx.position.findUnique({
      where:
        order.seasonParticipantId === null
          ? {
              tradingAccountId_assetId: {
                tradingAccountId,
                assetId: order.assetId,
              },
            }
          : {
              seasonParticipantId_assetId: {
                seasonParticipantId: order.seasonParticipantId,
                assetId: order.assetId,
              },
            },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
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
          tradingAccountId,
          assetId: order.assetId,
          quantity: this.formatDecimal(order.quantity, monetaryScale),
          reservedQuantity: ZERO_MONEY,
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

    // A null or foreign account scope on the existing position fails the
    // whole execution (repair first) — never auto-adopted mid-trade.
    this.assertPositionTradingScope(position, {
      seasonParticipantId: order.seasonParticipantId,
      tradingAccountId,
    });

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
        tradingAccountId,
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
    seasonParticipantId: string | null,
    capturedAt: Date,
    /** The order's ALREADY-VERIFIED account scope (작업 7 dual-write). */
    tradingAccountId: string,
  ): Promise<string | null> {
    if (seasonParticipantId === null) {
      const account = await tx.tradingAccount.findUnique({
        where: { id: tradingAccountId },
        select: {
          id: true,
          mode: true,
          initialCapitalKrw: true,
          seasonParticipant: { select: { id: true } },
        },
      });
      if (!account || account.mode !== TradingAccountMode.general) {
        this.throwTradingScopeIntegrityError(
          'TRADING_ACCOUNT_SCOPE_MISMATCH',
          'General order snapshot account is missing or has the wrong mode.',
        );
      }
      return this.requireGeneralPerformanceService().createOrdinarySnapshotInTransaction(
        {
          account,
          reason: SnapshotReason.order_executed,
          capturedAt,
          client: tx,
        },
      );
    }

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
        // 작업 7 dual-write. The account was already verified against the
        // order and the participant link earlier in this transaction, so it
        // is passed down rather than re-queried.
        tradingAccountId,
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
      seasonParticipantId: string | null;
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
        tradingAccountId: this.requireOrderTradingScope(order),
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
    const tradingAccountId =
      this.requireParticipantTradingAccountId(participant);

    return this.buildOrderQuoteForContext({
      mode: TradingAccountMode.season,
      season,
      participant,
      tradingAccountId,
      feeRate: season.tradeFeeRate,
      request,
      quoteAt,
      sourceWorkflow,
    });
  }

  private async buildOrderQuoteForContext(
    input: TradingContext & {
      request: ParsedOrderRequest;
      quoteAt: Date;
      sourceWorkflow: OrderQuoteSourceWorkflow;
    },
  ): Promise<OrderQuoteCalculation> {
    const { participant, tradingAccountId, request, quoteAt, sourceWorkflow } =
      input;
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
      grossAmount.mul(input.feeRate),
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
      participantId: participant?.id ?? null,
      tradingAccountId,
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
      context: {
        mode: input.mode,
        season: input.season,
        participant,
        tradingAccountId,
        feeRate: input.feeRate,
      },
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
      seasonParticipantId: quote.context.participant?.id ?? null,
      tradingAccountId: quote.context.tradingAccountId,
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
        seasonParticipantId: quote.context.participant?.id ?? null,
        // Dual-write: quote rows always carry the verified account. Every
        // producer of OrderQuoteCalculation resolves the link fail-closed
        // (requireParticipantTradingAccountId) before reaching here.
        tradingAccountId: quote.context.tradingAccountId,
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
          : quote.limitSellBasis
            ? formatDecimalScale(
                quote.limitSellBasis.quotedFeeRate,
                feeRateScale,
              )
            : null,
        quotedGrossAmount: quote.limitReservationBasis
          ? this.formatDecimal(
              quote.limitReservationBasis.quotedGrossAmount,
              monetaryScale,
            )
          : quote.limitSellBasis
            ? this.formatDecimal(
                quote.limitSellBasis.quotedGrossAmount,
                monetaryScale,
              )
            : null,
        quotedFeeAmount: quote.limitReservationBasis
          ? this.formatDecimal(
              quote.limitReservationBasis.quotedFeeAmount,
              monetaryScale,
            )
          : quote.limitSellBasis
            ? this.formatDecimal(
                quote.limitSellBasis.quotedFeeAmount,
                monetaryScale,
              )
            : null,
        quotedReservedAmount: quote.limitReservationBasis
          ? this.formatDecimal(
              quote.limitReservationBasis.quotedReservedAmount,
              monetaryScale,
            )
          : null,
        quotedNetAmount: quote.limitSellBasis
          ? this.formatDecimal(
              quote.limitSellBasis.quotedNetAmount,
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
        quotedNetAmount: true,
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
    const persistedSellBasis =
      durableQuote.quotedFeeRate &&
      durableQuote.quotedGrossAmount &&
      durableQuote.quotedFeeAmount &&
      durableQuote.quotedNetAmount
        ? {
            quotedFeeRate: durableQuote.quotedFeeRate,
            quotedGrossAmount: durableQuote.quotedGrossAmount,
            quotedFeeAmount: durableQuote.quotedFeeAmount,
            quotedNetAmount: durableQuote.quotedNetAmount,
          }
        : undefined;

    return {
      ...quote,
      ...(persistedBasis ? { limitReservationBasis: persistedBasis } : {}),
      ...(persistedSellBasis ? { limitSellBasis: persistedSellBasis } : {}),
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
      seasonParticipantId: string | null;
      tradingAccountId: string;
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
        tradingAccountId: true,
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
        quotedNetAmount: true,
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

    // Account isolation: a quote minted under a different trading account
    // cannot back an order create on this account. NULL legacy quotes pass
    // and stay pinned to the participant + request hash below.
    if (
      quote.tradingAccountId !== input.tradingAccountId &&
      !(input.seasonParticipantId !== null && quote.tradingAccountId === null)
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_MISMATCH',
        'Quote does not match the order create request.',
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
      tradingAccountId: input.tradingAccountId,
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

  /**
   * QUOTE-scoped idempotent-create lookup, used by the replay-first step of
   * limit Create.
   *
   * WHY THE QUOTE AND NOT THE KEY ALONE
   * -----------------------------------
   * The durable uniqueness the database actually enforces on
   * `idempotencyKey` is `(seasonParticipantId, idempotencyKey)` — a key is
   * unique WITHIN a season participation, not across a user's lifetime. A
   * lookup scoped to `(userId, idempotencyKey)` was therefore strictly WIDER
   * than the constraint it was replaying, and had to break the tie itself
   * (newest first). A client that reuses one key across two seasons — which
   * the schema permits — would then have its season-1 retry resolved to the
   * season-2 order and answered with ORDER_IDEMPOTENCY_CONFLICT, even though
   * both requests were individually valid.
   *
   * `Order.quoteId` is UNIQUE, and a limit Create always carries a durable
   * quote that is user-scoped and consumed exactly once. Keying the lookup on
   * it makes the replay scope EQUAL to a real database uniqueness constraint
   * instead of wider than one, resolves to the caller's own order in the
   * season that order belongs to, and needs no active-season read — so a
   * replay still works after the season ended.
   *
   * OWNERSHIP IS PART OF THE QUERY, not an application-side comparison on a
   * row fetched by quoteId alone. The old shape loaded whatever order held
   * the quoteId — another user's included — and answered a mismatched owner
   * with an immediate ORDER_IDEMPOTENCY_CONFLICT, while a quoteId that
   * matched no order fell through to the ordinary create gates. That
   * difference let a caller probe whether someone ELSE's quoteId had been
   * consumed. With the relation filter, another user's consumed quote and a
   * quoteId that never existed both return null here and proceed through the
   * SAME gates to the same user-scoped quote lookup (QUOTE_NOT_FOUND for
   * both) — no other user's row is ever read into this process, let alone
   * replayed.
   *
   * For the caller's OWN consumed quote, everything they asserted must still
   * match; anything else is a conflict rather than a silent new create:
   *   - a market order on that quote
   *   - the same quote presented under a different idempotencyKey
   * The request-hash comparison then happens in replayIdempotentCreateOrder,
   * exactly as on the participant-scoped path.
   */
  private async findIdempotentCreateOrderForQuote(input: {
    userId: string;
    quoteId: string;
    idempotencyKey: string;
    expectedOrderType: OrderType;
  }) {
    const order = await this.prisma.order.findFirst({
      where: {
        quoteId: input.quoteId,
        OR: [
          { seasonParticipant: { userId: input.userId } },
          { tradingAccount: { userId: input.userId } },
        ],
      },
      select: {
        ...IDEMPOTENT_CREATE_ORDER_SELECT,
        idempotencyKey: true,
      },
    });

    if (!order) return null;

    if (
      order.orderType !== input.expectedOrderType ||
      order.idempotencyKey !== input.idempotencyKey
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_IDEMPOTENCY_CONFLICT',
        'This quote was already used by a different order create request.',
      );
    }

    return order;
  }

  /**
   * Account-first idempotent-create lookup. The DB uniqueness this replays
   * is (tradingAccountId, idempotencyKey); the same user may reuse a key on
   * a DIFFERENT account without colliding. When the account has no row, a
   * LEGACY null-scope order (written before the trading-scope transition) is
   * still replayable — but only one pinned to the same participant AND the
   * same user, so no other season's or user's order is ever selected.
   */
  private async findIdempotentCreateOrder(input: {
    tradingAccountId: string;
    /**
     * Null for a general account (no participant exists), which simply skips
     * the legacy null-scope fallback — a general account has no legacy rows.
     */
    seasonParticipantId: string | null;
    userId: string;
    idempotencyKey: string;
  }) {
    const accountOrder = await this.prisma.order.findFirst({
      where: {
        tradingAccountId: input.tradingAccountId,
        idempotencyKey: input.idempotencyKey,
      },
      select: IDEMPOTENT_CREATE_ORDER_SELECT,
    });

    if (accountOrder) {
      return accountOrder;
    }

    if (!input.seasonParticipantId) {
      return null;
    }

    return this.prisma.order.findFirst({
      where: {
        seasonParticipantId: input.seasonParticipantId,
        idempotencyKey: input.idempotencyKey,
        tradingAccountId: null,
        seasonParticipant: { userId: input.userId },
      },
      select: IDEMPOTENT_CREATE_ORDER_SELECT,
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

    // Limit-order creates always persist their payload in the same
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
            reservedQuantity: this.formatNullableDecimal(
              order.reservedQuantity,
              quantityScale,
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
    participantId: string | null;
    tradingAccountId: string;
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
        where:
          input.participantId === null
            ? {
                tradingAccountId_currencyCode: {
                  tradingAccountId: input.tradingAccountId,
                  currencyCode: input.currencyCode,
                },
              }
            : {
                seasonParticipantId_currencyCode: {
                  seasonParticipantId: input.participantId,
                  currencyCode: input.currencyCode,
                },
              },
        select: {
          id: true,
          seasonParticipantId: true,
          tradingAccountId: true,
          balanceAmount: true,
          reservedAmount: true,
        },
      });

      // Scope before balance: an unscoped/mis-scoped wallet must never be
      // the balance basis of a quote (500 repair-required/mismatch).
      if (wallet) {
        assertCashWalletTradingAccountScope(wallet, {
          seasonParticipantId: input.participantId,
          tradingAccountId: input.tradingAccountId,
        });
      }

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
        where:
          input.participantId === null
            ? {
                tradingAccountId_assetId: {
                  tradingAccountId: input.tradingAccountId,
                  assetId: input.assetId,
                },
              }
            : {
                seasonParticipantId_assetId: {
                  seasonParticipantId: input.participantId,
                  assetId: input.assetId,
                },
              },
        select: {
          seasonParticipantId: true,
          tradingAccountId: true,
          quantity: true,
        },
      });

      if (position) {
        this.assertPositionTradingScope(position, {
          seasonParticipantId: input.participantId,
          tradingAccountId: input.tradingAccountId,
        });
      }

      return {
        walletBalanceBefore: wallet.balanceAmount,
        positionQuantityBefore: position?.quantity ?? new Prisma.Decimal(0),
      };
    }

    const position = await this.prisma.position.findUnique({
      where:
        input.participantId === null
          ? {
              tradingAccountId_assetId: {
                tradingAccountId: input.tradingAccountId,
                assetId: input.assetId,
              },
            }
          : {
              seasonParticipantId_assetId: {
                seasonParticipantId: input.participantId,
                assetId: input.assetId,
              },
            },
      select: {
        seasonParticipantId: true,
        tradingAccountId: true,
        quantity: true,
        reservedQuantity: true,
      },
    });

    if (position) {
      this.assertPositionTradingScope(position, {
        seasonParticipantId: input.participantId,
        tradingAccountId: input.tradingAccountId,
      });
    }

    if (
      !position ||
      position.quantity
        .sub(position.reservedQuantity ?? new Prisma.Decimal(0))
        .lt(input.quantity)
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_QUANTITY',
        'Position quantity is insufficient.',
      );
    }

    const wallet = await this.prisma.cashWallet.findUnique({
      where:
        input.participantId === null
          ? {
              tradingAccountId_currencyCode: {
                tradingAccountId: input.tradingAccountId,
                currencyCode: input.currencyCode,
              },
            }
          : {
              seasonParticipantId_currencyCode: {
                seasonParticipantId: input.participantId,
                currencyCode: input.currencyCode,
              },
            },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
        balanceAmount: true,
      },
    });

    if (wallet) {
      assertCashWalletTradingAccountScope(wallet, {
        seasonParticipantId: input.participantId,
        tradingAccountId: input.tradingAccountId,
      });
    }

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
        tradingAccountId: true,
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
      season: quote.context.season
        ? this.formatSeason(quote.context.season)
        : null,
      participant: quote.context.participant
        ? this.formatParticipant(quote.context.participant)
        : null,
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
      feeRate: formatDecimalScale(quote.context.feeRate, feeRateScale),
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

  /**
   * Transitional dual-write guard: every writer needs the participant's
   * trading-account link. A null link is a deploy-boundary state that must
   * be repaired (trading-accounts:repair-links) — never silently spread
   * onto new orders/quotes/positions/ledger rows.
   */
  private requireParticipantTradingAccountId(participant: {
    tradingAccountId: string | null;
  }): string {
    if (!participant.tradingAccountId) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'TRADING_ACCOUNT_LINK_INTEGRITY',
        'Participant has no trading account link; run trading-accounts:repair-links.',
      );
    }

    return participant.tradingAccountId;
  }

  /**
   * Execution-time scope resolution for an existing order: the order's OWN
   * tradingAccountId must exist (else the trading-scope repair has to run
   * first) and must equal the participant's link. Only then may wallets,
   * positions, quotes, and ledger rows be touched under that account.
   */
  private requireOrderTradingScope(order: {
    tradingAccountId: string | null;
    seasonParticipantId?: string | null;
    seasonParticipant: { id?: string; tradingAccountId: string | null } | null;
    tradingAccount: {
      id: string;
      mode: TradingAccountMode;
      seasonParticipant: { id: string } | null;
    } | null;
  }): string {
    if (!order.tradingAccountId) {
      this.throwTradingScopeIntegrityError(
        'TRADING_SCOPE_REPAIR_REQUIRED',
        'Order has no trading account scope; run trading-accounts:repair-trading-scope.',
      );
    }

    if (
      !order.tradingAccount ||
      order.tradingAccount.id !== order.tradingAccountId
    ) {
      this.throwTradingScopeIntegrityError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Order trading-account relation does not match its account scope.',
      );
    }

    if (order.tradingAccount.mode === TradingAccountMode.general) {
      if (
        order.seasonParticipantId !== null ||
        order.seasonParticipant !== null ||
        order.tradingAccount.seasonParticipant !== null
      ) {
        this.throwTradingScopeIntegrityError(
          'TRADING_ACCOUNT_SCOPE_MISMATCH',
          'General order carries a season participant link.',
        );
      }
      return order.tradingAccountId;
    }

    const participantAccountId = order.seasonParticipant?.tradingAccountId;
    if (!participantAccountId) {
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'TRADING_ACCOUNT_LINK_INTEGRITY',
        'Season order has no valid participant account link; run trading-accounts:repair-links.',
      );
    }

    if (
      order.seasonParticipantId === null ||
      order.seasonParticipant?.id !== order.seasonParticipantId ||
      order.tradingAccount.seasonParticipant?.id !==
        order.seasonParticipantId ||
      order.tradingAccountId !== participantAccountId
    ) {
      this.throwTradingScopeIntegrityError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Season order participant and trading-account scope do not agree.',
      );
    }

    return order.tradingAccountId;
  }

  /**
   * A position touched by an execution must carry the same verified account
   * scope as the order. Null → repair first; mismatch → corruption. Never
   * auto-adopted or overwritten mid-trade.
   */
  private assertPositionTradingScope(
    position: {
      seasonParticipantId: string | null;
      tradingAccountId: string | null;
    },
    expected: {
      seasonParticipantId: string | null;
      tradingAccountId: string;
    },
  ): void {
    if (position.seasonParticipantId !== expected.seasonParticipantId) {
      this.throwTradingScopeIntegrityError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Position belongs to a different season participant.',
      );
    }

    if (position.tradingAccountId == null) {
      this.throwTradingScopeIntegrityError(
        'TRADING_SCOPE_REPAIR_REQUIRED',
        'Position has no trading account scope; run trading-accounts:repair-trading-scope.',
      );
    }

    if (position.tradingAccountId !== expected.tradingAccountId) {
      this.throwTradingScopeIntegrityError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Position belongs to a different trading account.',
      );
    }
  }

  private throwTradingScopeIntegrityError(
    code: string,
    message: string,
  ): never {
    this.throwApiError(HttpStatus.INTERNAL_SERVER_ERROR, code, message);
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

  /**
   * Server-authoritative execution policy on quote/create responses. Automatic
   * matching is on only when BOTH the limit-order feature and the scheduler
   * matching job are enabled. When on, submitted orders are filled by the
   * scheduler matcher: path A at a fresh provider snapshot price, path B at the
   * order's limit price off a closed 5m candle touch. Never a live-exchange
   * order — the client must not imply guaranteed exchange execution.
   */
  private limitOrderExecutionPolicy(): LimitOrderExecutionPolicy {
    return buildLimitOrderExecutionPolicy({
      autoExecutionEnabled:
        isLimitOrderEnabled() && readLimitOrderMatchingConfig().matchingEnabled,
    });
  }

  /**
   * Reuses the market-buy post-fill portfolio snapshot verbatim for a limit
   * fill, so both leave identical equity-snapshot and position valuation. Thin
   * public wrapper over the private market path; called only by the limit-order
   * execution service inside its fill transaction.
   */
  async recordOrderExecutedPortfolioSnapshotInTransaction(
    tx: Prisma.TransactionClient,
    seasonParticipantId: string | null,
    capturedAt: Date,
    /** The fill's verified account scope (작업 7 dual-write). */
    tradingAccountId: string,
  ): Promise<string | null> {
    return this.recordOrderExecutedPortfolioSnapshot(
      tx,
      seasonParticipantId,
      capturedAt,
      tradingAccountId,
    );
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
