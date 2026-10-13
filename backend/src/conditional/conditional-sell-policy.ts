import { createApiError } from '../common/api-error';
import {
  AssetType,
  OrderType,
  Prisma,
  type ConditionalSellKind,
  type ConditionalSellTrigger,
  type CurrencyCode,
} from '../generated/prisma/client';
import { orderInputQuantityScale } from '../orders/order-input-policy';
import { conditionalHash, conditionalKey } from './conditional-policy';
import {
  conditionalSellEnabled,
  independentTpSlEnabled,
} from './conditional-sell.config';

export {
  conditionalSellEnabled,
  independentTpSlEnabled,
} from './conditional-sell.config';

/** A user condition, or an independent stop-loss/take-profit. */
export type ConditionalSellFamily = 'condition' | 'protection';

export function conditionalSellFamily(
  kind: ConditionalSellKind,
): ConditionalSellFamily {
  return kind === 'condition' ? 'condition' : 'protection';
}

/** New intents and triggers only; read/cancel/lifecycle cleanup stay open. */
export function conditionalSellKindEnabled(kind: ConditionalSellKind) {
  return kind === 'condition'
    ? conditionalSellEnabled()
    : independentTpSlEnabled();
}

export function assertConditionalSellKindEnabled(kind: ConditionalSellKind) {
  if (conditionalSellKindEnabled(kind)) return;
  throw kind === 'condition'
    ? createApiError(
        'CONDITIONAL_SELL_DISABLED',
        'Conditional sell orders are currently disabled.',
        409,
      )
    : createApiError(
        'INDEPENDENT_TP_SL_DISABLED',
        'Stop-loss and take-profit orders are currently disabled.',
        409,
      );
}

/** Bounds the watched set per account and therefore the worker scan. A
 * stop-loss/take-profit pair counts as two. */
export const CONDITIONAL_SELL_MAX_LIVE_PER_ACCOUNT = 30;
/** A trigger older than this never becomes an order (restart/outage safety). */
export const CONDITIONAL_SELL_EXECUTION_WINDOW_MS = 30_000;
export const CONDITIONAL_SELL_MAX_ATTEMPTS = 3;

/** From 30 s after the trigger (inclusive) no new order may be created. */
export function conditionalSellWindowExpired(triggeredAt: Date, now: Date) {
  return (
    now.getTime() - triggeredAt.getTime() >=
    CONDITIONAL_SELL_EXECUTION_WINDOW_MS
  );
}

/**
 * Transient execution outcomes that may succeed on the next worker cycle
 * inside the execution window. `INSUFFICIENT_QUANTITY` is a lost race for
 * the unreserved holding: the next attempt sizes the order again from the
 * live position. Every other code (closed market, account/Season gates,
 * protection conflicts, nothing left to sell) ends the intent at once.
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
  'INSUFFICIENT_QUANTITY',
  'CONDITIONAL_SELL_EXECUTION_FAILED',
]);

export function isRetryableConditionalSellFailure(code: string) {
  return RETRYABLE_EXECUTION_CODES.has(code);
}

export type ConditionalSellIntentInput = {
  kind: ConditionalSellKind;
  triggerCondition: ConditionalSellTrigger;
  triggerPrice: Prisma.Decimal;
  executionType: 'market' | 'limit';
  limitPrice: Prisma.Decimal | null;
  /** Target quantity (shares or base units). */
  quantity: Prisma.Decimal;
};

export type ConditionalSellInput = {
  assetId: string;
  currencyCode: CurrencyCode | null;
  idempotencyKey: string;
  /** One condition, or a stop-loss and/or a take-profit (in that order). */
  intents: ConditionalSellIntentInput[];
};

type LegBody = {
  triggerPrice?: unknown;
  executionType?: unknown;
  limitPrice?: unknown;
  quantity?: unknown;
};

export type ConditionalSellBody = LegBody & {
  assetId?: unknown;
  /** `condition` or `protection` (stop-loss and/or take-profit). */
  kind?: unknown;
  triggerCondition?: unknown;
  stopLoss?: unknown;
  takeProfit?: unknown;
  currencyCode?: unknown;
  idempotencyKey?: unknown;
};

/**
 * Shape-only parsing. Asset-specific input rules (integer stock quantity for
 * a limit execution) are applied against the asset afterwards by the
 * existing order input policy.
 */
