import type { CreateOrderDto, OrderQuoteDto } from './api';
import {
  isIdempotencyConflictError,
  isRequoteRequiredError,
} from '../../services/api/errorMapper';
import { formatSourceMetadata } from '../../models/dto/common';

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
    price: `${displayValue(quote.price)} ${quote.currencyCode}`,
    quantity: displayValue(quote.quantity),
    grossAmount: displayValue(quote.grossAmount),
    feeRate: displayValue(quote.feeRate),
    feeAmount: displayValue(quote.feeAmount),
    netAmount: displayValue(quote.netAmount),
    walletBalanceBefore: displayValue(quote.walletBalanceBefore),
    estimatedWalletBalanceAfter: displayValue(
      quote.estimatedWalletBalanceAfter,
    ),
    positionQuantityBefore: displayValue(quote.positionQuantityBefore),
    estimatedPositionQuantityAfter: displayValue(
      quote.estimatedPositionQuantityAfter,
    ),
    krwGrossAmount: displayValue(quote.krwGrossAmount),
    krwFeeAmount: displayValue(quote.krwFeeAmount),
    krwNetAmount: displayValue(quote.krwNetAmount),
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

  return {
    orderId: displayValue(order.id ?? order.orderId ?? execution.orderId),
    quoteId: displayValue(order.quoteId ?? execution.quoteId),
    assetLabel:
      asset?.symbol && asset?.name
        ? `${asset.symbol} · ${asset.name}`
        : displayValue(asset?.symbol ?? asset?.name ?? order.assetId ?? execution.assetId),
    side: order.side ?? execution.side,
    quantity: displayValue(order.quantity ?? execution.quantity),
    executedPrice: `${displayValue(
      execution.executedPrice ?? execution.executePrice ?? order.price,
    )} ${currencyCode}`,
    currencyCode: displayValue(currencyCode),
    grossAmount: displayValue(execution.grossAmount ?? order.grossAmount),
    feeAmount: displayValue(execution.feeAmount ?? order.feeAmount),
    netAmount: displayValue(execution.netAmount ?? order.netAmount),
    submittedAt: displayValue(execution.submittedAt ?? order.submittedAt),
    executedAt: displayValue(execution.executedAt),
    quotedPrice: displayValue(execution.quotedPrice),
    executePrice: displayValue(execution.executePrice),
    priceChangeBps: displayValue(execution.priceChangeBps),
    quotedRate: displayValue(execution.quotedRate),
    executeRate: displayValue(execution.executeRate),
    rateChangeBps: displayValue(execution.rateChangeBps),
    assetPriceSource: formatSourceMetadata(execution.assetPriceSource),
    fxRateSource: formatSourceMetadata(execution.fxRateSource),
    walletBalanceAfter: displayValue(execution.walletBalanceAfter),
    isAlreadyExecuted: execution.state === 'already_executed',
  };
}

export function isOrderRequoteRequiredCode(code?: string | null) {
  return isRequoteRequiredError(code);
}

export function isOrderIdempotencyConflictCode(code?: string | null) {
  return isIdempotencyConflictError(code);
}
