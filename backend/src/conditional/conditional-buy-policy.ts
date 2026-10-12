import { createApiError } from '../common/api-error';
import {
  Prisma,
  type ConditionalBuyTrigger,
  type CurrencyCode,
} from '../generated/prisma/client';
import { conditionalHash, conditionalKey } from './conditional-policy';
import { conditionalBuyEnabled } from './conditional-buy.config';

export { conditionalBuyEnabled } from './conditional-buy.config';

/** New watches and triggers only; read/cancel/lifecycle cleanup stay open. */
export function assertConditionalBuyEnabled() {
  if (!conditionalBuyEnabled())
    throw createApiError(
      'CONDITIONAL_BUY_DISABLED',
      'Conditional buy orders are currently disabled.',
      409,
    );
}

/** Bounds the watched set per account and therefore the worker scan. */
export const CONDITIONAL_BUY_MAX_LIVE_PER_ACCOUNT = 20;
/** A trigger older than this never becomes an order (restart/outage safety). */
export const CONDITIONAL_BUY_EXECUTION_WINDOW_MS = 30_000;
export const CONDITIONAL_BUY_MAX_ATTEMPTS = 3;

/**
 * Transient execution outcomes that may succeed on the next worker cycle
 * inside the execution window. Every other code (insufficient cash, closed
 * market, account/Season gates, beginner lock, input policy, conflicts with
 * protection) fails the watch immediately: no forced fill, no endless retry.
 */
const RETRYABLE_EXECUTION_CODES = new Set([
  'ASSET_PRICE_UNAVAILABLE',
  'PRICE_STALE',
  'EXECUTION_EVIDENCE_UNAVAILABLE',
  'EXECUTION_SOURCE_INELIGIBLE',
  'ORDER_LIQUIDITY_UNAVAILABLE',
  'FX_RATE_UNAVAILABLE',
  'FX_RATE_STALE',
  'PROVIDER_RATE_UNAVAILABLE',
  'PROVIDER_RATE_STALE',
  'RATE_CHANGED_REQUOTE_REQUIRED',
  'QUOTE_EXPIRED',
  'ORDER_QUOTE_EXPIRED',
  'QUOTE_NOT_ACTIVE',
  'ORDER_EXECUTION_CONFLICT',
  'ORDER_RESERVATION_CONFLICT',
  'ORDER_EXECUTION_TRANSACTION_FAILED',
  'CONDITIONAL_BUY_EXECUTION_FAILED',
]);

export function isRetryableConditionalBuyFailure(code: string) {
  return RETRYABLE_EXECUTION_CODES.has(code);
}

export type ConditionalBuyInput = {
  assetId: string;
  triggerCondition: ConditionalBuyTrigger;
  triggerPrice: Prisma.Decimal;
  executionType: 'market' | 'limit';
  limitPrice: Prisma.Decimal | null;
  quantity: Prisma.Decimal | null;
  amount: Prisma.Decimal | null;
  currencyCode: CurrencyCode | null;
  idempotencyKey: string;
};

export type ConditionalBuyBody = {
  assetId?: unknown;
  triggerCondition?: unknown;
  triggerPrice?: unknown;
  executionType?: unknown;
  limitPrice?: unknown;
  quantity?: unknown;
  amount?: unknown;
  currencyCode?: unknown;
  idempotencyKey?: unknown;
};

/**
 * Shape-only parsing. Asset-specific input rules (crypto BUY amount, stock
 * quantity, integer stock limit) are applied against the asset afterwards by
 * the existing order input policy.
 */
export function parseConditionalBuyBody(
  body: ConditionalBuyBody | undefined,
): ConditionalBuyInput {
  const row: ConditionalBuyBody = body && typeof body === 'object' ? body : {};
  const idempotencyKey = conditionalKey(row.idempotencyKey);
  if (typeof row.assetId !== 'string' || !row.assetId.trim())
    invalid('Specify an asset.');
  if (
    row.triggerCondition !== 'at_or_above' &&
    row.triggerCondition !== 'at_or_below'
  )
    invalid('Choose at or above, or at or below.');
  if (row.executionType !== 'market' && row.executionType !== 'limit')
    invalid('Choose Market or Limit execution.');
  if (row.executionType === 'market' && provided(row.limitPrice))
    invalid('Market execution cannot have a limit price.');
  if (provided(row.quantity) === provided(row.amount))
    invalid('Provide amount or quantity, never both.');
  if (
    row.currencyCode !== undefined &&
    row.currencyCode !== 'KRW' &&
    row.currencyCode !== 'USD'
  )
    invalid('Unsupported currency.');
  return {
    assetId: row.assetId.trim(),
    triggerCondition: row.triggerCondition,
    triggerPrice: decimal(row.triggerPrice, 8),
    executionType: row.executionType,
    limitPrice:
      row.executionType === 'limit' ? decimal(row.limitPrice, 8) : null,
    quantity: provided(row.quantity) ? decimal(row.quantity, 6) : null,
    amount: provided(row.amount) ? decimal(row.amount, 8) : null,
    currencyCode: row.currencyCode ?? null,
    idempotencyKey,
  };
}

/** Request identity for create idempotency (normalized decimal text). */
export function conditionalBuyHash(input: ConditionalBuyInput) {
  return conditionalHash({
    operation: 'conditional_buy_create',
    assetId: input.assetId,
    triggerCondition: input.triggerCondition,
    triggerPrice: input.triggerPrice.toFixed(8),
    executionType: input.executionType,
    limitPrice: input.limitPrice?.toFixed(8) ?? null,
    quantity: input.quantity?.toFixed(8) ?? null,
    amount: input.amount?.toFixed(8) ?? null,
    currencyCode: input.currencyCode,
  });
}

/** Watch price vs trigger: at_or_above → price ≥ trigger, at_or_below → price ≤ trigger. */
export function isConditionalBuyMet(
  condition: ConditionalBuyTrigger,
  price: Prisma.Decimal,
  trigger: Prisma.Decimal,
) {
  return condition === 'at_or_above' ? price.gte(trigger) : price.lte(trigger);
}

function provided(value: unknown) {
  return !(value === undefined || value === null || value === '');
}

function decimal(value: unknown, scale: number) {
  const pattern = new RegExp(`^\\d{1,16}(\\.\\d{1,${scale}})?$`, 'u');
  if (
    typeof value !== 'string' ||
    !pattern.test(value) ||
    new Prisma.Decimal(value).lte(0)
  )
    throw createApiError(
      'INVALID_CONDITIONAL_BUY_PRICE',
      'Enter positive decimal strings within the supported precision.',
      400,
    );
  return new Prisma.Decimal(value);
}

function invalid(message: string): never {
  throw createApiError('INVALID_CONDITIONAL_BUY', message, 400);
}
