import type {
  CreateOrderDto,
  LimitOrderExecutionPolicyDto,
  OrderQuoteDto,
} from './api';
import {
  isIdempotencyConflictError,
  isRequoteRequiredError,
} from '../../services/api/errorMapper.ts';
import { formatSourceMetadata } from '../../models/dto/common.ts';
import {
  formatAssetPrice,
  formatCurrency,
  formatDisplayDecimal,
  formatKstDateTime,
  formatKrw,
  getAssetNameDisplay,
} from '../../utils/format.ts';

function parseTimestamp(value?: string | null) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getNowTimestamp(now?: Date | number) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  return Date.now();
}

function displayValue(value?: string | number | boolean | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

export function isOrderQuoteExpired(
  quote?: Pick<OrderQuoteDto, 'expiresAt'> | null,
  now?: Date | number,
) {
  const expiresAt = parseTimestamp(quote?.expiresAt);
  if (expiresAt === null) return true;

  return expiresAt <= getNowTimestamp(now);
}

export function getOrderQuoteExpiresInSeconds(
  quote?: Pick<OrderQuoteDto, 'expiresAt'> | null,
  now?: Date | number,
) {
  const expiresAt = parseTimestamp(quote?.expiresAt);
  if (expiresAt === null) return 0;

  return Math.max(0, Math.floor((expiresAt - getNowTimestamp(now)) / 1000));
}

/**
 * `displayPriceDecimals` (from the asset DTO) applies to the UNIT price only.
 * Money totals — gross/fee/net/wallet — keep the currency's own formatting so a
 * crypto tick size never widens an amount column.
 */
export function getOrderQuoteDisplay(
  quote: OrderQuoteDto,
  displayPriceDecimals?: number | null,
) {
  return {
    quoteId: displayValue(quote.quoteId),
    price: formatAssetPrice(
      quote.price,
      quote.currencyCode,
      displayPriceDecimals,
    ),
    quantity: formatDisplayDecimal(quote.quantity),
    grossAmount: formatCurrency(quote.grossAmount, quote.currencyCode),
    feeRate: formatDisplayDecimal(quote.feeRate),
    feeAmount: formatCurrency(quote.feeAmount, quote.currencyCode),
    netAmount: formatCurrency(quote.netAmount, quote.currencyCode),
    walletBalanceBefore: formatCurrency(
      quote.walletBalanceBefore,
      quote.currencyCode,
    ),
    estimatedWalletBalanceAfter: formatCurrency(
      quote.estimatedWalletBalanceAfter,
      quote.currencyCode,
    ),
    positionQuantityBefore: formatDisplayDecimal(quote.positionQuantityBefore),
    estimatedPositionQuantityAfter: formatDisplayDecimal(
      quote.estimatedPositionQuantityAfter,
    ),
    krwGrossAmount: formatKrw(quote.krwGrossAmount),
    krwFeeAmount: formatKrw(quote.krwFeeAmount),
    krwNetAmount: formatKrw(quote.krwNetAmount),
    expiresAt: formatKstDateTime(quote.expiresAt),
    maxChangeBps: formatDisplayDecimal(quote.maxChangeBps),
    quoteAt: formatKstDateTime(quote.quoteAt),
    assetPriceSource: formatSourceMetadata(quote.assetPriceSource),
    fxRateSource: formatSourceMetadata(quote.fxRateSource),
  };
}

export function isOrderSuccess(result: CreateOrderDto | null | undefined) {
  return (
    result?.execution?.state === 'executed' ||
    result?.execution?.state === 'already_executed' ||
    // A submitted limit registration is a successful create outcome; any
    // later path-A fill is observed through order/record refetch.
    result?.execution?.state === 'submitted'
  );
}

/** True when the create result is an unfilled limit-buy registration. */
export function isSubmittedLimitOrder(
  result: CreateOrderDto | null | undefined,
) {
  return result?.execution?.state === 'submitted';
}

/**
 * Server-authoritative limit-order execution copy. The auto-execution branch is
 * driven by executionPolicy.autoExecutionEnabled. It deliberately avoids
 * "실시간" (path B fills off a closed 5m candle, up to a few minutes late) and
 * never promises live-exchange execution — this is a virtual fill system.
 */
export function getLimitOrderSuccessMessage(
  policy?: LimitOrderExecutionPolicyDto | null,
  side: 'buy' | 'sell' = 'buy',
) {
  const reservation = side === 'buy' ? '금액' : '수량';
  const trigger = side === 'buy' ? '이하' : '이상';
  if (!policy?.autoExecutionEnabled) {
    return `주문이 미체결 상태로 등록됩니다. 예약된 ${reservation}은 주문을 취소하면 다시 사용할 수 있습니다.`;
  }
  return `유효한 체결가격이 지정가 ${trigger}가 되면 전량 자동 체결됩니다. 체결까지 수 분 지연될 수 있으며, 주문장 유동성과 거래량은 반영하지 않습니다.`;
}

/**
 * Quote-time estimates for an unfilled limit order. These are the ONLY figures
 * that may be presented as a submitted order's expected cost, and every label
 * rendering them must say 예상/예약 — nothing here is an execution result.
 * Returns null for a market quote, which has no pinned reservation basis.
 */
export function getLimitQuoteEstimateDisplay(
  quote?: Pick<
    OrderQuoteDto,
    | 'quotedGrossAmount'
    | 'quotedFeeAmount'
    | 'quotedFeeRate'
    | 'quotedReservedAmount'
    | 'quotedNetAmount'
    | 'reservedAmount'
    | 'reservedQuantity'
    | 'currencyCode'
  > | null,
) {
  if (!quote) return null;

  const reserved = quote.quotedReservedAmount ?? quote.reservedAmount;
  if (
    !quote.quotedGrossAmount &&
    !quote.quotedFeeAmount &&
    !quote.quotedNetAmount &&
    !reserved &&
    !quote.reservedQuantity
  ) {
    return null;
  }

  return {
    estimatedGrossAmount: formatCurrency(
      quote.quotedGrossAmount,
      quote.currencyCode,
    ),
    estimatedFeeAmount: formatCurrency(
      quote.quotedFeeAmount,
      quote.currencyCode,
    ),
    quotedFeeRate: formatDisplayDecimal(quote.quotedFeeRate),
    reservedAmount: formatCurrency(reserved, quote.currencyCode),
    expectedNetAmount: formatCurrency(
      quote.quotedNetAmount,
      quote.currencyCode,
    ),
    reservedQuantity: formatDisplayDecimal(quote.reservedQuantity),
  };
}

export function getOrderSuccessDisplay(
  result: CreateOrderDto,
  displayPriceDecimals?: number | null,
) {
  const order = result.order;
  const execution = result.execution;
  const asset = order.asset;
  const currencyCode = execution.currencyCode ?? order.currencyCode ?? '';
  // A submitted limit registration has no fill, so every execution-result
  // field is suppressed at the mapper rather than trusted to stay absent —
  // a stale server field or a future screen must not be able to render an
  // unfilled order as if it had executed.
  const isSubmittedLimit = execution.state === 'submitted';

  const assetNameDisplay = asset ? getAssetNameDisplay(asset) : null;

  return {
    orderId: displayValue(order.id ?? order.orderId ?? execution.orderId),
    quoteId: displayValue(order.quoteId ?? execution.quoteId),
    assetLabel: assetNameDisplay
      ? assetNameDisplay.secondary
        ? `${assetNameDisplay.primary} · ${assetNameDisplay.secondary}`
        : assetNameDisplay.primary
      : displayValue(order.assetId ?? execution.assetId),
    side: order.side ?? execution.side,
    quantity: formatDisplayDecimal(order.quantity ?? execution.quantity),
    executedPrice: isSubmittedLimit
      ? displayValue(null)
      : formatAssetPrice(
          execution.executedPrice ?? execution.executePrice ?? order.price,
          currencyCode,
          displayPriceDecimals,
        ),
    currencyCode: displayValue(currencyCode),
    grossAmount: isSubmittedLimit
      ? displayValue(null)
      : formatCurrency(
          execution.grossAmount ?? order.grossAmount,
          currencyCode,
        ),
    feeAmount: isSubmittedLimit
      ? displayValue(null)
      : formatCurrency(execution.feeAmount ?? order.feeAmount, currencyCode),
    netAmount: isSubmittedLimit
      ? displayValue(null)
      : formatCurrency(execution.netAmount ?? order.netAmount, currencyCode),
    submittedAt: formatKstDateTime(
      execution.submittedAt ?? order.submittedAt,
    ),
    executedAt: isSubmittedLimit
      ? displayValue(null)
      : formatKstDateTime(execution.executedAt),
    quotedPrice: formatAssetPrice(
      execution.quotedPrice,
      currencyCode,
      displayPriceDecimals,
    ),
    executePrice: formatAssetPrice(
      execution.executePrice,
      currencyCode,
      displayPriceDecimals,
    ),
    priceChangeBps: formatDisplayDecimal(execution.priceChangeBps),
    quotedRate: formatDisplayDecimal(execution.quotedRate),
    executeRate: formatDisplayDecimal(execution.executeRate),
    rateChangeBps: formatDisplayDecimal(execution.rateChangeBps),
    assetPriceSource: formatSourceMetadata(execution.assetPriceSource),
    fxRateSource: formatSourceMetadata(execution.fxRateSource),
    walletBalanceAfter: formatCurrency(
      execution.walletBalanceAfter,
      currencyCode,
    ),
    limitPrice: formatAssetPrice(
      order.limitPrice,
      currencyCode,
      displayPriceDecimals,
    ),
    reservedAmount: formatCurrency(
      execution.reservedAmount ?? order.reservedAmount,
      currencyCode,
    ),
    reservedQuantity: formatDisplayDecimal(
      execution.reservedQuantity ?? order.reservedQuantity,
    ),
    reservationFeeRate: formatDisplayDecimal(execution.reservationFeeRate),
    isAlreadyExecuted: execution.state === 'already_executed',
    isSubmittedLimitOrder: isSubmittedLimit,
  };
}

export function isOrderRequoteRequiredCode(code?: string | null) {
  return isRequoteRequiredError(code);
}

export function isOrderIdempotencyConflictCode(code?: string | null) {
  return isIdempotencyConflictError(code);
}
