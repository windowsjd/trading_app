import { createApiError } from '../common/api-error';
import {
  Prisma,
  type FuturesDirection,
  type ProtectionKind,
} from '../generated/prisma/client';
import {
  conditionalHash,
  conditionalKey,
  isTriggered,
} from './conditional-policy';

/**
 * Stop-loss / take-profit plans on a PENDING entry (2026-10-16): the entry a
 * plan belongs to is one of these, addressed by the id the client holds. A
 * Spot limit order created by a conditional BUY, and a Futures limit entry
 * created by a Futures conditional entry, resolve to that conditional row,
 * so the conditional entry and the order it created never hold two plan sets.
 */
export const ENTRY_TYPES = [
  'spot_limit_order',
  'spot_conditional_buy',
  'futures_limit_order',
  'futures_conditional_entry',
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** Bounds the pending plans of one account (and the activation work of one
 * fill). A stop-loss/take-profit pair counts as two. */
export const ENTRY_TP_SL_MAX_PENDING_PER_ACCOUNT = 30;
/** Pending plans of one entry (both kinds). */
export const ENTRY_TP_SL_MAX_PER_ENTRY = 10;

export type EntryTpSlIntent = {
  kind: ProtectionKind;
  triggerPrice: Prisma.Decimal;
  /** Whole percent (1–100) of the quantity the entry actually fills. */
  ratioPercent: number;
};

export type EntryTpSlInput = {
  entryType: EntryType;
  entryId: string;
  idempotencyKey: string;
  /** A stop-loss and/or a take-profit (in that order). */
  intents: EntryTpSlIntent[];
};

const BODY_KEYS = [
  'entryType',
  'entryId',
  'stopLoss',
  'takeProfit',
  'idempotencyKey',
];
const LEG_KEYS = ['triggerPrice', 'ratio'];
const DRAFT_KEYS = ['kind', 'triggerPrice', 'ratio'];

/** Shape-only parsing of a plan registration; entry rules run under the
 * account fence. */
export function parseEntryTpSlBody(body: unknown): EntryTpSlInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  const row = body as Record<string, unknown>;
  if (Object.keys(row).some((key) => !BODY_KEYS.includes(key))) invalid();
  const idempotencyKey = conditionalKey(row.idempotencyKey);
  const entryType = parseEntryType(row.entryType);
  const entryId = parseEntryId(row.entryId);
  const stopLoss = optionalLeg(row.stopLoss);
  const takeProfit = optionalLeg(row.takeProfit);
  if (!stopLoss && !takeProfit) invalid();
  return {
    entryType,
    entryId,
    idempotencyKey,
    intents: [
      ...(stopLoss ? [leg('stop_loss', stopLoss)] : []),
      ...(takeProfit ? [leg('take_profit', takeProfit)] : []),
    ],
  };
}

export function parseEntryType(value: unknown): EntryType {
  if (!ENTRY_TYPES.includes(value as EntryType)) invalid();
  return value as EntryType;
}

export function parseEntryId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    invalid();
  return value.trim();
}

/**
 * Additive `entryTpSl` field of a Spot BUY Limit create and a Futures limit
 * entry create: the plans registered atomically with the new entry. Absent
 * keeps every existing request shape (and its idempotency hash).
 */
export function parseEntryTpSlDrafts(value: unknown): EntryTpSlIntent[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > ENTRY_TP_SL_MAX_PER_ENTRY
  )
    invalid();
  return value.map((raw: unknown) => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => !DRAFT_KEYS.includes(key))
    )
      invalid();
    const row = raw as Record<string, unknown>;
    if (row.kind !== 'stop_loss' && row.kind !== 'take_profit') invalid();
    return leg(row.kind, row);
  });
}

