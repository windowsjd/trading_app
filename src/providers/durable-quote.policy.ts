import { createHash } from 'node:crypto';
import {
  CurrencyCode,
  OrderSide,
  OrderType,
  Prisma,
} from '../generated/prisma/client';
import { formatMoneyScale8 } from '../fx/fx-decimal-policy';
import { DEFAULT_QUOTE_TTL_SECONDS } from './realtime-execution-policy';

export const FX_QUOTE_REQUEST_HASH_API_VERSION = 'fx-quote:v1' as const;
export const ORDER_QUOTE_REQUEST_HASH_API_VERSION = 'order-quote:v1' as const;

type DecimalInput = string | Prisma.Decimal;

export type FxQuoteRequestHashInput = {
  userId: string;
  seasonParticipantId: string;
  fromCurrency: CurrencyCode | string;
  toCurrency: CurrencyCode | string;
  sourceAmount: DecimalInput;
};

export type OrderQuoteRequestHashInput = {
  userId: string;
  seasonParticipantId: string;
  assetId: string;
  side: OrderSide | string;
  orderType: OrderType | string;
  quantity: DecimalInput;
  limitPrice: DecimalInput | null;
  currencyCode: CurrencyCode | string;
};

export function buildQuoteExpiresAt(
  quoteAt: Date,
  ttlSeconds = DEFAULT_QUOTE_TTL_SECONDS,
): Date {
  return new Date(quoteAt.getTime() + ttlSeconds * 1000);
}

export function computeFxQuoteRequestHash(
  input: FxQuoteRequestHashInput,
): string {
  return sha256Json({
    apiVersion: FX_QUOTE_REQUEST_HASH_API_VERSION,
    userId: normalizeRequiredString(input.userId, 'userId'),
    seasonParticipantId: normalizeRequiredString(
      input.seasonParticipantId,
      'seasonParticipantId',
    ),
    fromCurrency: normalizeCurrency(input.fromCurrency, 'fromCurrency'),
    toCurrency: normalizeCurrency(input.toCurrency, 'toCurrency'),
    sourceAmount: formatMoneyScale8(input.sourceAmount),
  });
}

export function computeOrderQuoteRequestHash(
  input: OrderQuoteRequestHashInput,
): string {
  return sha256Json({
    apiVersion: ORDER_QUOTE_REQUEST_HASH_API_VERSION,
    userId: normalizeRequiredString(input.userId, 'userId'),
    seasonParticipantId: normalizeRequiredString(
      input.seasonParticipantId,
      'seasonParticipantId',
    ),
    assetId: normalizeRequiredString(input.assetId, 'assetId'),
    side: normalizeRequiredString(input.side, 'side'),
    orderType: normalizeRequiredString(input.orderType, 'orderType'),
    quantity: formatMoneyScale8(input.quantity),
    limitPrice: input.limitPrice ? formatMoneyScale8(input.limitPrice) : null,
    currencyCode: normalizeCurrency(input.currencyCode, 'currencyCode'),
  });
}

function sha256Json(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function normalizeCurrency(value: unknown, fieldName: string): string {
  return normalizeRequiredString(value, fieldName).toUpperCase();
}
