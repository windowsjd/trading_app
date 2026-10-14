import { HttpStatus } from '@nestjs/common';
import {
  Prisma,
  type ConditionalBuyTrigger,
  type FuturesDirection,
} from '../generated/prisma/client';
import {
  conditionalHash,
  conditionalKey,
} from '../conditional/conditional-policy';
import { futuresError } from './futures-error';
import { parseFuturesCommand } from './futures-input';
import { futuresConditionalEntryEnabled } from './futures.config';

/** Bounds the watched set per account and therefore the worker scan. */
export const FUTURES_CONDITIONAL_ENTRY_MAX_LIVE_PER_ACCOUNT = 20;
/** A trigger older than this never becomes an order (restart/outage safety). */
export const FUTURES_CONDITIONAL_ENTRY_EXECUTION_WINDOW_MS = 30_000;
export const FUTURES_CONDITIONAL_ENTRY_MAX_ATTEMPTS = 3;
/** Recorded for an execution attempt that failed without an API code. */
export const FUTURES_CONDITIONAL_ENTRY_EXECUTION_FAILED =
  'FUTURES_CONDITIONAL_ENTRY_EXECUTION_FAILED';

/** New watches and triggers only; read/cancel/lifecycle cleanup stay open. */
export function assertFuturesConditionalEntryEnabled() {
  if (!futuresConditionalEntryEnabled())
    futuresError(
      'FUTURES_CONDITIONAL_ENTRY_DISABLED',
      'Futures conditional entries are currently disabled.',
    );
}

/** From 30 s after the trigger (inclusive) no order may be created. */
export function futuresConditionalEntryWindowExpired(
  triggeredAt: Date,
  now: Date,
) {
  return (
    now.getTime() - triggeredAt.getTime() >=
    FUTURES_CONDITIONAL_ENTRY_EXECUTION_WINDOW_MS
  );
}

/**
 * Evidence races that may succeed on the next 1 s cycle inside the window.
 * Every other refusal (collateral, maintenance, position or pending entry,
 * mode, account/Season/beginner gates, verification) fails the entry at once:
 * no forced fill, no endless retry.
 */
const RETRYABLE_EXECUTION_CODES = new Set([
  'FUTURES_PRICE_UNAVAILABLE',
  'FUTURES_PRICE_STALE',
  'FUTURES_MARK_UNAVAILABLE',
  'FUTURES_MARK_STALE',
  FUTURES_CONDITIONAL_ENTRY_EXECUTION_FAILED,
]);

export function isRetryableFuturesConditionalEntryFailure(code: string) {
  return RETRYABLE_EXECUTION_CODES.has(code);
}

/** Deterministic key of the one Futures command/limit entry an entry creates. */
export function futuresConditionalEntryCommandKey(entryId: string) {
  return `futures-conditional:${entryId}`;
}

/** Last vs trigger: at_or_above → Last ≥ trigger, at_or_below → Last ≤ trigger. */
export function isFuturesConditionalEntryMet(
  condition: ConditionalBuyTrigger,
  price: Prisma.Decimal,
  trigger: Prisma.Decimal,
) {
  return condition === 'at_or_above' ? price.gte(trigger) : price.lte(trigger);
}

export type FuturesConditionalEntryInput = {
  instrumentId: string;
  direction: FuturesDirection;
  marginMode: 'isolated' | 'cross';
  leverage: number;
  /** Normalized to 8 places by the Futures command parser. */
  quantity: string;
  triggerCondition: ConditionalBuyTrigger;
  triggerPrice: Prisma.Decimal;
  executionType: 'market' | 'limit';
  limitPrice: Prisma.Decimal | null;
  idempotencyKey: string;
};

const FIELDS = [
  'instrumentId',
  'direction',
  'marginMode',
  'leverage',
  'quantity',
  'triggerCondition',
  'triggerPrice',
  'executionType',
  'limitPrice',
  'idempotencyKey',
];

/**
 * Shape parsing. Direction, margin mode, leverage and quantity reuse the
 * Futures command rules of an `open`; trigger and limit prices are positive
 * decimals with at most 8 places.
 */
export function parseFuturesConditionalEntryBody(
  body: unknown,
): FuturesConditionalEntryInput {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !FIELDS.includes(key))
  )
    futuresError(
      'INVALID_FUTURES_CONDITIONAL_ENTRY',
      'Invalid Futures conditional entry.',
      HttpStatus.BAD_REQUEST,
    );
  const row = body as Record<string, unknown>;
  const idempotencyKey = conditionalKey(row.idempotencyKey);
  if (
    row.triggerCondition !== 'at_or_above' &&
    row.triggerCondition !== 'at_or_below'
  )
    futuresError(
      'INVALID_FUTURES_CONDITIONAL_ENTRY',
      'Choose at or above, or at or below.',
      HttpStatus.BAD_REQUEST,
    );
  if (row.executionType !== 'market' && row.executionType !== 'limit')
    futuresError(
      'INVALID_FUTURES_CONDITIONAL_ENTRY',
      'Choose Market or Limit execution.',
      HttpStatus.BAD_REQUEST,
    );
  if (row.executionType === 'market' && provided(row.limitPrice))
    futuresError(
      'INVALID_FUTURES_CONDITIONAL_ENTRY',
      'Market execution cannot have a limit price.',
      HttpStatus.BAD_REQUEST,
    );
  const command = parseFuturesCommand({
    instrumentId: row.instrumentId,
    operation: 'open',
    direction: row.direction,
    marginMode: row.marginMode,
    leverage: row.leverage,
    quantity: row.quantity,
    idempotencyKey,
  });
  return {
    instrumentId: command.instrumentId,
    direction: command.direction,
    marginMode: command.marginMode ?? 'isolated',
    leverage: command.leverage,
    quantity: command.quantity,
    triggerCondition: row.triggerCondition,
    triggerPrice: decimal(row.triggerPrice),
    executionType: row.executionType,
    limitPrice: row.executionType === 'limit' ? decimal(row.limitPrice) : null,
    idempotencyKey,
  };
}

/** Request identity for create idempotency (normalized decimal text). */
export function futuresConditionalEntryHash(
  accountId: string,
  input: FuturesConditionalEntryInput,
) {
  return conditionalHash({
    operation: 'futures_conditional_entry_create',
    accountId,
    instrumentId: input.instrumentId,
    direction: input.direction,
    marginMode: input.marginMode,
    leverage: input.leverage,
    quantity: input.quantity,
    triggerCondition: input.triggerCondition,
    triggerPrice: input.triggerPrice.toFixed(8),
    executionType: input.executionType,
    limitPrice: input.limitPrice?.toFixed(8) ?? null,
  });
}

function provided(value: unknown) {
  return !(value === undefined || value === null || value === '');
}

function decimal(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{1,16}(\.\d{1,8})?$/u.test(value) ||
    new Prisma.Decimal(value).lte(0)
  )
    futuresError(
      'INVALID_FUTURES_CONDITIONAL_ENTRY_PRICE',
      'Enter positive prices with at most eight fractional digits.',
      HttpStatus.BAD_REQUEST,
    );
  return new Prisma.Decimal(value);
}
