import type { CreateOrderDto, OrderQuoteDto } from './api';
import {
  isIdempotencyConflictError,
  isRequoteRequiredError,
} from '../../services/api/errorMapper';
import { formatSourceMetadata } from '../../models/dto/common';
import { formatCurrency, formatKrw, getAssetNameDisplay } from '../../utils/format';

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
    price: `${formatCurrency(quote.price, quote.currencyCode)} ${quote.currencyCode}`,
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
    result?.execution?.state === 'already_executed'
  );
}

export function getOrderSuccessDisplay(result: CreateOrderDto) {
  const order = result.order;
  const execution = result.execution;
  const asset = order.asset;
  const currencyCode = execution.currencyCode ?? order.currencyCode ?? '';

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
    executedPrice: `${formatCurrency(
      execution.executedPrice ?? execution.executePrice ?? order.price,
      currencyCode,
    )} ${currencyCode}`,
    currencyCode: displayValue(currencyCode),
    grossAmount: formatCurrency(
      execution.grossAmount ?? order.grossAmount,
      currencyCode,
    ),
    feeAmount: formatCurrency(execution.feeAmount ?? order.feeAmount, currencyCode),
    netAmount: formatCurrency(execution.netAmount ?? order.netAmount, currencyCode),
    submittedAt: displayValue(execution.submittedAt ?? order.submittedAt),
    executedAt: displayValue(execution.executedAt),
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
    isAlreadyExecuted: execution.state === 'already_executed',
  };
}

export function isOrderRequoteRequiredCode(code?: string | null) {
  return isRequoteRequiredError(code);
}

export function isOrderIdempotencyConflictCode(code?: string | null) {
  return isIdempotencyConflictError(code);
}
