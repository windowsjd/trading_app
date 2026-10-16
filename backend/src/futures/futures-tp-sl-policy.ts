import { HttpStatus } from '@nestjs/common';
import {
  Prisma,
  type FuturesDirection,
  type ProtectionKind,
} from '../generated/prisma/client';
import {
  conditionalHash,
  conditionalKey,
} from '../conditional/conditional-policy';
import { futuresError } from './futures-error';
import { futuresTpSlEnabled } from './futures.config';

export { futuresTpSlEnabled } from './futures.config';

/** New settings and triggers only; read/cancel/lifecycle cleanup stay open. */
export function assertFuturesTpSlEnabled() {
  if (!futuresTpSlEnabled())
    futuresError(
      'FUTURES_TP_SL_DISABLED',
      'Futures stop-loss and take-profit settings are currently disabled.',
    );
}

/** Bounds the watched set per account and therefore the worker scan. A
 * stop-loss/take-profit pair counts as two. */
export const FUTURES_TP_SL_MAX_LIVE_PER_ACCOUNT = 30;
/** A trigger older than this never becomes an execution (restart safety). */
export const FUTURES_TP_SL_EXECUTION_WINDOW_MS = 30_000;
export const FUTURES_TP_SL_MAX_ATTEMPTS = 3;
export const FUTURES_TP_SL_EXECUTION_FAILED = 'FUTURES_TP_SL_EXECUTION_FAILED';

/** From 30 s after the trigger (inclusive) no execution may be created. */
export function futuresTpSlWindowExpired(triggeredAt: Date, now: Date) {
  return (
    now.getTime() - triggeredAt.getTime() >= FUTURES_TP_SL_EXECUTION_WINDOW_MS
  );
}

/**
 * Transient outcomes that may succeed on the next worker cycle inside the
 * execution window: price evidence races, and a position that changed
 * between sizing and the execution transaction (a manual reduce/increase),
 * which the next attempt re-sizes from the live position. Everything else
 * (liquidation required, mode, account/Season gates, a closed lifetime)
 * ends the setting at once.
 */
const RETRYABLE_EXECUTION_CODES = new Set([
  'FUTURES_PRICE_UNAVAILABLE',
  'FUTURES_PRICE_STALE',
  'INVALID_FUTURES_REDUCE_QUANTITY',
  FUTURES_TP_SL_EXECUTION_FAILED,
]);

export function isRetryableFuturesTpSlFailure(code: string) {
  return RETRYABLE_EXECUTION_CODES.has(code);
}

/** Long take-profit / short stop-loss fire at or above the trigger; the other
 * two at or below — the same sides as the existing Futures protection. */
export function futuresTpSlCondition(
  direction: FuturesDirection,
  kind: ProtectionKind,
): 'at_or_above' | 'at_or_below' {
  return (direction === 'long') === (kind === 'stop_loss')
    ? 'at_or_below'
    : 'at_or_above';
}

export function isFuturesTpSlMet(
  direction: FuturesDirection,
  kind: ProtectionKind,
  price: Prisma.Decimal,
  trigger: Prisma.Decimal,
) {
  return futuresTpSlCondition(direction, kind) === 'at_or_above'
    ? price.gte(trigger)
    : price.lte(trigger);
}

export type FuturesTpSlIntent = {
  kind: ProtectionKind;
  triggerPrice: Prisma.Decimal;
  /** Target quantity (contracts of the underlying), ≤ 8 decimals. */
  quantity: Prisma.Decimal;
};

export type FuturesTpSlInput = {
  positionId: string;
  idempotencyKey: string;
  /** A stop-loss and/or a take-profit (in that order). */
  intents: FuturesTpSlIntent[];
};

const BODY_KEYS = ['positionId', 'stopLoss', 'takeProfit', 'idempotencyKey'];
const LEG_KEYS = ['triggerPrice', 'quantity'];

/** Shape-only parsing; holding and price rules run under the account fence. */
export function parseFuturesTpSlBody(body: unknown): FuturesTpSlInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  const row = body as Record<string, unknown>;
  if (Object.keys(row).some((key) => !BODY_KEYS.includes(key))) invalid();
  const idempotencyKey = conditionalKey(row.idempotencyKey);
  if (
    typeof row.positionId !== 'string' ||
    !row.positionId.trim() ||
    row.positionId.length > 200
  )
    invalid();
  const stopLoss = optionalLeg(row.stopLoss);
  const takeProfit = optionalLeg(row.takeProfit);
  if (!stopLoss && !takeProfit) invalid();
  return {
    positionId: row.positionId.trim(),
    idempotencyKey,
    intents: [
      ...(stopLoss ? [leg('stop_loss', stopLoss)] : []),
      ...(takeProfit ? [leg('take_profit', takeProfit)] : []),
    ],
  };
}

function optionalLeg(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !LEG_KEYS.includes(key))
  )
    invalid();
  return value as Record<string, unknown>;
}

function leg(
  kind: ProtectionKind,
  body: Record<string, unknown>,
): FuturesTpSlIntent {
  return {
    kind,
    triggerPrice: positiveDecimal(body.triggerPrice),
    quantity: positiveDecimal(body.quantity),
  };
}

/** Request identity for create idempotency (normalized decimal text). */
export function futuresTpSlHash(accountId: string, input: FuturesTpSlInput) {
  return conditionalHash({
    operation: 'futures_tp_sl_create',
    accountId,
    positionId: input.positionId,
    intents: input.intents.map((intent) => ({
      kind: intent.kind,
      triggerPrice: intent.triggerPrice.toFixed(8),
      quantity: intent.quantity.toFixed(8),
    })),
  });
}

/**
 * The quantity a triggered setting executes NOW: min(target, the live
 * position), cut down (never up) to 8 decimals. The whole remainder is a
 * `close` (the existing exact-close rule); anything smaller a `reduce`.
 * Null means nothing is left to reduce.
 */
export function resolveFuturesTpSlExecution(input: {
  target: Prisma.Decimal;
  positionQuantity: Prisma.Decimal;
}): { quantity: Prisma.Decimal; operation: 'reduce' | 'close' } | null {
  const quantity = Prisma.Decimal.min(
    input.target,
    input.positionQuantity,
  ).toDecimalPlaces(8, Prisma.Decimal.ROUND_DOWN);
  if (quantity.lte(0)) return null;
  return {
    quantity,
    operation: quantity.eq(input.positionQuantity) ? 'close' : 'reduce',
  };
}

function positiveDecimal(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{1,16}(\.\d{1,8})?$/.test(value) ||
    new Prisma.Decimal(value).lte(0)
  )
    futuresError(
      'INVALID_FUTURES_TP_SL',
      'Enter positive prices and quantities with at most eight fractional digits.',
      HttpStatus.BAD_REQUEST,
    );
  return new Prisma.Decimal(value);
}

function invalid(): never {
  futuresError(
    'INVALID_FUTURES_TP_SL',
    'Provide a position and a stop-loss, a take-profit, or both.',
    HttpStatus.BAD_REQUEST,
  );
}
