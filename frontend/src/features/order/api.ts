import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  BpsString,
  IsoDateTimeString,
  MoneyString,
  QuantityString,
  RateString,
  SectionState,
  SourceMetadata,
} from '../../models/dto/common';
import type { AssetType, CurrencyCode } from '../market/api';

export type OrderSide = 'buy' | 'sell';
export type OrderTypeDto = 'market' | 'limit';

export interface OrderQuoteRequestDto {
  assetId: string;
  side: OrderSide;
  quantity: QuantityString;
  /** Omitted → market (historical default). */
  orderType?: OrderTypeDto;
  /** Required when orderType='limit'; forbidden for market. */
  limitPrice?: MoneyString;
}

export interface OrderQuoteAssetDto {
  id: string;
  assetType?: AssetType;
  symbol?: string;
  name?: string;
  market?: string;
  priceCurrency?: CurrencyCode;
  settlementCurrency?: CurrencyCode;
}

export interface OrderQuoteDto {
  state: SectionState;
  season?: Record<string, unknown> | null;
  participant?: Record<string, unknown> | null;
  asset: OrderQuoteAssetDto;
  side: OrderSide;
  orderType: string;
  quantity: QuantityString;
  price: MoneyString;
  currencyCode: CurrencyCode;
  grossAmount: MoneyString;
  feeRate: RateString;
  feeAmount: MoneyString;
  netAmount: MoneyString;
  walletBalanceBefore: MoneyString;
  estimatedWalletBalanceAfter: MoneyString;
  positionQuantityBefore: QuantityString;
  estimatedPositionQuantityAfter: QuantityString;
  krwGrossAmount?: MoneyString | null;
  krwFeeAmount?: MoneyString | null;
  krwNetAmount?: MoneyString | null;
  assetPriceSnapshotId?: string | null;
  fxRateSnapshotId?: string | null;
  assetPriceSource?: SourceMetadata;
  fxRateSource?: SourceMetadata;
  quoteId: string;
  expiresAt: IsoDateTimeString;
  maxChangeBps: BpsString | number;
  quoteAt: IsoDateTimeString;
  // Limit-buy additive fields (present only on limit quotes). All amounts
  // are server-final decimal strings — the client never re-derives them.
  limitPrice?: MoneyString;
  /**
   * Reservation basis pinned on the durable quote. The server reserves exactly
   * quotedReservedAmount at quotedFeeRate when this quote is used to create,
   * even if the season fee rate changes in between — so these are the only
   * numbers that may be shown as the order's expected cost.
   * quotedGross/quotedFee are ESTIMATES for an unfilled order, never a fill.
   * reservedAmount is the pre-existing alias of quotedReservedAmount.
   */
  quotedFeeRate?: RateString;
  quotedGrossAmount?: MoneyString;
  quotedFeeAmount?: MoneyString;
  quotedReservedAmount?: MoneyString;
  reservedAmount?: MoneyString;
  walletReservedBefore?: MoneyString;
  walletAvailableBefore?: MoneyString;
  estimatedReservedAfter?: MoneyString;
  estimatedAvailableAfter?: MoneyString;
}

export interface CreateOrderRequestDto {
  quoteId: string;
  assetId: string;
  side: OrderSide;
  quantity: QuantityString;
  idempotencyKey: string;
  /** Omitted → market (historical default). */
  orderType?: OrderTypeDto;
  /** Required when orderType='limit'; must equal the quoted limitPrice. */
  limitPrice?: MoneyString;
}

export interface CreatedOrderDto {
  id?: string;
  orderId?: string;
  quoteId?: string;
  assetId?: string;
  asset?: OrderQuoteAssetDto | null;
  side?: OrderSide;
  orderType?: string;
  status?: string;
  quantity?: QuantityString;
  price?: MoneyString;
  limitPrice?: MoneyString | null;
  currencyCode?: CurrencyCode;
  /**
   * ACTUAL execution result. Null until the order really fills — a submitted
   * or canceled limit order always has all three null, because phase 1 has no
   * matching engine. Never render these as an unfilled order's amounts.
   */
  grossAmount?: MoneyString | null;
  feeAmount?: MoneyString | null;
  netAmount?: MoneyString | null;
  executedPrice?: MoneyString | null;
  executedAt?: IsoDateTimeString | null;
  /** Unfilled limit buy: cash locked by the reservation, not a fill amount. */
  reservedAmount?: MoneyString | null;
  reservationReleasedAt?: IsoDateTimeString | null;
  cancelReason?: string | null;
  submittedAt?: IsoDateTimeString;
  createdAt?: IsoDateTimeString;
}

export type OrderExecutionState =
  | 'executed'
  | 'already_executed'
  // Limit-buy phase 1: the order is registered unfilled. No automatic
  // execution exists yet — it stays submitted until canceled/cleaned up.
  | 'submitted'
  | (string & {});

export interface OrderExecutionDto {
  state: OrderExecutionState;
  executionId?: string;
  orderId?: string;
  quoteId?: string;
  assetId?: string;
  side?: OrderSide;
  quantity?: QuantityString;
  executedPrice?: MoneyString;
  quotedPrice?: MoneyString;
  executePrice?: MoneyString;
  priceChangeBps?: BpsString | number | null;
  currencyCode?: CurrencyCode;
  grossAmount?: MoneyString;
  feeAmount?: MoneyString;
  netAmount?: MoneyString;
  submittedAt?: IsoDateTimeString;
  executedAt?: IsoDateTimeString;
  quotedRate?: RateString | null;
  executeRate?: RateString | null;
  rateChangeBps?: BpsString | number | null;
  assetPriceSource?: SourceMetadata;
  fxRateSource?: SourceMetadata;
  assetPriceSnapshotId?: string | null;
  fxRateSnapshotId?: string | null;
  walletTransactionId?: string | null;
  positionId?: string | null;
  equitySnapshotId?: string | null;
  duplicate?: boolean;
  walletBalanceAfter?: MoneyString | null;
  // Limit-buy additive fields (state='submitted' responses).
  reservedAmount?: MoneyString | null;
  reservationFeeRate?: RateString | null;
}

export interface CreateOrderDto {
  order: CreatedOrderDto;
  execution: OrderExecutionDto;
}

export async function quoteOrder(payload: OrderQuoteRequestDto) {
  const response = await apiClient.post<ApiSuccessResponse<OrderQuoteDto>>(
    '/orders/quote',
    payload,
  );

  return response.data.data;
}

export async function createOrder(payload: CreateOrderRequestDto) {
  const response = await apiClient.post<ApiSuccessResponse<CreateOrderDto>>(
    '/orders',
    payload,
  );

  return response.data.data;
}

export interface CancelOrderDto {
  order: CreatedOrderDto;
  execution: {
    state: 'not_executed' | (string & {});
    reason?: string;
    message?: string;
    alreadyCanceled?: boolean;
    reservedAmountReleased?: MoneyString | null;
  };
}

/** Cancels a submitted limit-buy order and releases its cash reservation. */
export async function cancelOrder(orderId: string) {
  const response = await apiClient.post<ApiSuccessResponse<CancelOrderDto>>(
    `/orders/${orderId}/cancel`,
  );

  return response.data.data;
}