/** Canonical text of drafts for a create request hash. */
export function entryTpSlDraftsCanonical(intents: EntryTpSlIntent[]) {
  return intents.map((intent) => ({
    kind: intent.kind,
    triggerPrice: intent.triggerPrice.toFixed(8),
    ratioPercent: intent.ratioPercent,
  }));
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
): EntryTpSlIntent {
  const ratio = body.ratio;
  if (
    typeof ratio !== 'number' ||
    !Number.isInteger(ratio) ||
    ratio < 1 ||
    ratio > 100
  )
    throw createApiError(
      'INVALID_ENTRY_TP_SL',
      'Choose a whole percent from 1 to 100.',
      400,
    );
  return {
    kind,
    triggerPrice: positivePrice(body.triggerPrice),
    ratioPercent: ratio,
  };
}

/** Request identity for create idempotency (normalized decimal text). */
export function entryTpSlHash(accountId: string, input: EntryTpSlInput) {
  return conditionalHash({
    operation: 'entry_tp_sl_create',
    accountId,
    entryType: input.entryType,
    entryId: input.entryId,
    intents: entryTpSlDraftsCanonical(input.intents),
  });
}

/**
 * Per entry and per kind: the pending plans plus the new ones use distinct
 * trigger prices and add up to at most 100% (stop-losses and take-profits
 * are summed separately, as for the holding settings).
 */
export function findEntryPlanConflict(input: {
  intents: Array<
    Pick<EntryTpSlIntent, 'kind' | 'triggerPrice' | 'ratioPercent'>
  >;
  pending: Array<{
    kind: ProtectionKind;
    triggerPrice: Prisma.Decimal;
    ratioPercent: number;
  }>;
}): 'duplicate_price' | 'total_exceeds_entry' | null {
  for (const kind of new Set(input.intents.map((intent) => intent.kind))) {
    const fresh = input.intents.filter((intent) => intent.kind === kind);
    const all = [...input.pending.filter((row) => row.kind === kind), ...fresh];
    if (
      all.some((row, index) =>
        all.some(
          (other, otherIndex) =>
            otherIndex < index && other.triggerPrice.eq(row.triggerPrice),
        ),
      )
    )
      return 'duplicate_price';
    if (all.reduce((sum, row) => sum + row.ratioPercent, 0) > 100)
      return 'total_exceeds_entry';
  }
  return null;
}

/**
 * A pending entry has no fill yet, so plan prices are checked against the
 * entry's own price (its limit, or the conditional trigger when the entry
 * executes at market): long stop-loss below and take-profit above, short
 * reversed, strictly. Equal is refused like an already-met trigger.
 */
export function assertEntryTriggerSides(
  intents: Array<Pick<EntryTpSlIntent, 'kind' | 'triggerPrice'>>,
  direction: FuturesDirection,
  entryPrice: Prisma.Decimal,
) {
  if (
    intents.some((intent) =>
      isTriggered(direction, intent.kind, entryPrice, intent.triggerPrice),
    )
  )
    throw createApiError(
      'ENTRY_TP_SL_INVALID_TRIGGER',
      'Stop-loss and take-profit prices must be on the protective side of the entry price.',
      409,
    );
}

/** ratioPercent of the executed quantity, cut down (never up) to the unit. */
export function entryPlanTargetQuantity(
  executed: Prisma.Decimal,
  ratioPercent: number,
  scale: number,
) {
  return executed
    .mul(ratioPercent)
    .div(100)
    .toDecimalPlaces(scale, Prisma.Decimal.ROUND_DOWN);
}

function positivePrice(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{1,16}(\.\d{1,8})?$/.test(value) ||
    new Prisma.Decimal(value).lte(0)
  )
    throw createApiError(
      'INVALID_ENTRY_TP_SL',
      'Price must be a positive decimal string with at most eight decimal places.',
      400,
    );
  return new Prisma.Decimal(value);
}

function invalid(): never {
  throw createApiError(
    'INVALID_ENTRY_TP_SL',
    'Provide an entry and a stop-loss, a take-profit, or both.',
    400,
  );
}