export function parseConditionalSellBody(
  body: ConditionalSellBody | undefined,
): ConditionalSellInput {
  const row: ConditionalSellBody = body && typeof body === 'object' ? body : {};
  const idempotencyKey = conditionalKey(row.idempotencyKey);
  if (typeof row.assetId !== 'string' || !row.assetId.trim())
    invalid('Specify an asset.');
  if (
    row.currencyCode !== undefined &&
    row.currencyCode !== 'KRW' &&
    row.currencyCode !== 'USD'
  )
    invalid('Unsupported currency.');
  let intents: ConditionalSellIntentInput[];
  if (row.kind === 'condition') {
    if (
      row.triggerCondition !== 'at_or_above' &&
      row.triggerCondition !== 'at_or_below'
    )
      invalid('Choose at or above, or at or below.');
    if (row.stopLoss !== undefined || row.takeProfit !== undefined)
      invalid('Choose a condition or a stop-loss/take-profit setting.');
    intents = [leg('condition', row.triggerCondition, row)];
  } else if (row.kind === 'protection') {
    if (
      row.triggerCondition !== undefined ||
      row.triggerPrice !== undefined ||
      row.executionType !== undefined ||
      row.limitPrice !== undefined ||
      row.quantity !== undefined
    )
      invalid('Choose a condition or a stop-loss/take-profit setting.');
    const stopLoss = optionalLeg(row.stopLoss);
    const takeProfit = optionalLeg(row.takeProfit);
    if (!stopLoss && !takeProfit)
      invalid('Provide a stop-loss, a take-profit, or both.');
    intents = [
      ...(stopLoss ? [leg('stop_loss', 'at_or_below', stopLoss)] : []),
      ...(takeProfit ? [leg('take_profit', 'at_or_above', takeProfit)] : []),
    ];
  } else invalid('Choose a condition or a stop-loss/take-profit setting.');
  return {
    assetId: row.assetId.trim(),
    currencyCode: row.currencyCode ?? null,
    idempotencyKey,
    intents,
  };
}

function optionalLeg(value: unknown): LegBody | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    invalid('Provide a stop-loss, a take-profit, or both.');
  return value as LegBody;
}

function leg(
  kind: ConditionalSellKind,
  triggerCondition: ConditionalSellTrigger,
  body: LegBody,
): ConditionalSellIntentInput {
  if (body.executionType !== 'market' && body.executionType !== 'limit')
    invalid('Choose Market or Limit execution.');
  if (body.executionType === 'market' && provided(body.limitPrice))
    invalid('Market execution cannot have a limit price.');
  return {
    kind,
    triggerCondition,
    triggerPrice: decimal(body.triggerPrice, 8),
    executionType: body.executionType,
    limitPrice:
      body.executionType === 'limit' ? decimal(body.limitPrice, 8) : null,
    quantity: decimal(body.quantity, orderInputQuantityScale),
  };
}

/** Request identity for create idempotency (normalized decimal text). */
export function conditionalSellHash(input: ConditionalSellInput) {
  return conditionalHash({
    operation: 'conditional_sell_create',
    assetId: input.assetId,
    currencyCode: input.currencyCode,
    intents: input.intents.map((intent) => ({
      kind: intent.kind,
      triggerCondition: intent.triggerCondition,
      triggerPrice: intent.triggerPrice.toFixed(8),
      executionType: intent.executionType,
      limitPrice: intent.limitPrice?.toFixed(8) ?? null,
      quantity: intent.quantity.toFixed(8),
    })),
  });
}

/** at_or_above → price ≥ trigger, at_or_below → price ≤ trigger. */
export function isConditionalSellMet(
  condition: ConditionalSellTrigger,
  price: Prisma.Decimal,
  trigger: Prisma.Decimal,
) {
  return condition === 'at_or_above' ? price.gte(trigger) : price.lte(trigger);
}

/**
 * The one quantity rule every new SELL uses when it becomes a real order:
 * min(target, holding − every other order's reservation), never negative,
 * cut down (never up) to the order unit — whole shares for a stock limit
 * order, 6 decimals otherwise. Reservations already on the position are
 * subtracted once; unreserved intents of the same holding are not, so their
 * targets may add up to more than the holding. Null means nothing can be
 * sold now. The atomic position guards still decide at the DB.
 */
export function resolveSellExecutionQuantity(input: {
  target: Prisma.Decimal;
  holding: Prisma.Decimal | null | undefined;
  reserved: Prisma.Decimal | null | undefined;
  assetType: AssetType;
  orderType: OrderType;
}): { quantity: Prisma.Decimal | null; available: Prisma.Decimal } {
  const zero = new Prisma.Decimal(0);
  const holding = input.holding ?? zero;
  const reserved = input.reserved ?? zero;
  const available = Prisma.Decimal.max(holding.sub(reserved), zero);
  const wholeShares =
    input.orderType === OrderType.limit &&
    (input.assetType === AssetType.domestic_stock ||
      input.assetType === AssetType.us_stock);
  const quantity = Prisma.Decimal.min(input.target, available).toDecimalPlaces(
    wholeShares ? 0 : orderInputQuantityScale,
    Prisma.Decimal.ROUND_DOWN,
  );
  return { quantity: quantity.gt(0) ? quantity : null, available };
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
      'INVALID_CONDITIONAL_SELL_PRICE',
      'Enter positive decimal strings within the supported precision.',
      400,
    );
  return new Prisma.Decimal(value);
}

function invalid(message: string): never {
  throw createApiError('INVALID_CONDITIONAL_SELL', message, 400);
}
