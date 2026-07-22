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
  formatCurrency,
  formatKrw,
  formatMoney,
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

export function getOrderQuoteDisplay(quote: OrderQuoteDto) {
  return {
    quoteId: displayValue(quote.quoteId),
    price: formatMoney(quote.price, quote.currencyCode),
    quantity: displayValue(quote.quantity),
    grossAmount: formatCurrency(quote.grossAmount, quote.currencyCode),
    feeRate: displayValue(quote.feeRate),
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
    positionQuantityBefore: displayValue(quote.positionQuantityBefore),
    estimatedPositionQuantityAfter: displayValue(
      quote.estimatedPositionQuantityAfter,
    ),
    krwGrossAmount: formatKrw(quote.krwGrossAmount),
    krwFeeAmount: formatKrw(quote.krwFeeAmount),
    krwNetAmount: formatKrw(quote.krwNetAmount),
    expiresAt: displayValue(quote.expiresAt),
    maxChangeBps: displayValue(quote.maxChangeBps),
    quoteAt: displayValue(quote.quoteAt),
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

export function getLimitOrderSuccessMessage(
  policy?: LimitOrderExecutionPolicyDto | null,
) {
  return policy?.autoExecutionEnabled
    ? '유효한 실시간 체결가격이 지정가 이하로 처리되면 전량 자동 체결됩니다. 주문장 유동성과 거래량은 반영하지 않습니다.'
    : '현재 단계에서는 주문이 미체결 상태로 등록됩니다. 예약된 금액은 주문을 취소하면 다시 사용할 수 있습니다.';
}

/**
 * Quote-time estimates for an unfilled limit buy. These are the ONLY figures
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
    | 'reservedAmount'
    | 'currencyCode'
  > | null,
) {
  if (!quote) return null;

  const reserved = quote.quotedReservedAmount ?? quote.reservedAmount;
  if (!quote.quotedGrossAmount && !quote.quotedFeeAmount && !reserved) {
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
    quotedFeeRate: displayValue(quote.quotedFeeRate),
    reservedAmount: formatCurrency(reserved, quote.currencyCode),
  };
}

export function getOrderSuccessDisplay(result: CreateOrderDto) {
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
    quantity: displayValue(order.quantity ?? execution.quantity),
    executedPrice: isSubmittedLimit
      ? displayValue(null)
      : formatMoney(
          execution.executedPrice ?? execution.executePrice ?? order.price,
          currencyCode,
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
    submittedAt: displayValue(execution.submittedAt ?? order.submittedAt),
    executedAt: isSubmittedLimit
      ? displayValue(null)
      : displayValue(execution.executedAt),
    quotedPrice: formatCurrency(execution.quotedPrice, currencyCode),
    executePrice: formatCurrency(execution.executePrice, currencyCode),
    priceChangeBps: displayValue(execution.priceChangeBps),
    quotedRate: displayValue(execution.quotedRate),
    executeRate: displayValue(execution.executeRate),
    rateChangeBps: displayValue(execution.rateChangeBps),
    assetPriceSource: formatSourceMetadata(execution.assetPriceSource),
    fxRateSource: formatSourceMetadata(execution.fxRateSource),
    walletBalanceAfter: formatCurrency(
      execution.walletBalanceAfter,
      currencyCode,
    ),
    limitPrice: formatMoney(order.limitPrice, currencyCode),
    reservedAmount: formatCurrency(
      execution.reservedAmount ?? order.reservedAmount,
      currencyCode,
    ),
    reservationFeeRate: displayValue(execution.reservationFeeRate),
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
