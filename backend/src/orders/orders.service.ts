import { isFuturesOnlyAsset } from '../providers/binance/binance-product-catalog';
import { isStandaloneAccountMode } from '../trading-accounts/account-mode-policy';
import { createApiError } from '../common/api-error';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { futuresSnapshotValues } from '../portfolio/futures-snapshot-values';
import {
  assertPendingChild,
  prepareSpotProtection,
  reconcileSpotProtection,
} from '../conditional/conditional-state';
import {
  parseProtectionLegs,
  type ProtectionLegInput,
} from '../conditional/conditional-policy';
import { createProtectionInTransaction } from '../conditional/conditional-registration';
import {
  buildSelectionFailureEvidence,
  describeManualFallback,
} from '../providers/source-selection-diagnostics';
import { MarketExecutionEvidenceAdapter } from './market-execution-evidence.adapter';
import { decideMarketExecution } from './market-execution.policy';
import { MARKET_EXECUTION_SELECT } from './order-response.presenter';
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
  WalletScope,
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
import {
  isFxSnapshotStale,
  fxExecuteSnapshotFreshnessThresholdMs,
} from '../fx/fx-execute-snapshot-policy';
import {
  calculatePortfolioValuation,
  calculatePositionValuation,
  isFxSnapshotStaleForPortfolioValuation,
  PortfolioValuationError,
  type PortfolioAssetPriceSnapshotInput,
  type PortfolioFxRateSnapshotInput,
} from '../portfolio/portfolio-valuation.policy';
import { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
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
import { assertAccountOrderScopeIntegrity } from '../trading-accounts/trading-account-financial-integrity';
import {
  newOrderCashWalletScope,
  requireOrderCashWalletScope,
} from './order-cash-wallet-policy';
import { debitAvailableCash } from '../wallets/cash-wallet-atomic';
import { diagnoseCashWalletMutationFailure } from '../wallets/cash-wallet-failure-diagnosis';
import { assertCashWalletTradingAccountScope } from '../wallets/cash-wallet-scope';
import { readGeneralTradeFeeRate } from './general-trading.config';
import {
  assertOrderSessionAllowed,
  MarketHoursError,
} from './market-hours.policy';
import {
  assertOrderInputPolicy,
  quantityFromBuyAmount,
} from './order-input-policy';
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
import { findUsdKrwProviderSnapshotCandidates } from '../providers/fx-rate-snapshot-query';
import { UsdKrwRefreshService } from '../providers/usd-krw-refresh.service';
import {
  closedMarketPriceScope,
  findMarketAwareAssetPriceCandidates,
} from '../providers/asset-price-snapshot-query';
import {
  recordAdminDiagnosticEvent,
  setAdminDiagnosticContext,
  preserveAdminFailureCause,
} from '../common/admin-diagnostics';
import {
  diagnosePositionMutationFailure,
  positionAvailabilityEvidence,
} from './position-failure-diagnosis';
import {
  resolveCalendarMarket,
  resolveStockMarketSessionState,
} from './market-calendar.policy';
import { getMarketSessionOverrideRuntimeStatus } from './market-calendar/market-session-override.store';

export type OrdersQuery = {
  seasonId?: string;
  status?: string;
  side?: string;
  assetId?: string;
  limit?: string;
  offset?: string;
};

export type OrderRequestBody = {
  attachedProtection?: unknown;
  assetId?: unknown;
  side?: unknown;
  orderType?: unknown;
  quantity?: unknown;
  amount?: unknown;
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
  tradingAccountId: string;
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
  /** Internal worker capability, never parsed from HTTP. */
  protectionChildId?: string;
  attachedProtection?: ProtectionLegInput[];
  assetId: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: Prisma.Decimal | null;
  amount: Prisma.Decimal | null;
  limitPrice: Prisma.Decimal | null;
  currencyCode?: CurrencyCode;
};

type PricedOrderRequest = ParsedOrderRequest & { quantity: Prisma.Decimal };

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
  cashWalletScope: WalletScope;
  context: TradingContext;
  asset: OrderAsset;
  request: PricedOrderRequest;
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
  cashWalletScope: WalletScope;
  id: string;
  tradingAccountId: string;
  status: QuoteStatus;
  assetId: string | null;
  side: OrderSide | null;
  orderType: OrderType | null;
  quantity: Prisma.Decimal;
  sourceAmount: Prisma.Decimal | null;
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
  executedQuantity?: Prisma.Decimal | null;
  canceledQuantity?: Prisma.Decimal | null;
  requestedAmount?: Prisma.Decimal | null;
  unspentAmount?: Prisma.Decimal | null;
  cancelReason?: string | null;
  responsePayloadJson?: Prisma.JsonValue | null;
  id: string;
  tradingAccountId: string;
  assetId: string;
  quoteId: string | null;
  side: OrderSide;
  orderType: OrderType;
  status: OrderStatus;
  quantity: Prisma.Decimal;
  limitPrice: Prisma.Decimal | null;
  executedPrice: Prisma.Decimal | null;
  currencyCode: CurrencyCode;
  cashWalletScope: WalletScope;
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
    isActive: boolean;
    currencyCode: CurrencyCode;
    priceCurrency: CurrencyCode;
    settlementCurrency: CurrencyCode;
  };
  quote: {
    id: string;
    userId: string;
    tradingAccountId: string;
    status: QuoteStatus;
    assetId: string | null;
    side: OrderSide | null;
    orderType: OrderType | null;
    quantity: Prisma.Decimal | null;
    sourceAmount: Prisma.Decimal | null;
    limitPrice: Prisma.Decimal | null;
    currencyCode: CurrencyCode | null;
    cashWalletScope: WalletScope | null;
    quotedPrice: Prisma.Decimal | null;
    quotedFeeRate: Prisma.Decimal | null;
    quotedRate: Prisma.Decimal | null;
    maxChangeBps: Prisma.Decimal;
    expiresAt: Date;
    requestHash: string;
  } | null;
  tradingAccount: {
    id: string;
    userId: string;
    mode: TradingAccountMode;
    status: TradingAccountStatus;
    initialCapitalKrw: Prisma.Decimal;
    seasonParticipant: {
      id: string;
      participantStatus: ParticipantStatus;
      joinedAt: Date;
      tradingAccountId: string;
      season: ActiveOrderSeason;
    } | null;
  } | null;
};

type OrderExecutionPlan = {
  marketExecution?: ReturnType<typeof decideMarketExecution>;
  quantity: Prisma.Decimal;
  executedAt: Date;
  executedPrice: Prisma.Decimal;
  quotedPrice: Prisma.Decimal;
  priceChangeBps: Prisma.Decimal | null;
  grossAmount: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  netAmount: Prisma.Decimal;
  assetPriceSnapshotId: string | null;
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
  ...MARKET_EXECUTION_SELECT,
  responsePayloadJson: true,
  id: true,
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
  cashWalletScope: true,
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
      isActive: true,
      currencyCode: true,
      priceCurrency: true,
      settlementCurrency: true,
    },
  },
  quote: {
    select: {
      id: true,
      userId: true,
      tradingAccountId: true,
      status: true,
      assetId: true,
      side: true,
      orderType: true,
      quantity: true,
      sourceAmount: true,
      limitPrice: true,
      currencyCode: true,
      cashWalletScope: true,
      quotedPrice: true,
      quotedFeeRate: true,
      quotedRate: true,
      maxChangeBps: true,
      expiresAt: true,
      requestHash: true,
    },
  },
  tradingAccount: {
    select: {
      id: true,
      userId: true,
      mode: true,
      status: true,
      initialCapitalKrw: true,
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
    },
  },
} as const;

/**
 * Everything the idempotent-create replay needs to return the stored first
 * response (or rebuild a faithful payload for rows predating
 * responsePayloadJson). Shared by the user-scoped replay-first lookup and the
 * account-scoped race-recovery lookup so the two can never drift.
 */
const IDEMPOTENT_CREATE_ORDER_SELECT = {
  ...MARKET_EXECUTION_SELECT,
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
  cashWalletScope: true,
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
    @Optional()
    private readonly marketExecutionEvidenceAdapter?: MarketExecutionEvidenceAdapter,
    @Optional()
    private readonly usdKrwRefreshService?: UsdKrwRefreshService,
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
    conditionalChildId?: string,
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
    if (conditionalChildId) {
      await assertPendingChild(
        this.prisma,
        conditionalChildId,
        tradingAccountId,
        'spot',
      );
      request.protectionChildId = conditionalChildId;
    }
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
    inputRequest: ParsedOrderRequest,
    quoteAt: Date,
    context: TradingContext,
  ): Promise<OrderQuoteResponse> {
    if (inputRequest.side === OrderSide.sell) {
      return this.quoteLimitSellOrderForContext(
        userId,
        inputRequest,
        quoteAt,
        context,
      );
    }
    const { tradingAccountId } = context;
    const limitOrderCreate = this.requireLimitOrderCreateService();
    if (!inputRequest.limitPrice) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        limitOrderErrorCodes.INVALID_LIMIT_PRICE,
        'limitPrice is required for limit orders.',
      );
    }

    const asset = await this.findUsableAsset(inputRequest.assetId);
    assertOrderInputPolicy(
      { ...inputRequest, assetType: asset.assetType },
      { positionBoundExit: !!inputRequest.protectionChildId },
    );
    const request: PricedOrderRequest = {
      ...inputRequest,
      quantity: inputRequest.amount
        ? quantityFromBuyAmount(inputRequest.amount, inputRequest.limitPrice)
        : inputRequest.quantity!,
    };
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
    // Confirmed CLOSED permits registration; an unknown calendar fails closed.
    this.assertOrderAssetTradable(asset, quoteAt, OrderType.limit);

    const settlementCurrency = this.getAssetSettlementCurrency(asset);
    const preview = await limitOrderCreate.buildLimitBuyQuotePreview({
      tradingAccountId,
      assetId: asset.id,
      currencyCode: settlementCurrency,
      walletScope: newOrderCashWalletScope(asset.assetType),
      limitPrice: request.limitPrice!,
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
      cashWalletScope: newOrderCashWalletScope(asset.assetType),
      context,
      asset,
      request,
      price: request.limitPrice!,
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
        limitPrice: this.formatDecimal(request.limitPrice!, monetaryScale),
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
    inputRequest: ParsedOrderRequest,
    quoteAt: Date,
    context: TradingContext,
  ): Promise<OrderQuoteResponse> {
    if (!inputRequest.limitPrice) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        limitOrderErrorCodes.INVALID_LIMIT_PRICE,
        'limitPrice is required for limit orders.',
      );
    }
    const asset = await this.findUsableAsset(inputRequest.assetId);
    assertOrderInputPolicy(
      { ...inputRequest, assetType: asset.assetType },
      { positionBoundExit: !!inputRequest.protectionChildId },
    );
    const request: PricedOrderRequest = {
      ...inputRequest,
      quantity: inputRequest.amount
        ? quantityFromBuyAmount(inputRequest.amount, inputRequest.limitPrice)
        : inputRequest.quantity!,
    };
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
    this.assertOrderAssetTradable(asset, quoteAt, OrderType.limit);
    const preview =
      await this.requireLimitOrderCreateService().buildLimitSellQuotePreview({
        tradingAccountId: context.tradingAccountId,
        assetId: asset.id,
        currencyCode: settlementCurrency,
        walletScope: newOrderCashWalletScope(asset.assetType),
        limitPrice: request.limitPrice!,
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
      cashWalletScope: newOrderCashWalletScope(asset.assetType),
      context,
      asset,
      request,
      price: request.limitPrice!,
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
        limitPrice: this.formatDecimal(request.limitPrice!, monetaryScale),
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
    // not visible here; it is caught by the account-scoped lookup
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
    conditionalChildId?: string,
  ): Promise<CreateOrderResponse | LimitOrderCreateResponse> {
    if (!userId) {
      this.throwApiError(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Unauthorized',
      );
    }

    const request = this.parseOrderRequest(body);
    request.protectionChildId = conditionalChildId;
    const submittedAt = new Date();

    if (request.orderType === OrderType.limit) {
      return this.createLimitBuyOrderForAccount(
        userId,
        tradingAccountId,
        body,
        request,
        conditionalChildId,
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
      context,
      conditionalChildId,
    });
  }

  private async createMarketOrderForContext(input: {
    conditionalChildId?: string;
    userId: string;
    request: ParsedOrderRequest;
    quoteId: string;
    idempotency: OrderCreateIdempotency;
    context: TradingContext;
  }): Promise<CreateOrderResponse | LimitOrderCreateResponse> {
    const { userId, request, quoteId, idempotency } = input;
    const { season, participant, tradingAccountId } = input.context;
    const existingOrder = await this.findIdempotentCreateOrder({
      tradingAccountId,
      idempotencyKey: idempotency.idempotencyKey,
    });

    if (existingOrder) {
      return this.replayIdempotentCreateOrder(existingOrder, idempotency);
    }

    try {
      if (this.usdKrwRefreshService) {
        // This read only identifies an owned, active USD quote. It is not a
        // gate: the locked transaction still resolves concurrent replay and
        // validates every quote/request/account fact at its own DB clock.
        const quote = await this.prisma.quote.findFirst({
          where: {
            id: quoteId,
            userId,
            tradingAccountId,
            quoteType: QuoteType.order,
            orderType: OrderType.market,
            status: QuoteStatus.active,
            assetId: request.assetId,
            side: request.side,
            expiresAt: { gte: new Date() },
          },
          select: { currencyCode: true },
        });
        if (quote?.currencyCode === CurrencyCode.USD) {
          await this.prepareOrderExecutionFx();
        }
      }
      let didExecute = false;
      const response = await this.prisma.$transaction(async (tx) => {
        // Quote serializes consumption and lets a waiter replay a committed
        // winner before any mutable authorization/time gate.
        await tx.$queryRaw`SELECT "id" FROM "quotes" WHERE "id" = ${quoteId} FOR UPDATE`;
        const racedOrder = await this.findIdempotentCreateOrder(
          {
            tradingAccountId,
            idempotencyKey: idempotency.idempotencyKey,
          },
          tx,
        );
        if (racedOrder)
          return this.replayIdempotentCreateOrder(racedOrder, idempotency);
        await this.lockTradingContextInTransaction(tx, input.context, userId);
        let transactionNow = await this.readTransactionWallClock(tx);
        await this.prepareProtection(
          tx,
          tradingAccountId,
          request,
          transactionNow,
          input.conditionalChildId,
        );
        transactionNow = await this.readTransactionWallClock(tx);
        const quote = await this.findActiveOrderQuoteForCreateOrThrow(tx, {
          quoteId,
          userId,
          seasonParticipantId: participant?.id ?? null,
          tradingAccountId,
          request,
          now: transactionNow,
        });
        this.assertOrderAssetTradable(quote.asset, transactionNow);

        const tradeFeeRate = this.resolveMarketOrderFeeRate({
          mode: input.context.mode,
          quotedFeeRate: quote.quotedFeeRate,
          currentFeeRate: input.context.feeRate,
        });
        const price = roundDecimalHalfUp(quote.quotedPrice, monetaryScale);
        const grossAmount = roundDecimalHalfUp(
          quote.quantity.mul(price),
          monetaryScale,
        );
        const feeAmount = roundDecimalHalfUp(
          grossAmount.mul(tradeFeeRate),
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
            tradingAccountId,
            assetId: quote.asset.id,
            quoteId: quote.id,
            side: request.side,
            orderType: OrderType.market,
            status: OrderStatus.submitted,
            quantity: this.formatDecimal(quote.quantity, quantityScale),
            limitPrice: null,
            executedPrice: null,
            currencyCode: this.getAssetSettlementCurrency(quote.asset),
            cashWalletScope: quote.cashWalletScope,
            grossAmount: this.formatDecimal(grossAmount, monetaryScale),
            feeAmount: this.formatDecimal(feeAmount, monetaryScale),
            netAmount: this.formatDecimal(netAmount, monetaryScale),
            assetPriceSnapshotId: quote.assetPriceSnapshotId,
            fxRateSnapshotId: quote.fxRateSnapshotId,
            idempotencyKey: idempotency.idempotencyKey,
            requestHash: idempotency.requestHash,
            submittedAt: transactionNow,
            executedAt: null,
            canceledAt: null,
            rejectedAt: null,
            rejectReason: null,
            createdAt: transactionNow,
            updatedAt: transactionNow,
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

        if (input.conditionalChildId)
          await tx.protectionChild.update({
            where: { id: input.conditionalChildId },
            data: { orderId },
          });
        const executionOrder = order as OrderExecutionRecord;
        this.assertExecutableSeasonAndAsset(executionOrder, transactionNow);
        const plan = await this.buildOrderExecutionPlan(
          tx,
          executionOrder,
          transactionNow,
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

        didExecute = true;
        return responsePayloadJson;
      });

      if (didExecute && season && participant) {
        this.refreshRankingAfterParticipantChange(season.id, participant.id);
      }

      return response;
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }

      const racedOrder = await this.findIdempotentCreateOrder({
        tradingAccountId,
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
    conditionalChildId?: string,
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
      conditionalChildId,
    });
  }

  private async createLimitBuyOrderForContext(input: {
    conditionalChildId?: string;
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
        // Quote → lifecycle authorization (Season → Account → Participant)
        // → reservation. See season-trading-lock for the current writer order.
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
        let transactionNow = await this.readTransactionWallClock(tx);
        await this.prepareProtection(
          tx,
          tradingAccountId,
          request,
          transactionNow,
          input.conditionalChildId,
        );
        transactionNow = await this.readTransactionWallClock(tx);
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
        this.assertOrderAssetTradable(
          quote.asset,
          transactionNow,
          OrderType.limit,
        );

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
            cashWalletScope: quote.cashWalletScope,
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
          tradingAccountId,
          quantity: quote.quantity,
          idempotency,
          submittedAt: transactionNow,
          autoExecutionEnabled:
            this.limitOrderExecutionPolicy().autoExecutionEnabled,
        };
        if (request.side === OrderSide.sell) {
          const response =
            await limitOrderCreate.createSubmittedLimitSellInTransaction(tx, {
              ...createInput,
              quote: {
                ...createInput.quote,
                quotedNetAmount: quote.quotedNetAmount,
              },
            });
          if (input.conditionalChildId)
            await tx.protectionChild.update({
              where: { id: input.conditionalChildId },
              data: { orderId: response.data.order.orderId },
            });
          return response;
        }
        const response =
          await limitOrderCreate.createSubmittedLimitBuyInTransaction(
            tx,
            createInput,
          );
        if (request.attachedProtection)
          await createProtectionInTransaction(tx, {
            accountId: tradingAccountId,
            domain: 'spot',
            assetId: request.assetId,
            parentOrderId: response.data.order.orderId,
            parentQuantity: quote.quantity,
            legs: request.attachedProtection,
            now: transactionNow,
          });
        return response;
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }

      // Two unique constraints can raise here and they mean different things.
      // `orders_quote_id_key` — the concurrent winner used the SAME quote, so
      // the quote-scoped lookup finds exactly the order this request wanted
      // and replays it. `(tradingAccountId, idempotencyKey)` — the key was reused with a
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
    try {
      if (this.usdKrwRefreshService) {
        const stored = await this.findOwnedOrderForExecution(
          this.prisma,
          parsedOrderId,
          userId,
        );
        if (stored?.orderType === OrderType.market) {
          if (stored.status === OrderStatus.executed) {
            return this.buildAlreadyExecutedOrderResponse(stored);
          }
          if (
            stored.status === OrderStatus.submitted &&
            this.getAssetSettlementCurrency(stored.asset) === CurrencyCode.USD
          ) {
            await this.prepareOrderExecutionFx();
          }
        }
      }
      const result = await this.prisma.$transaction(async (tx) => {
        let order = await this.findOwnedOrderForExecution(
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

        if (order.orderType !== OrderType.market) {
          this.throwApiError(
            HttpStatus.BAD_REQUEST,
            'LIMIT_ORDER_EXECUTION_PATH_NOT_SUPPORTED',
            'Limit orders cannot be executed through the order execute path.',
          );
        }
        if (order.status === OrderStatus.executed) {
          return this.buildAlreadyExecutedOrderResponse(order);
        }
        if (order.quoteId) {
          await tx.$queryRaw`SELECT "id" FROM "quotes" WHERE "id" = ${order.quoteId} FOR UPDATE`;
        }
        const committedAfterQuoteWait = await this.findOwnedOrderForExecution(
          tx,
          parsedOrderId,
          userId,
        );
        if (committedAfterQuoteWait?.status === OrderStatus.executed) {
          return this.buildAlreadyExecutedOrderResponse(
            committedAfterQuoteWait,
          );
        }
        const account = order.tradingAccount;
        this.requireOrderTradingScope(order);
        await this.lockTradingContextInTransaction(
          tx,
          {
            mode: account!.mode,
            tradingAccountId: order.tradingAccountId,
          },
          userId,
          account!.seasonParticipant?.id,
        );
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${parsedOrderId} FOR UPDATE`;
        order = await this.findOwnedOrderForExecution(
          tx,
          parsedOrderId,
          userId,
        );
        if (!order)
          this.throwApiError(
            HttpStatus.NOT_FOUND,
            'ORDER_NOT_FOUND',
            'Order not found.',
          );
        if (order.status === OrderStatus.executed)
          return this.buildAlreadyExecutedOrderResponse(order);
        await this.prepareProtection(
          tx,
          order.tradingAccountId,
          order,
          await this.readTransactionWallClock(tx),
        );
        const transactionNow = await this.readTransactionWallClock(tx);
        this.assertExecutableSeasonAndAsset(order, transactionNow);

        if (order.status !== OrderStatus.submitted) {
          setAdminDiagnosticContext({
            failureStage: 'order_state_validation',
            evidence: {
              orderGuard: {
                status: order.status,
                submitted: false,
                failureReason: 'order_not_submitted',
              },
            },
          });
          this.throwApiError(
            HttpStatus.CONFLICT,
            'ORDER_NOT_EXECUTABLE',
            'Only submitted orders can be executed.',
          );
        }

        const plan = await this.buildOrderExecutionPlan(
          tx,
          order,
          transactionNow,
        );

        const executionResult =
          order.side === OrderSide.buy
            ? await this.executeBuyOrderInTransaction(tx, order, plan)
            : await this.executeSellOrderInTransaction(tx, order, plan);
        if (plan.marketExecution) {
          await tx.order.update({
            where: { id: order.id },
            data: {
              responsePayloadJson: this.buildExecutedOrderResponse(
                executionResult,
              ) as unknown as Prisma.InputJsonValue,
            },
          });
        }
        return executionResult;
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
        error,
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
      tradingAccountId: participant.tradingAccountId,
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
          ...MARKET_EXECUTION_SELECT,
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
        tradingAccount: {
          userId,
          mode: TradingAccountMode.season,
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

    if (isStandaloneAccountMode(account.mode)) {
      await this.requireGeneralPerformanceService().assertGeneralAccountReady(
        account,
      );
    } else {
      await assertAccountOrderScopeIntegrity(this.prisma, {
        tradingAccountId: account.id,
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
          protectionChild: { select: { id: true } },
          side: true,
          orderType: true,
          status: true,
          ...MARKET_EXECUTION_SELECT,
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
        orders: orders.map((order) => ({
          ...this.formatOrder(order),
          conditionalChildId: order.protectionChild?.id ?? null,
        })),
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

    if (isStandaloneAccountMode(account.mode)) {
      await this.requireGeneralPerformanceService().assertGeneralAccountReady(
        account,
      );
    } else {
      await assertAccountOrderScopeIntegrity(this.prisma, {
        tradingAccountId: account.id,
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

    if (isStandaloneAccountMode(account.mode)) {
      await this.requireGeneralPerformanceService().assertGeneralAccountReady(
        account,
      );
      return {
        mode: account.mode,
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

  private async lockTradingContextInTransaction(
    tx: Prisma.TransactionClient,
    context: Pick<TradingContext, 'mode' | 'tradingAccountId'> & {
      participant?: TradingContext['participant'];
    },
    userId: string,
    participantId = context.participant?.id,
  ): Promise<void> {
    if (isStandaloneAccountMode(context.mode)) {
      await this.lockGeneralTradingAccountInTransaction(tx, context);
      return;
    }
    if (!participantId)
      this.throwTradingScopeIntegrityError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Season account has no participant.',
      );
    const locked = await lockSeasonTradingContext(tx, {
      userId,
      seasonParticipantId: participantId,
    });
    if (locked.account.id !== context.tradingAccountId) {
      this.throwTradingScopeIntegrityError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Participant trading account changed during execution.',
      );
    }
    // Final status/window checks use freshly read relations after these locks.
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
    context: Pick<TradingContext, 'mode' | 'tradingAccountId'>,
  ): Promise<void> {
    if (!isStandaloneAccountMode(context.mode)) return;

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
      !isStandaloneAccountMode(locked.mode) ||
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
        tradingAccount: { userId },
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
      const participant = order.tradingAccount.seasonParticipant;
      if (!participant) {
        this.throwTradingScopeIntegrityError(
          'TRADING_ACCOUNT_SCOPE_MISMATCH',
          'Season order has no season participant.',
        );
      }
      this.assertSeasonTradable(participant.season, executedAt);
      this.assertParticipantTradable(participant.participantStatus);
    }
    if (!order.asset.isActive || isFuturesOnlyAsset(order.asset))
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ASSET_NOT_TRADABLE',
        'Asset is not active.',
      );
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
    const marketExecution = this.marketExecutionEvidenceAdapter
      ? decideMarketExecution(
          this.marketExecutionEvidenceAdapter,
          {
            assetId: order.assetId,
            assetType: order.asset.assetType,
            market: order.asset.market,
            priceCurrency: this.getAssetPriceCurrency(order.asset),
            quantityUnit:
              order.asset.assetType === AssetType.crypto
                ? 'base_asset'
                : 'share',
            side: order.side,
            executedAt,
          },
          { quantity: order.quantity, amount: quote.sourceAmount },
        )
      : undefined;
    const priceContext = marketExecution
      ? {
          price: marketExecution.price,
          assetPriceSnapshotId: null,
          assetPriceSource: null,
        }
      : await this.resolveProviderExecutionPrice(tx, order, quote, executedAt);
    // Apply the existing quote-change guard to the FINAL price, including VWAP.
    const priceChangeBps = calculateChangeBps(
      quote.quotedPrice,
      priceContext.price,
    );
    if (priceChangeBps.gt(quote.maxChangeBps)) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'RATE_CHANGED_REQUOTE_REQUIRED',
        'Order price changed; requote is required.',
      );
    }
    const tradeFeeRate = this.resolveMarketOrderFeeRate({
      mode: order.tradingAccount?.mode,
      quotedFeeRate: quote.quotedFeeRate,
      currentFeeRate:
        order.tradingAccount?.seasonParticipant?.season.tradeFeeRate ??
        (isStandaloneAccountMode(order.tradingAccount?.mode)
          ? null
          : this.throwTradingScopeIntegrityError(
              'TRADING_ACCOUNT_SCOPE_MISMATCH',
              'Season order has no fee source.',
            )),
    });
    const quantity =
      marketExecution?.quantity ??
      (quote.sourceAmount
        ? quantityFromBuyAmount(quote.sourceAmount, priceContext.price)
        : order.quantity);
    const grossAmount =
      marketExecution?.grossAmount ??
      roundDecimalHalfUp(quantity.mul(priceContext.price), monetaryScale);
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
      quantity,
      executedAt,
      executedPrice: priceContext.price,
      quotedPrice: quote.quotedPrice,
      priceChangeBps,
      marketExecution,
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

  private async prepareProtection(
    tx: Prisma.TransactionClient,
    accountId: string,
    request: Pick<ParsedOrderRequest, 'assetId' | 'side' | 'orderType'>,
    now: Date,
    childId?: string,
  ) {
    await prepareSpotProtection(
      tx,
      { accountId, ...request, now, childId },
      (orderId) =>
        this.requireLimitOrderCancelService().cancelConditionalChildInTransaction(
          tx,
          orderId,
          'conditional_manual_reduce',
          now,
        ),
    );
  }

  /** Worker-only adapter. Quotes/ERS/fees/settlement remain the user Order core. */
  async executeConditionalExit(
    userId: string,
    accountId: string,
    childId: string,
  ) {
    const child = await this.prisma.protectionChild.findUnique({
      where: { id: childId },
      include: { group: { include: { position: true } }, leg: true },
    });
    if (
      !child ||
      child.status !== 'pending' ||
      child.orderId ||
      child.group.status !== 'active' ||
      child.group.tradingAccountId !== accountId ||
      child.group.domain !== 'spot'
    )
      return;
    const quantity = child.group.position?.quantity;
    if (!quantity?.gt(0)) return;
    const request: OrderRequestBody = {
      assetId: child.group.assetId,
      side: 'sell',
      orderType: child.leg.childOrderType,
      quantity: quantity.toFixed(8),
      ...(child.leg.childLimitPrice
        ? { limitPrice: child.leg.childLimitPrice.toFixed(8) }
        : {}),
    };
    const quote = await this.quoteOrderForTradingAccount(
      userId,
      accountId,
      request,
      childId,
    );
    return this.createOrderForTradingAccount(
      userId,
      accountId,
      {
        ...request,
        quoteId: quote.data.quoteId,
        idempotencyKey: `protection:${childId}`,
      },
      childId,
    );
  }

  /**
   * Market quotes pin the fee rate in both modes; amounts still reprice at
   * execution. Only legacy season quotes without a rate use the season fee.
   * Legacy general quotes keep the existing requote-capable QUOTE_MISMATCH.
   */
  private resolveMarketOrderFeeRate(input: {
    mode: TradingAccountMode | undefined;
    quotedFeeRate: Prisma.Decimal | null;
    currentFeeRate: Prisma.Decimal | null;
  }): Prisma.Decimal {
    if (input.quotedFeeRate != null || isStandaloneAccountMode(input.mode)) {
      if (
        !input.quotedFeeRate ||
        !input.quotedFeeRate.isFinite() ||
        input.quotedFeeRate.lt(0) ||
        input.quotedFeeRate.gt(1)
      ) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'QUOTE_MISMATCH',
          'Market quote has no valid pinned fee rate; requote is required.',
        );
      }
      return roundDecimalHalfUp(input.quotedFeeRate, feeRateScale);
    }

    if (input.mode !== TradingAccountMode.season || !input.currentFeeRate) {
      return this.throwTradingScopeIntegrityError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Season order has no fee source.',
      );
    }
    return roundDecimalHalfUp(input.currentFeeRate, feeRateScale);
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
    setAdminDiagnosticContext({
      failureStage: 'quote_validation',
      evidence: { quoteGuard: { guardName: 'execution_quote' } },
    });
    const quote = order.quote;
    if (!order.quoteId || !quote) {
      setAdminDiagnosticContext({
        evidence: {
          quoteGuard: {
            quotePresent: !!quote,
            quoteIdPresent: !!order.quoteId,
            failureReason: 'quote_required',
          },
        },
      });
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'QUOTE_REQUIRED',
        'quoteId is required for order execution.',
      );
    }

    if (quote.status !== QuoteStatus.active) {
      setAdminDiagnosticContext({
        evidence: {
          quoteGuard: {
            status: quote.status,
            active: false,
            failureReason: 'quote_not_active',
          },
        },
      });
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
      setAdminDiagnosticContext({
        failureStage: 'quote_expiry_validation',
        entities: {
          tradingAccountId: this.requireOrderTradingScope(order),
          assetId: order.assetId,
          orderId: order.id,
          quoteId: quote.id,
        },
        evidence: {
          quoteStatus: quote.status,
          quoteExpiresAt: quote.expiresAt,
          executionTime: executedAt,
          quotedPrice: quote.quotedPrice?.toFixed(monetaryScale),
          maxChangeBps: quote.maxChangeBps.toFixed(4),
          selectionResult: 'REJECTED',
          rejectedReason: 'execution_after_quote_expiry',
          normalCriteria: 'executionTime must be on or before quoteExpiresAt.',
        },
      });
      recordAdminDiagnosticEvent(
        'warn',
        'ORDER_QUOTE_EXPIRED',
        `Quote ${quote.id} expired before order execution.`,
        { quoteExpiresAt: quote.expiresAt, executionTime: executedAt },
      );
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_EXPIRED',
        'Quote has expired.',
      );
    }

    const expectedHash = computeOrderQuoteRequestHash({
      userId: quote.userId,
      seasonParticipantId: order.tradingAccount?.seasonParticipant?.id ?? null,
      tradingAccountId: this.requireOrderTradingScope(order),
      assetId: order.assetId,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      amount: quote.sourceAmount,
      limitPrice: order.orderType === OrderType.limit ? order.limitPrice : null,
      currencyCode: order.currencyCode,
    });

    // Account isolation: a quote minted under a different canonical account
    // is never executable, even for the same user.
    if (quote.tradingAccountId !== this.requireOrderTradingScope(order)) {
      setAdminDiagnosticContext({
        evidence: {
          quoteGuard: {
            scopeValid: false,
            failureReason: 'account_scope_mismatch',
          },
        },
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_MISMATCH',
        'Quote does not match the submitted order.',
      );
    }

    if (
      quote.assetId !== order.assetId ||
      quote.side !== order.side ||
      quote.orderType !== order.orderType ||
      !quote.quantity ||
      this.formatDecimal(quote.quantity, monetaryScale) !==
        this.formatDecimal(order.quantity, monetaryScale) ||
      this.formatNullableDecimal(quote.limitPrice, monetaryScale) !==
        this.formatNullableDecimal(order.limitPrice, monetaryScale) ||
      quote.currencyCode !== order.currencyCode ||
      quote.cashWalletScope !==
        requireOrderCashWalletScope(
          order.cashWalletScope,
          order.currencyCode,
        ) ||
      quote.requestHash !== expectedHash ||
      (quote.sourceAmount != null &&
        (order.asset.assetType !== AssetType.crypto ||
          order.side !== OrderSide.buy ||
          !quote.quotedPrice ||
          !quote.quantity.eq(
            quantityFromBuyAmount(quote.sourceAmount, quote.quotedPrice),
          ))) ||
      !quote.quotedPrice
    ) {
      setAdminDiagnosticContext({
        evidence: {
          quoteGuard: {
            failureReason: 'quote_order_predicate_mismatch',
            assetMatched: quote.assetId === order.assetId,
            sideMatched: quote.side === order.side,
            orderTypeMatched: quote.orderType === order.orderType,
            quantityPresent: !!quote.quantity,
            quantityMatched:
              !!quote.quantity &&
              this.formatDecimal(quote.quantity, monetaryScale) ===
                this.formatDecimal(order.quantity, monetaryScale),
            limitPriceMatched:
              this.formatNullableDecimal(quote.limitPrice, monetaryScale) ===
              this.formatNullableDecimal(order.limitPrice, monetaryScale),
            currencyMatched: quote.currencyCode === order.currencyCode,
            requestHashMatched: quote.requestHash === expectedHash,
            quotedPricePresent: !!quote.quotedPrice,
          },
        },
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_MISMATCH',
        'Quote does not match the submitted order.',
      );
    }

    return {
      ...quote,
      cashWalletScope: requireOrderCashWalletScope(
        quote.cashWalletScope,
        order.currencyCode,
      ),
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
      setAdminDiagnosticContext({
        failureStage: 'execution_price_selection',
        evidence: buildSelectionFailureEvidence({
          workflow: 'orders_execute',
          evaluationAt: executedAt,
          eligibility: providerEligibility,
          candidates: [],
          selection: null,
          isPositiveValue: () => false,
          manualFallback: {
            lookupPerformed: false,
            result: 'not_allowed',
            reason: 'provider_only_workflow',
          },
        }),
      });
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
      const latestCandidate = candidates[0];
      setAdminDiagnosticContext({
        failureStage: 'execution_price_selection',
        entities: {
          tradingAccountId: this.requireOrderTradingScope(order),
          assetId: order.assetId,
          orderId: order.id,
          quoteId: quote.id,
          snapshotId: latestCandidate?.id,
        },
        evidence: buildSelectionFailureEvidence({
          workflow: 'orders_execute',
          evaluationAt: executedAt,
          eligibility: providerEligibility,
          candidates,
          selection,
          asset: order.asset,
          isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
          manualFallback: {
            lookupPerformed: false,
            result: 'not_allowed',
            reason: 'provider_only_workflow',
          },
        }),
        nextInvestigation: [
          'backend/src/providers/source-eligibility.policy.ts',
          'backend/src/orders/orders.service.ts',
        ],
      });
      recordAdminDiagnosticEvent(
        'warn',
        'ORDER_EXECUTION_PRICE_REJECTED',
        `Execution price selection rejected for asset ${order.assetId}.`,
        { rejectedReason: selection.decision.rejectedProviderReason },
      );
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

    return {
      price,
      assetPriceSnapshotId: selection.snapshot.id,
      assetPriceSource: presentSourceDecision(selection.decision),
    };
  }

  private async prepareOrderExecutionFx(): Promise<void> {
    const preparation =
      await this.usdKrwRefreshService!.prepare('orders_execute');
    setAdminDiagnosticContext({
      evidence: {
        preflightRefresh: preparation,
      },
    });
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
    setAdminDiagnosticContext({
      evidence: { transactionDbRevalidation: true },
    });
    const providerEligibility = resolveFxProviderEligibility({
      workflow: 'orders_execute',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    });

    if (!providerEligibility.eligible) {
      setAdminDiagnosticContext({
        failureStage: 'execution_rate_selection',
        evidence: buildSelectionFailureEvidence({
          workflow: 'orders_execute',
          evaluationAt: executedAt,
          eligibility: providerEligibility,
          candidates: [],
          selection: null,
          isPositiveValue: () => false,
          manualFallback: {
            lookupPerformed: false,
            result: 'not_allowed',
            reason: 'provider_only_workflow',
          },
        }),
      });
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'EXECUTION_SOURCE_INELIGIBLE',
        'FX execution source is ineligible.',
      );
    }

    const candidates = await findUsdKrwProviderSnapshotCandidates(tx, {
      sourceNames: providerEligibility.sourceNames,
      take: 10,
    });
    const selection = selectFreshProviderSnapshotBySourcePriority({
      candidates,
      expectedSourceNames: providerEligibility.sourceNames,
      now: executedAt,
      freshnessThresholdSeconds: providerEligibility.freshnessThresholdSeconds,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
    });

    if (selection.state !== 'selected') {
      setAdminDiagnosticContext({
        failureStage: 'execution_rate_selection',
        evidence: buildSelectionFailureEvidence({
          workflow: 'orders_execute',
          evaluationAt: executedAt,
          eligibility: providerEligibility,
          candidates,
          selection,
          isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
          manualFallback: {
            lookupPerformed: false,
            result: 'not_allowed',
            reason: 'provider_only_workflow',
          },
        }),
      });
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
    order = { ...order, quantity: plan.quantity };
    // Verified account scope FIRST: the order, wallet, position, and quote
    // must all name the same trading account before any money moves.
    const tradingAccountId = this.requireOrderTradingScope(order);
    const participant = order.tradingAccount?.seasonParticipant ?? null;
    await this.consumeOrderQuoteInTransaction(tx, order, plan.executedAt);
    setAdminDiagnosticContext({
      failureStage: 'wallet_lookup',
      evidence: {
        financialGuard: {
          financialOperation: 'market_buy_debit',
          guardName: 'wallet_scope',
        },
      },
    });
    const wallet = await this.findCashWalletForExecution(
      tx,
      order.currencyCode,
      tradingAccountId,
      'market_buy_debit',
      requireOrderCashWalletScope(order.cashWalletScope, order.currencyCode),
    );
    const netAmount = this.formatDecimal(plan.netAmount, monetaryScale);
    // Atomic available-balance debit: cash reserved by submitted limit-buy
    // orders is never spendable by a market buy, even under concurrency.
    setAdminDiagnosticContext({
      failureStage: 'wallet_debit',
      evidence: {
        financialGuard: {
          financialOperation: 'market_buy_debit',
          guardName: 'available_cash',
          walletFound: true,
          scopeValid: true,
        },
      },
    });
    const debitCount = await debitAvailableCash(tx, {
      walletId: wallet.id,
      walletScope: order.cashWalletScope,
      tradingAccountId,
      currencyCode: order.currencyCode,
      amount: netAmount,
    });

    if (debitCount !== 1) {
      await this.throwCashDebitFailure(tx, {
        walletId: wallet.id,
        walletScope: order.cashWalletScope,
        tradingAccountId,
        currencyCode: order.currencyCode,
        amount: plan.netAmount,
        mutationAffected: debitCount,
      });
    }

    const postWallet = await this.findCashWalletAfterUpdateOrThrow(tx, {
      walletId: wallet.id,
      walletScope: order.cashWalletScope,
      tradingAccountId,
      currencyCode: order.currencyCode,
      financialOperation: 'market_buy_debit',
    });
    const positionId = await this.createOrUpdateBuyPosition(
      tx,
      order,
      plan,
      tradingAccountId,
    );
    setAdminDiagnosticContext({
      failureStage: 'wallet_ledger_write',
      evidence: { financialGuard: { guardName: 'wallet_ledger_write' } },
    });
    const walletTransaction = await tx.walletTransaction.create({
      data: {
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
    await reconcileSpotProtection(
      tx,
      tradingAccountId,
      order.assetId,
      order.id,
      plan.executedAt,
    );
    setAdminDiagnosticContext({
      failureStage: 'order_portfolio_snapshot',
      evidence: { financialGuard: { guardName: 'portfolio_snapshot' } },
    });
    const equitySnapshotId = await this.recordOrderExecutedPortfolioSnapshot(
      tx,
      participant?.id ?? null,
      plan.executedAt,
      tradingAccountId,
    );

    return {
      seasonId: participant?.season.id ?? null,
      seasonParticipantId: participant?.id ?? null,
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
    order = { ...order, quantity: plan.quantity };
    const tradingAccountId = this.requireOrderTradingScope(order);
    const participant = order.tradingAccount?.seasonParticipant ?? null;
    await this.consumeOrderQuoteInTransaction(tx, order, plan.executedAt);
    setAdminDiagnosticContext({
      failureStage: 'position_lookup',
      evidence: {
        financialGuard: {
          financialOperation: 'market_sell_position_decrement',
          guardName: 'position_scope',
        },
      },
    });
    const position = await tx.position.findUnique({
      where: {
        tradingAccountId_assetId: {
          tradingAccountId,
          assetId: order.assetId,
        },
      },
      select: {
        id: true,
        tradingAccountId: true,
        quantity: true,
        reservedQuantity: true,
        averageCost: true,
        currencyCode: true,
      },
    });

    if (!position) {
      setAdminDiagnosticContext({
        failureStage: 'position_lookup',
        evidence: {
          financialGuard: {
            financialOperation: 'market_sell_position_decrement',
            guardName: 'position_scope',
            positionFound: false,
            failureReason: 'position_not_found',
          },
        },
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_QUANTITY',
        'Order position was not found.',
      );
    }

    // Never decrement another account's position: the position must carry
    // the SAME verified account scope as the order (null → repair first).
    this.assertPositionTradingScope(position, {
      tradingAccountId,
    });

    if (position.currencyCode !== order.currencyCode) {
      setAdminDiagnosticContext({
        failureStage: 'position_scope_validation',
        evidence: {
          financialGuard: {
            financialOperation: 'market_sell_position_decrement',
            guardName: 'position_currency',
            positionFound: true,
            scopeValid: true,
            currencyMatched: false,
            failureReason: 'currency_mismatch',
          },
        },
      });
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
    setAdminDiagnosticContext({
      failureStage: 'position_decrement',
      evidence: {
        financialGuard: {
          financialOperation: 'market_sell_position_decrement',
          guardName: 'available_position_quantity',
          positionFound: true,
          scopeValid: true,
          currencyMatched: true,
        },
      },
    });
    const positionUpdateResult = await tx.position.updateMany({
      where: {
        id: position.id,
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
        tradingAccountId,
        assetId: order.assetId,
        quantity: order.quantity,
        currencyCode: order.currencyCode,
        mutationAffected: positionUpdateResult.count,
      });
    }

    setAdminDiagnosticContext({
      failureStage: 'wallet_lookup',
      evidence: {
        financialGuard: {
          financialOperation: 'market_sell_credit',
          guardName: 'wallet_scope',
        },
      },
    });
    const wallet = await this.findCashWalletForExecution(
      tx,
      order.currencyCode,
      tradingAccountId,
      'market_sell_credit',
      requireOrderCashWalletScope(order.cashWalletScope, order.currencyCode),
    );
    const netAmount = this.formatDecimal(plan.netAmount, monetaryScale);
    setAdminDiagnosticContext({
      failureStage: 'wallet_credit',
      evidence: {
        financialGuard: {
          financialOperation: 'market_sell_credit',
          guardName: 'wallet_scope',
          walletFound: true,
          scopeValid: true,
        },
      },
    });
    const creditResult = await tx.cashWallet.updateMany({
      where: {
        walletScope: order.cashWalletScope,
        id: wallet.id,
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
        walletScope: order.cashWalletScope,
        tradingAccountId,
        currencyCode: order.currencyCode,
        mutationAffected: creditResult.count,
      });
    }

    const postWallet = await this.findCashWalletAfterUpdateOrThrow(tx, {
      walletId: wallet.id,
      walletScope: order.cashWalletScope,
      tradingAccountId,
      currencyCode: order.currencyCode,
      financialOperation: 'market_sell_credit',
    });
    setAdminDiagnosticContext({
      failureStage: 'wallet_ledger_write',
      evidence: { financialGuard: { guardName: 'wallet_ledger_write' } },
    });
    const walletTransaction = await tx.walletTransaction.create({
      data: {
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
    await reconcileSpotProtection(
      tx,
      tradingAccountId,
      order.assetId,
      order.id,
      plan.executedAt,
    );
    setAdminDiagnosticContext({
      failureStage: 'order_portfolio_snapshot',
      evidence: { financialGuard: { guardName: 'portfolio_snapshot' } },
    });
    const equitySnapshotId = await this.recordOrderExecutedPortfolioSnapshot(
      tx,
      participant?.id ?? null,
      plan.executedAt,
      tradingAccountId,
    );

    return {
      seasonId: participant?.season.id ?? null,
      seasonParticipantId: participant?.id ?? null,
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

    // Account-conditioned consume: only this account's active quote flips.
    const tradingAccountId = this.requireOrderTradingScope(order);
    setAdminDiagnosticContext({
      failureStage: 'quote_consume',
      evidence: { financialGuard: { guardName: 'active_quote_in_account' } },
    });
    const consumedCount = (
      await tx.quote.updateMany({
        where: {
          id: order.quoteId,
          status: QuoteStatus.active,
          tradingAccountId,
        },
        data: {
          status: QuoteStatus.consumed,
          consumedAt,
        },
      })
    ).count;

    if (consumedCount !== 1) {
      setAdminDiagnosticContext({
        evidence: {
          financialGuard: {
            guardName: 'active_quote_in_account',
            failureReason: 'quote_consume_guard_rejected',
            mutationAffected: consumedCount,
          },
        },
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_NOT_ACTIVE',
        'Quote is not active.',
      );
    }
  }

  private async findCashWalletForExecution(
    tx: OrderExecuteTransactionClient,
    currencyCode: CurrencyCode,
    tradingAccountId: string,
    financialOperation: string,
    walletScope: WalletScope,
  ) {
    const wallet = await tx.cashWallet.findUnique({
      where: {
        tradingAccountId_walletScope_currencyCode: {
          walletScope,
          tradingAccountId,
          currencyCode,
        },
      },
      select: {
        walletScope: true,
        id: true,
        tradingAccountId: true,
        currencyCode: true,
        balanceAmount: true,
      },
    });

    if (!wallet) {
      setAdminDiagnosticContext({
        evidence: {
          financialGuard: {
            financialOperation,
            guardName: 'wallet_scope',
            walletFound: false,
            failureReason: 'wallet_not_found',
          },
        },
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_BALANCE',
        'Order cash wallet was not found.',
      );
    }

    // Null or mismatched wallet scope fails closed (500) BEFORE any debit
    // or credit — never auto-backfilled mid-trade.
    return assertCashWalletTradingAccountScope(wallet, {
      tradingAccountId,
      walletScope,
    });
  }

  private async findCashWalletAfterUpdateOrThrow(
    tx: OrderExecuteTransactionClient,
    input: {
      financialOperation: string;
      walletId: string;
      walletScope: WalletScope;
      tradingAccountId: string;
      currencyCode: CurrencyCode;
    },
  ) {
    setAdminDiagnosticContext({
      failureStage: 'wallet_post_read',
      evidence: {
        financialGuard: {
          financialOperation: input.financialOperation,
          guardName: 'wallet_post_read',
          mutationResult: 'applied',
        },
      },
    });
    const wallet = await tx.cashWallet.findFirst({
      where: {
        walletScope: input.walletScope,
        id: input.walletId,
        tradingAccountId: input.tradingAccountId,
        currencyCode: input.currencyCode,
      },
      select: {
        walletScope: true,
        id: true,
        currencyCode: true,
        balanceAmount: true,
      },
    });

    if (!wallet) {
      // The scoped post-read cannot distinguish missing from a scope change.
      setAdminDiagnosticContext({
        evidence: {
          financialGuard: {
            financialOperation: input.financialOperation,
            guardName: 'wallet_post_read',
            mutationResult: 'applied',
            failureReason: 'wallet_post_read_failed',
            scopeMatchedRead: false,
          },
        },
      });
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
      mutationAffected: number;
      walletId: string;
      walletScope: WalletScope;
      tradingAccountId: string;
      currencyCode: CurrencyCode;
      amount: Prisma.Decimal;
    },
  ): Promise<never> {
    const reason = await diagnoseCashWalletMutationFailure(tx, {
      walletId: input.walletId,
      expected: {
        tradingAccountId: input.tradingAccountId,
        walletScope: input.walletScope,
        currencyCode: input.currencyCode,
      },
      requires: { available: input.amount },
      diagnostic: {
        financialOperation: 'market_buy_debit',
        failureStage: 'wallet_debit',
        mutationAffected: input.mutationAffected,
      },
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
      mutationAffected: number;
      walletId: string;
      walletScope: WalletScope;
      tradingAccountId: string;
      currencyCode: CurrencyCode;
    },
  ): Promise<never> {
    const reason = await diagnoseCashWalletMutationFailure(tx, {
      walletId: input.walletId,
      expected: {
        tradingAccountId: input.tradingAccountId,
        walletScope: input.walletScope,
        currencyCode: input.currencyCode,
      },
      diagnostic: {
        financialOperation: 'market_sell_credit',
        failureStage: 'wallet_credit',
        mutationAffected: input.mutationAffected,
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
    setAdminDiagnosticContext({
      failureStage: 'position_lookup',
      evidence: {
        financialGuard: {
          financialOperation: 'market_buy_position_update',
          guardName: 'position_scope',
        },
      },
    });
    const position = await tx.position.findUnique({
      where: {
        tradingAccountId_assetId: {
          tradingAccountId,
          assetId: order.assetId,
        },
      },
      select: {
        id: true,
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
      setAdminDiagnosticContext({
        failureStage: 'position_create',
        evidence: {
          financialGuard: {
            financialOperation: 'market_buy_position_create',
            guardName: 'position_create',
            positionFound: false,
          },
        },
      });
      const created = await tx.position.create({
        data: {
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
      tradingAccountId,
    });

    if (position.currencyCode !== order.currencyCode) {
      setAdminDiagnosticContext({
        failureStage: 'position_scope_validation',
        evidence: {
          financialGuard: {
            financialOperation: 'market_buy_position_update',
            guardName: 'position_currency',
            positionFound: true,
            scopeValid: true,
            currencyMatched: false,
            failureReason: 'currency_mismatch',
          },
        },
      });
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
    setAdminDiagnosticContext({
      failureStage: 'position_update',
      evidence: {
        financialGuard: {
          financialOperation: 'market_buy_position_update',
          guardName: 'position_optimistic_update',
          positionFound: true,
          scopeValid: true,
          currencyMatched: true,
        },
      },
    });
    const updateResult = await tx.position.updateMany({
      where: {
        id: position.id,
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
      setAdminDiagnosticContext({
        failureStage: 'position_update',
        evidence: {
          financialGuard: {
            financialOperation: 'market_buy_position_update',
            guardName: 'position_optimistic_update',
            mutationResult: 'rejected',
            mutationAffected: updateResult.count,
            failureReason: 'conflict',
            observation: 'optimistic_guard_rejection',
          },
        },
      });

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
    /** The order's already-verified canonical account scope. */
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
      if (!account || !isStandaloneAccountMode(account.mode)) {
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
        tradingAccountId,
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
        tradingAccountId,
        totalAssetKrw: valuation.totalAssetKrw,
        returnRate: valuation.returnRate,
        krwCash: valuation.krwCash,
        usdCashKrw: valuation.usdCashKrw,
        domesticStockValueKrw: valuation.domesticStockValueKrw,
        usStockValueKrw: valuation.usStockValueKrw,
        cryptoValueKrw: valuation.cryptoValueKrw,
        ...futuresSnapshotValues(valuation),
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
        tradingAccountId,
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
    tradingAccountId: string,
  ) {
    const snapshots = await tx.equitySnapshot.findMany({
      where: {
        tradingAccountId,
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
    tradingAccountId: string,
    valuationAt: Date,
  ): Promise<{
    totalAssetKrw: string;
    returnRate: string;
    krwCash: string;
    usdCashKrw: string;
    domesticStockValueKrw: string;
    usStockValueKrw: string;
    cryptoValueKrw: string;
    futuresUnrealizedPnlUsd?: string;
    futuresUnrealizedPnlKrw?: string;
    futuresValuationJson?: Prisma.InputJsonObject;
  }> {
    const account = await tx.tradingAccount.findUnique({
      where: {
        id: tradingAccountId,
      },
      select: {
        userId: true,
        mode: true,
        initialCapitalKrw: true,
        seasonParticipant: {
          select: { id: true, userId: true, initialCapitalKrw: true },
        },
        cashWallets: {
          select: {
            walletScope: true,
            currencyCode: true,
            balanceAmount: true,
          },
        },
        futuresPositions: { where: { status: 'open' }, select: { id: true } },
        positions: {
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

    if (
      !account ||
      account.mode !== TradingAccountMode.season ||
      account.seasonParticipant?.id !== seasonParticipantId
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'SEASON_PARTICIPANT_NOT_FOUND',
        'Season participant not found.',
      );
    }

    if (
      account.seasonParticipant.userId !== account.userId ||
      !account.seasonParticipant.initialCapitalKrw.eq(account.initialCapitalKrw)
    ) {
      this.throwTradingScopeIntegrityError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Season participant does not match its canonical account owner/capital.',
      );
    }

    const usdKrwSnapshot =
      account.cashWallets.some(
        (wallet) =>
          wallet.currencyCode === CurrencyCode.USD &&
          !wallet.balanceAmount.eq(0),
      ) ||
      account.positions.some(
        (position) =>
          position.currencyCode === CurrencyCode.USD &&
          !position.quantity.eq(0),
      )
        ? await this.findLatestUsdKrwRateForPortfolio(tx, valuationAt)
        : null;
    const positions = await Promise.all(
      account.positions.map(async (position) => ({
        ...position,
        assetType: position.asset.assetType,
        priceCurrency: this.getAssetPriceCurrency(position.asset),
        settlementCurrency: this.getAssetSettlementCurrency(position.asset),
        latestPriceSnapshot: position.quantity.eq(0)
          ? null
          : await this.findLatestAssetPriceForPortfolio(
              tx,
              {
                assetId: position.assetId,
                assetType: position.asset.assetType,
                market: position.asset.market,
                currencyCode: this.getAssetPriceCurrency(position.asset),
              },
              valuationAt,
            ),
      })),
    );

    try {
      const valuation = calculatePortfolioValuation({
        seasonParticipantId,
        tradingAccountId,
        initialCapitalKrw: account.initialCapitalKrw,
        cashWallets: account.cashWallets,
        positions,
        usdKrwSnapshot,
        valuationAt,
        sourceEligibilityWorkflow: 'live_portfolio_valuation',
      });

      for (const position of positions) {
        if (!position.latestPriceSnapshot) continue;
        const values = calculatePositionValuation({
          quantity: position.quantity,
          averageCost: position.averageCost,
          currentPrice: new Prisma.Decimal(position.latestPriceSnapshot.price),
          currencyCode: position.currencyCode,
          usdKrwRate: usdKrwSnapshot
            ? new Prisma.Decimal(usdKrwSnapshot.rate)
            : null,
        });
        await tx.position.update({
          where: { id: position.id },
          data: {
            currentPriceLocal: this.formatDecimal(
              new Prisma.Decimal(position.latestPriceSnapshot.price),
              monetaryScale,
            ),
            currentPriceKrw: this.formatDecimal(
              values.currentPriceKrw,
              monetaryScale,
            ),
            marketValueLocal: this.formatDecimal(
              values.marketValueLocal,
              monetaryScale,
            ),
            marketValueKrw: this.formatDecimal(
              values.marketValueKrw,
              monetaryScale,
            ),
            unrealizedPnlLocal: this.formatDecimal(
              values.unrealizedPnlLocal,
              monetaryScale,
            ),
            unrealizedPnlKrw: this.formatDecimal(
              values.unrealizedPnlKrw,
              monetaryScale,
            ),
          },
          select: { id: true },
        });
      }
      if (account.futuresPositions?.length) {
        return new PortfolioValuationService(
          this.prisma,
        ).calculateTradingAccountValuation(
          tradingAccountId,
          valuationAt,
          'live_portfolio_valuation',
          tx,
        );
      }
      return valuation;
    } catch (error) {
      if (error instanceof PortfolioValuationError) {
        const badRequest = [
          'INVALID_INITIAL_CAPITAL',
          'CASH_WALLET_INVALID',
          'POSITION_INVALID',
          'INVALID_DECIMAL',
          'ORDER_PRICE_SETTLEMENT_CURRENCY_NOT_SUPPORTED',
        ].includes(error.code);
        this.throwApiError(
          badRequest ? HttpStatus.BAD_REQUEST : HttpStatus.SERVICE_UNAVAILABLE,
          error.code,
          error.message,
        );
      }
      throw error;
    }
  }

  private async findLatestUsdKrwRateForPortfolio(
    tx: OrderExecuteTransactionClient,
    valuationAt: Date,
  ): Promise<PortfolioFxRateSnapshotInput> {
    const providerEligibility = resolveFxProviderEligibility({
      workflow: 'live_portfolio_valuation',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    });
    const providerCandidates = providerEligibility.eligible
      ? await findUsdKrwProviderSnapshotCandidates(tx, {
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
      return providerSelection.snapshot;
    }

    const providerFailureEvidence = buildSelectionFailureEvidence({
      workflow: 'live_portfolio_valuation',
      evaluationAt: valuationAt,
      eligibility: providerEligibility,
      candidates: providerCandidates,
      selection: providerSelection,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
    });

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
        baseCurrency: true,
        quoteCurrency: true,
        createdAt: true,
        rate: true,
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
        approvedByUserId: true,
      },
    });

    const failureEvidence = (reason?: string) => ({
      ...providerFailureEvidence,
      manualFallback: describeManualFallback({
        snapshot,
        evaluationAt: valuationAt,
        reason,
        queryChecks: [
          'source_type_admin_manual',
          'effective_at_lte_evaluation',
          'positive_value',
          'approved',
        ],
        freshnessThresholdSeconds: fxExecuteSnapshotFreshnessThresholdMs / 1000,
        positiveValue: snapshot ? isPositiveDecimal(snapshot.rate) : undefined,
      }),
    });

    if (!snapshot) {
      setAdminDiagnosticContext({
        failureStage: 'fx_rate_selection',
        evidence: failureEvidence(),
      });
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
      setAdminDiagnosticContext({
        failureStage: 'fx_rate_selection',
        evidence: failureEvidence('manual_source_or_approval_ineligible'),
      });
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FX_RATE_UNAVAILABLE',
        'No approved admin_manual USD/KRW FX rate snapshot is available.',
      );
    }

    if (
      isFxSnapshotStaleForPortfolioValuation(snapshot.effectiveAt, valuationAt)
    ) {
      setAdminDiagnosticContext({
        failureStage: 'fx_rate_freshness_validation',
        evidence: failureEvidence('effective_at_stale'),
      });
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FX_RATE_STALE',
        'USD/KRW FX rate snapshot is stale.',
      );
    }

    return snapshot;
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
  ): Promise<PortfolioAssetPriceSnapshotInput> {
    const priceRead = {
      asset: { ...input, id: input.assetId },
      workflow: 'live_portfolio_valuation' as const,
      now: valuationAt,
    };
    const closedScope = closedMarketPriceScope(priceRead);
    const providerEligibility = resolveAssetProviderEligibility({
      workflow: priceRead.workflow,
      asset: priceRead.asset,
    });
    const providerCandidates = providerEligibility.eligible
      ? await findMarketAwareAssetPriceCandidates(tx, {
          ...priceRead,
          sourceNames: providerEligibility.sourceNames,
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
      return providerSelection.snapshot;
    }

    const providerFailureEvidence = buildSelectionFailureEvidence({
      workflow: 'live_portfolio_valuation',
      evaluationAt: valuationAt,
      eligibility: providerEligibility,
      candidates: providerCandidates,
      selection: providerSelection,
      asset: input,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
    });

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
        ...closedScope?.where,
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        assetId: true,
        sourceType: true,
        createdAt: true,
        price: true,
        priceKrw: true,
        currencyCode: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });

    if (!snapshot) {
      setAdminDiagnosticContext({
        failureStage: 'asset_price_selection',
        entities: { assetId: input.assetId },
        evidence: {
          ...providerFailureEvidence,
          manualFallback: describeManualFallback({
            snapshot,
            evaluationAt: valuationAt,
            queryChecks: [
              'source_type_admin_manual',
              'effective_at_lte_evaluation',
              'positive_value',
              ...(closedScope ? ['last_completed_session'] : []),
            ],
          }),
        },
      });
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

    return snapshot;
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
      tradingAccountId: string;
      assetId: string;
      quantity: Prisma.Decimal;
      currencyCode: CurrencyCode;
      mutationAffected: number;
    },
  ): Promise<never> {
    const diagnosis = await diagnosePositionMutationFailure(tx, {
      ...input,
      guard: 'available_position_quantity',
      financialOperation: 'market_sell_position_decrement',
      failureStage: 'position_decrement',
    });
    // Keep the historical scoped-read public mapping, including CONFLICT for
    // reserved-only shortage. Admin evidence contains the more precise reason.
    if (
      !diagnosis.positionFound ||
      !diagnosis.scopeValid ||
      !diagnosis.assetMatched
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_QUANTITY',
        'Order position was not found.',
      );
    }
    if (!diagnosis.totalQuantitySufficient) {
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
    setAdminDiagnosticContext({
      failureStage: 'order_finalization',
      evidence: { financialGuard: { guardName: 'submitted_order_in_account' } },
    });
    const finalizationResult = await tx.order.updateMany({
      where: {
        id: order.id,
        tradingAccountId: this.requireOrderTradingScope(order),
        status: OrderStatus.submitted,
      },
      data: {
        status: OrderStatus.executed,
        // Keep quantity-order intent; amount orders retain resolved quantity.
        ...(!plan.marketExecution || plan.marketExecution.requestedAmount
          ? { quantity: this.formatDecimal(plan.quantity, quantityScale) }
          : {}),
        ...(plan.marketExecution
          ? {
              executedQuantity: this.formatDecimal(
                plan.quantity,
                quantityScale,
              ),
              canceledQuantity: plan.marketExecution.canceledQuantity,
              requestedAmount: plan.marketExecution.requestedAmount,
              unspentAmount: plan.marketExecution.unspentAmount,
              cancelReason: plan.marketExecution.cancelReason,
              canceledAt: plan.marketExecution.cancelReason
                ? plan.executedAt
                : null,
              executionEvidence: plan.marketExecution.evidence,
            }
          : {}),
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
      setAdminDiagnosticContext({
        evidence: {
          financialGuard: {
            guardName: 'submitted_order_in_account',
            failureReason: 'order_finalization_guard_rejected',
            mutationAffected: finalizationResult.count,
          },
        },
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_EXECUTION_CONFLICT',
        'Order execution conflicted with another state change.',
      );
    }

    setAdminDiagnosticContext({
      failureStage: 'order_finalization_read_back',
      evidence: { financialGuard: { guardName: 'order_read_back' } },
    });
    const finalizedOrder = await tx.order.findUnique({
      where: {
        id: order.id,
      },
      select: ORDER_EXECUTION_SELECT,
    });

    if (!finalizedOrder) {
      setAdminDiagnosticContext({
        evidence: {
          financialGuard: {
            guardName: 'order_read_back',
            failureReason: 'order_read_back_failed',
          },
        },
      });
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
    if (order.executedQuantity && order.responsePayloadJson) {
      return order.responsePayloadJson as unknown as ExecuteOrderResponse;
    }
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
    const {
      participant,
      tradingAccountId,
      request: inputRequest,
      quoteAt,
      sourceWorkflow,
    } = input;
    const asset = await this.findUsableAsset(inputRequest.assetId);
    assertOrderInputPolicy(
      { ...inputRequest, assetType: asset.assetType },
      { positionBoundExit: !!inputRequest.protectionChildId },
    );
    if (
      inputRequest.currencyCode &&
      inputRequest.currencyCode !== this.getAssetSettlementCurrency(asset)
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
      inputRequest,
      asset,
      quoteAt,
      sourceWorkflow,
    );
    const request: PricedOrderRequest = {
      ...inputRequest,
      quantity: inputRequest.amount
        ? quantityFromBuyAmount(inputRequest.amount, priceContext.price)
        : inputRequest.quantity!,
    };
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
      tradingAccountId,
      assetId: asset.id,
      side: request.side,
      currencyCode: this.getAssetSettlementCurrency(asset),
      walletScope: newOrderCashWalletScope(asset.assetType),
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
      cashWalletScope: newOrderCashWalletScope(asset.assetType),
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
      amount: quote.request.amount,
      limitPrice: quote.request.limitPrice,
      currencyCode: this.getAssetSettlementCurrency(quote.asset),
    });
    const durableQuote = await this.prisma.quote.create({
      data: {
        userId,
        tradingAccountId: quote.context.tradingAccountId,
        quoteType: QuoteType.order,
        cashWalletScope: quote.cashWalletScope,
        status: QuoteStatus.active,
        assetId: quote.asset.id,
        side: quote.request.side,
        orderType: quote.request.orderType,
        quantity: this.formatDecimal(quote.request.quantity, quantityScale),
        sourceAmount: quote.request.amount
          ? this.formatDecimal(quote.request.amount, monetaryScale)
          : null,
        limitPrice: quote.request.limitPrice
          ? this.formatDecimal(quote.request.limitPrice, monetaryScale)
          : null,
        currencyCode: this.getAssetSettlementCurrency(quote.asset),
        quotedPrice: this.formatDecimal(quote.price, monetaryScale),
        quotedRate: quote.fxRate ? this.formatDecimal(quote.fxRate, 8) : null,
        // Limit quotes pin their reservation/fill basis. Market quotes in both
        // modes pin only the fee rate; amounts use the actual execute price.
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
            : quote.request.orderType === OrderType.market
              ? formatDecimalScale(quote.context.feeRate, feeRateScale)
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
    setAdminDiagnosticContext({
      failureStage: 'quote_validation',
      evidence: { quoteGuard: { guardName: 'create_quote' } },
    });
    const quote = await tx.quote.findFirst({
      where: {
        id: input.quoteId,
        userId: input.userId,
        quoteType: QuoteType.order,
      },
      select: {
        id: true,
        tradingAccountId: true,
        status: true,
        assetId: true,
        side: true,
        orderType: true,
        quantity: true,
        sourceAmount: true,
        limitPrice: true,
        currencyCode: true,
        cashWalletScope: true,
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
      setAdminDiagnosticContext({
        evidence: {
          quoteGuard: { quoteFound: false, failureReason: 'quote_not_found' },
        },
      });
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'QUOTE_NOT_FOUND',
        'Quote not found.',
      );
    }

    // Account isolation: a quote minted under a different canonical account
    // cannot back an order create on this account.
    if (quote.tradingAccountId !== input.tradingAccountId) {
      setAdminDiagnosticContext({
        evidence: {
          quoteGuard: {
            scopeValid: false,
            failureReason: 'account_scope_mismatch',
          },
        },
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_MISMATCH',
        'Quote does not match the order create request.',
      );
    }

    if (quote.status !== QuoteStatus.active) {
      setAdminDiagnosticContext({
        evidence: {
          quoteGuard: {
            status: quote.status,
            active: false,
            failureReason: 'quote_not_active',
          },
        },
      });
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
      setAdminDiagnosticContext({
        failureStage: 'quote_expiry_validation',
        evidence: {
          quoteGuard: {
            expired: true,
            failureReason: 'execution_after_quote_expiry',
          },
        },
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_EXPIRED',
        'Quote has expired.',
      );
    }

    if (!quote.asset) {
      setAdminDiagnosticContext({
        evidence: {
          quoteGuard: {
            assetFound: false,
            failureReason: 'quote_asset_missing',
          },
        },
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_MISMATCH',
        'Quote does not match the order create request.',
      );
    }

    assertOrderInputPolicy(
      {
        ...input.request,
        assetType: quote.asset.assetType,
      },
      { positionBoundExit: !!input.request.protectionChildId },
    );
    const canonicalQuantity =
      input.request.amount && quote.quotedPrice
        ? quantityFromBuyAmount(input.request.amount, quote.quotedPrice)
        : input.request.quantity;
    const expectedRequestHash = computeOrderQuoteRequestHash({
      userId: input.userId,
      seasonParticipantId: input.seasonParticipantId,
      tradingAccountId: input.tradingAccountId,
      assetId: input.request.assetId,
      side: input.request.side,
      orderType: input.request.orderType,
      quantity: input.request.quantity,
      amount: input.request.amount,
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
      quote.assetId !== input.request.assetId ||
      quote.side !== input.request.side ||
      quote.orderType !== input.request.orderType ||
      !quote.quantity ||
      !canonicalQuantity ||
      this.formatNullableDecimal(quote.sourceAmount ?? null, monetaryScale) !==
        this.formatNullableDecimal(input.request.amount, monetaryScale) ||
      this.formatDecimal(quote.quantity, quantityScale) !==
        this.formatDecimal(canonicalQuantity, quantityScale) ||
      quoteLimitPriceText !== requestLimitPriceText ||
      quote.currencyCode !== this.getAssetSettlementCurrency(quote.asset) ||
      quote.requestHash !== expectedRequestHash ||
      !quote.quotedPrice ||
      !quote.asset.isActive ||
      isFuturesOnlyAsset(quote.asset)
    ) {
      setAdminDiagnosticContext({
        evidence: {
          quoteGuard: {
            failureReason: 'quote_request_predicate_mismatch',
            assetMatched: quote.assetId === input.request.assetId,
            sideMatched: quote.side === input.request.side,
            orderTypeMatched: quote.orderType === input.request.orderType,
            quantityPresent: !!quote.quantity,
            quantityMatched:
              !!quote.quantity &&
              !!canonicalQuantity &&
              this.formatDecimal(quote.quantity, quantityScale) ===
                this.formatDecimal(canonicalQuantity, quantityScale),
            limitPriceMatched: quoteLimitPriceText === requestLimitPriceText,
            currencyMatched:
              quote.currencyCode ===
              this.getAssetSettlementCurrency(quote.asset),
            requestHashMatched: quote.requestHash === expectedRequestHash,
            quotedPricePresent: !!quote.quotedPrice,
            assetActive: quote.asset.isActive,
          },
        },
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_MISMATCH',
        'Quote does not match the order create request.',
      );
    }

    return {
      ...quote,
      cashWalletScope: requireOrderCashWalletScope(
        quote.cashWalletScope,
        this.getAssetSettlementCurrency(quote.asset),
      ),
      quotedPrice: quote.quotedPrice,
      quantity: quote.quantity,
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
      ...(request.amount
        ? { amount: this.formatDecimal(request.amount, monetaryScale) }
        : { quantity: this.formatDecimal(request.quantity!, quantityScale) }),
      // Included in the hash so replaying the same idempotencyKey with a
      // different limitPrice is an ORDER_IDEMPOTENCY_CONFLICT. Market
      // requests keep the historical null (hash-compatible).
      limitPrice: request.limitPrice
        ? this.formatDecimal(request.limitPrice, monetaryScale)
        : null,
      currencyCode: request.currencyCode ?? null,
      ...(request.attachedProtection
        ? { attachedProtection: request.attachedProtection }
        : {}),
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
    const attachedProtection =
      body.attachedProtection === undefined
        ? undefined
        : parseProtectionLegs(body.attachedProtection);
    if (attachedProtection && (side !== 'buy' || orderType !== 'limit'))
      throw createApiError(
        'INVALID_ATTACHED_ENTRY',
        'Attached protection is supported only on Spot BUY Limit entries.',
        400,
      );
    if (
      this.hasProvidedValue(body.amount) &&
      this.hasProvidedValue(body.quantity)
    ) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_ORDER_INPUT',
        'Provide amount or quantity, never both.',
      );
    }
    const amount = this.hasProvidedValue(body.amount)
      ? this.parsePositiveDecimalField(body.amount, 'amount')
      : null;
    const quantity = amount
      ? null
      : this.parsePositiveQuantityField(body.quantity);

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
        quantity,
        amount,
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
      quantity,
      amount,
      attachedProtection,
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
   * `idempotencyKey` is `(tradingAccountId, idempotencyKey)` — a key is
   * unique WITHIN an account, not across a user's lifetime. A
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
   * exactly as on the account-scoped path.
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
        tradingAccount: { userId: input.userId },
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
      setAdminDiagnosticContext({
        failureStage: 'idempotency_validation',
        evidence: {
          orderGuard: {
            orderTypeMatched: order.orderType === input.expectedOrderType,
            idempotencyKeyMatched:
              order.idempotencyKey === input.idempotencyKey,
            failureReason: 'quote_already_used_by_different_request',
          },
        },
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ORDER_IDEMPOTENCY_CONFLICT',
        'This quote was already used by a different order create request.',
      );
    }

    return order;
  }

  /**
   * Account-scoped idempotent-create lookup. The canonical migration
   * backfills historical orders before enforcing NOT NULL, so this key
   * covers both historical and newly-created rows.
   */
  private async findIdempotentCreateOrder(
    input: {
      tradingAccountId: string;
      idempotencyKey: string;
    },
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const accountOrder = await client.order.findFirst({
      where: {
        tradingAccountId: input.tradingAccountId,
        idempotencyKey: input.idempotencyKey,
      },
      select: IDEMPOTENT_CREATE_ORDER_SELECT,
    });

    return accountOrder;
  }

  private replayIdempotentCreateOrder(
    order: NonNullable<
      Awaited<ReturnType<OrdersService['findIdempotentCreateOrder']>>
    >,
    idempotency: OrderCreateIdempotency,
  ): CreateOrderResponse | LimitOrderCreateResponse {
    if (order.requestHash !== idempotency.requestHash) {
      setAdminDiagnosticContext({
        failureStage: 'idempotency_validation',
        evidence: {
          orderGuard: {
            requestHashMatched: false,
            failureReason: 'idempotency_request_mismatch',
          },
        },
      });
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

    if (!asset.isActive || isFuturesOnlyAsset(asset)) {
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

    const providerFailureEvidence = buildSelectionFailureEvidence({
      workflow: sourceWorkflow,
      evaluationAt: quoteAt,
      eligibility: providerEligibility,
      candidates: providerCandidates,
      selection: providerSelection,
      asset,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
    });

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
      setAdminDiagnosticContext({
        failureStage: 'asset_price_selection',
        entities: { assetId: asset.id },
        evidence: {
          ...providerFailureEvidence,
          manualFallback: describeManualFallback({
            snapshot,
            evaluationAt: quoteAt,
            queryChecks: [
              'source_type_admin_manual',
              'effective_at_lte_evaluation',
              'positive_value',
            ],
          }),
        },
      });
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
      ? await findUsdKrwProviderSnapshotCandidates(this.prisma, {
          sourceNames: providerEligibility.sourceNames,
          take: 10,
        })
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

    const providerFailureEvidence = buildSelectionFailureEvidence({
      workflow: sourceWorkflow,
      evaluationAt: quoteAt,
      eligibility: providerEligibility,
      candidates: providerCandidates,
      selection: providerSelection,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
    });

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

    const failureEvidence = (reason?: string) => ({
      ...providerFailureEvidence,
      manualFallback: describeManualFallback({
        snapshot,
        evaluationAt: quoteAt,
        reason,
        queryChecks: [
          'source_type_admin_manual',
          'effective_at_lte_evaluation',
          'positive_value',
          'approved',
        ],
        freshnessThresholdSeconds: fxExecuteSnapshotFreshnessThresholdMs / 1000,
        positiveValue: snapshot ? isPositiveDecimal(snapshot.rate) : undefined,
      }),
    });

    if (!snapshot) {
      setAdminDiagnosticContext({
        failureStage: 'fx_rate_selection',
        evidence: failureEvidence(),
      });
      this.throwApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FX_RATE_UNAVAILABLE',
        'FX rate is unavailable.',
      );
    }

    if (isFxSnapshotStale(snapshot.effectiveAt, quoteAt)) {
      setAdminDiagnosticContext({
        failureStage: 'fx_rate_freshness_validation',
        evidence: failureEvidence('effective_at_stale'),
      });
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
    tradingAccountId: string;
    assetId: string;
    side: OrderSide;
    currencyCode: CurrencyCode;
    walletScope: WalletScope;
    quantity: Prisma.Decimal;
    netAmount: Prisma.Decimal;
  }): Promise<{
    walletBalanceBefore: Prisma.Decimal;
    positionQuantityBefore: Prisma.Decimal;
  }> {
    if (input.side === OrderSide.buy) {
      setAdminDiagnosticContext({
        failureStage: 'quote_cash_availability',
        evidence: {
          financialGuard: {
            financialOperation: 'market_buy_quote',
            guardName: 'available_cash',
          },
        },
      });
      const wallet = await this.prisma.cashWallet.findUnique({
        where: {
          tradingAccountId_walletScope_currencyCode: {
            walletScope: input.walletScope,
            tradingAccountId: input.tradingAccountId,
            currencyCode: input.currencyCode,
          },
        },
        select: {
          walletScope: true,
          id: true,
          tradingAccountId: true,
          balanceAmount: true,
          reservedAmount: true,
        },
      });

      // Scope before balance: an unscoped/mis-scoped wallet must never be
      // the balance basis of a quote (500 repair-required/mismatch).
      if (wallet) {
        assertCashWalletTradingAccountScope(wallet, {
          tradingAccountId: input.tradingAccountId,
          walletScope: input.walletScope,
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
        setAdminDiagnosticContext({
          evidence: {
            financialGuard: {
              financialOperation: 'market_buy_quote',
              guardName: 'available_cash',
              walletFound: !!wallet,
              scopeValid: wallet ? true : undefined,
              failureReason: wallet
                ? 'insufficient_available'
                : 'wallet_not_found',
              availableSufficient: wallet ? false : undefined,
              balanceSufficient: wallet
                ? wallet.balanceAmount.gte(input.netAmount)
                : undefined,
              reservedCashPresent: wallet
                ? (wallet.reservedAmount ?? new Prisma.Decimal(0)).gt(0)
                : undefined,
            },
          },
        });
        this.throwApiError(
          HttpStatus.CONFLICT,
          'INSUFFICIENT_BALANCE',
          'Cash wallet balance is insufficient.',
        );
      }

      const position = await this.prisma.position.findUnique({
        where: {
          tradingAccountId_assetId: {
            tradingAccountId: input.tradingAccountId,
            assetId: input.assetId,
          },
        },
        select: {
          tradingAccountId: true,
          quantity: true,
        },
      });

      if (position) {
        this.assertPositionTradingScope(position, {
          tradingAccountId: input.tradingAccountId,
        });
      }

      return {
        walletBalanceBefore: wallet.balanceAmount,
        positionQuantityBefore: position?.quantity ?? new Prisma.Decimal(0),
      };
    }

    setAdminDiagnosticContext({
      failureStage: 'quote_position_availability',
      evidence: {
        financialGuard: {
          financialOperation: 'market_sell_quote',
          guardName: 'available_position_quantity',
        },
      },
    });
    const position = await this.prisma.position.findUnique({
      where: {
        tradingAccountId_assetId: {
          tradingAccountId: input.tradingAccountId,
          assetId: input.assetId,
        },
      },
      select: {
        tradingAccountId: true,
        quantity: true,
        reservedQuantity: true,
      },
    });

    if (position) {
      this.assertPositionTradingScope(position, {
        tradingAccountId: input.tradingAccountId,
      });
    }

    // A manual Market sell will atomically cancel its own protection child.
    // Normal reservations remain unavailable. This is only a quote preview.
    const ownChild = position?.reservedQuantity?.gt(0)
      ? await this.prisma.protectionChild.findFirst({
          where: {
            status: 'pending',
            group: {
              tradingAccountId: input.tradingAccountId,
              assetId: input.assetId,
              domain: 'spot',
              status: 'active',
            },
            order: { status: 'submitted', side: 'sell', orderType: 'limit' },
          },
          select: { order: { select: { reservedQuantity: true } } },
        })
      : null;
    const releasable =
      ownChild?.order?.reservedQuantity ?? new Prisma.Decimal(0);
    if (
      !position ||
      position.quantity
        .sub(position.reservedQuantity ?? new Prisma.Decimal(0))
        .add(releasable)
        .lt(input.quantity)
    ) {
      setAdminDiagnosticContext({
        evidence: {
          financialGuard: {
            financialOperation: 'market_sell_quote',
            guardName: 'available_position_quantity',
            scopeValid: position ? true : undefined,
            ...positionAvailabilityEvidence(position, input.quantity),
          },
        },
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_QUANTITY',
        'Position quantity is insufficient.',
      );
    }

    const wallet = await this.prisma.cashWallet.findUnique({
      where: {
        tradingAccountId_walletScope_currencyCode: {
          walletScope: input.walletScope,
          tradingAccountId: input.tradingAccountId,
          currencyCode: input.currencyCode,
        },
      },
      select: {
        walletScope: true,
        id: true,
        tradingAccountId: true,
        balanceAmount: true,
      },
    });

    if (wallet) {
      assertCashWalletTradingAccountScope(wallet, {
        tradingAccountId: input.tradingAccountId,
        walletScope: input.walletScope,
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
      ...(quote.request.amount
        ? { amount: this.formatDecimal(quote.request.amount, monetaryScale) }
        : {}),
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
    asset: Pick<OrderAsset, 'assetType' | 'market'> & { id?: string },
    now: Date,
    orderType: OrderType = OrderType.market,
  ) {
    try {
      assertOrderSessionAllowed(asset, now, orderType);
    } catch (error) {
      if (error instanceof MarketHoursError) {
        const market = resolveCalendarMarket(asset);
        const sessionState = resolveStockMarketSessionState(asset, now);
        setAdminDiagnosticContext({
          failureStage: 'market_session_validation',
          entities: { assetId: asset.id },
          evidence: {
            market,
            evaluatedAt: now,
            marketState: sessionState,
            calendarOverrideRuntime: getMarketSessionOverrideRuntimeStatus(),
            selectionResult: 'REJECTED',
            rejectedReason: error.code,
            normalCriteria:
              orderType === OrderType.limit
                ? 'The calendar must be available; confirmed CLOSED permits registration.'
                : 'The asset market session must be open.',
          },
          nextInvestigation: [
            'backend/src/orders/market-hours.policy.ts',
            'backend/src/orders/market-calendar.policy.ts',
          ],
        });
        recordAdminDiagnosticEvent(
          'warn',
          'ORDER_MARKET_SESSION_REJECTED',
          `Order market-session validation failed with ${error.code}.`,
          { market, evaluatedAt: now },
        );
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

  /** A season participant must resolve to its canonical trading account. */
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
   * Execution-time scope resolution for an existing order. Season policy is
   * reached through TradingAccount -> SeasonParticipant.
   */
  private requireOrderTradingScope(order: {
    tradingAccountId: string | null;
    tradingAccount: {
      id: string;
      mode: TradingAccountMode;
      seasonParticipant: {
        id?: string;
        tradingAccountId: string | null;
      } | null;
    } | null;
  }): string {
    if (!order.tradingAccountId) {
      setAdminDiagnosticContext({
        failureStage: 'order_scope_validation',
        evidence: {
          financialScope: {
            entityType: 'order',
            check: 'canonical_account_relation',
            scopeValid: false,
          },
        },
      });
      this.throwTradingScopeIntegrityError(
        'TRADING_SCOPE_REPAIR_REQUIRED',
        'Order has no canonical trading account scope.',
      );
    }

    if (
      !order.tradingAccount ||
      order.tradingAccount.id !== order.tradingAccountId
    ) {
      setAdminDiagnosticContext({
        failureStage: 'order_scope_validation',
        evidence: {
          financialScope: {
            entityType: 'order',
            check: 'canonical_account_relation',
            scopeValid: false,
          },
        },
      });
      this.throwTradingScopeIntegrityError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Order trading-account relation does not match its account scope.',
      );
    }

    if (isStandaloneAccountMode(order.tradingAccount.mode)) {
      if (order.tradingAccount.seasonParticipant !== null) {
        setAdminDiagnosticContext({
          failureStage: 'order_scope_validation',
          evidence: {
            financialScope: {
              entityType: 'order',
              check: 'canonical_account_relation',
              scopeValid: false,
            },
          },
        });
        this.throwTradingScopeIntegrityError(
          'TRADING_ACCOUNT_SCOPE_MISMATCH',
          'General order carries a season participant link.',
        );
      }
      return order.tradingAccountId;
    }

    const participantAccountId =
      order.tradingAccount.seasonParticipant?.tradingAccountId;
    if (!participantAccountId) {
      setAdminDiagnosticContext({
        failureStage: 'order_scope_validation',
        evidence: {
          financialScope: {
            entityType: 'order',
            check: 'participant_account_link',
            scopeValid: false,
          },
        },
      });
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'TRADING_ACCOUNT_LINK_INTEGRITY',
        'Season order has no valid participant account link; run trading-accounts:repair-links.',
      );
    }

    if (order.tradingAccountId !== participantAccountId) {
      setAdminDiagnosticContext({
        failureStage: 'order_scope_validation',
        evidence: {
          financialScope: {
            entityType: 'order',
            check: 'canonical_account_relation',
            scopeValid: false,
          },
        },
      });
      this.throwTradingScopeIntegrityError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Season order account and participant link do not agree.',
      );
    }

    return order.tradingAccountId;
  }

  /**
   * A position touched by an execution must carry the same verified account
   * scope as the order.
   */
  private assertPositionTradingScope(
    position: {
      tradingAccountId: string | null;
    },
    expected: {
      tradingAccountId: string;
    },
  ): void {
    if (position.tradingAccountId == null) {
      setAdminDiagnosticContext({
        evidence: {
          financialScope: {
            entityType: 'position',
            check: 'canonical_account_present',
            scopeValid: false,
            failureReason: 'null_scope',
          },
        },
      });
      this.throwTradingScopeIntegrityError(
        'TRADING_SCOPE_REPAIR_REQUIRED',
        'Position has no canonical trading account scope.',
      );
    }

    if (position.tradingAccountId !== expected.tradingAccountId) {
      setAdminDiagnosticContext({
        evidence: {
          financialScope: {
            entityType: 'position',
            check: 'account_matches',
            scopeValid: false,
            failureReason: 'account_scope_mismatch',
          },
        },
      });
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
    cause?: unknown,
  ): never {
    recordAdminDiagnosticEvent(
      status >= HttpStatus.INTERNAL_SERVER_ERROR ? 'error' : 'warn',
      'ORDER_ERROR_THROWN',
      `${code}: ${message}`,
      { httpStatus: status },
    );
    const exception = new HttpException(
      this.createErrorBody(code, message),
      status,
    );
    throw cause === undefined
      ? exception
      : preserveAdminFailureCause(exception, cause);
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
    /** The fill's verified canonical account scope. */
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
