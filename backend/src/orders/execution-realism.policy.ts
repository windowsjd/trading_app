import { Prisma } from '../generated/prisma/client';
import {
  formatDecimalScale,
  monetaryScale,
  parseDecimalString,
} from '../fx/fx-decimal-policy';
import type {
  ExecutionAssessment,
  ExecutionAssessmentReason,
  ExecutionLiquidityLevel,
  ExecutionMarketEvidence,
  ExecutionRealismOrder,
  ExecutionTopQuote,
} from './execution-realism.types';

// Two Decimal(24,8) factors require up to 48 significant digits. Local
// precision follows order-input-policy and never changes global arithmetic.
const D = Prisma.Decimal.clone({
  precision: 50,
  rounding: Prisma.Decimal.ROUND_HALF_UP,
});
type ParsedLevel = { price: Prisma.Decimal; quantity: Prisma.Decimal };
type ParsedQuote = { price: Prisma.Decimal; quantity: Prisma.Decimal | null };

class InvalidExecutionInput extends Error {
  constructor(readonly field: string) {
    super(`Invalid execution input: ${field}`);
  }
}

/**
 * B1 pure assessment: no I/O, clock reads, providers, order mutations or
 * product fill/reject policy. See docs/execution-realism-system.md.
 */
export function assessExecutionRealism(input: {
  order: ExecutionRealismOrder;
  evidence: ExecutionMarketEvidence | null;
}): ExecutionAssessment {
  const { order, evidence } = input;
  const result: ExecutionAssessment = {
    order: { ...order },
    evidenceKind: evidence?.kind ?? 'missing',
    evidenceTimestamps: null,
    state: 'unassessable',
    reason: null,
    invalidField: null,
    referencePrice: null,
    referencePriceBasis: null,
    observedFillableQuantity: null,
    simulatedFillPrice: null,
    adversePriceImpactBps: null,
    levelsConsumed: 0,
  };

  try {
    for (const field of ['assetId', 'priceCurrency', 'quantityUnit'] as const) {
      requireLabel(order[field], `order.${field}`);
    }
    if (order.side !== 'buy' && order.side !== 'sell') {
      throw new InvalidExecutionInput('order.side');
    }
    const requested = financialDecimal(order.quantity, 'order.quantity');
    const limit =
      order.limitPrice === undefined
        ? null
        : financialDecimal(order.limitPrice, 'order.limitPrice');
    if (!evidence) return { ...result, reason: 'evidence_missing' };

    validateContext(order, evidence);
    result.evidenceTimestamps = {
      effectiveAt: evidence.effectiveAt?.toISOString() ?? null,
      capturedAt: evidence.capturedAt.toISOString(),
      checkedAt: evidence.validation.checkedAt.toISOString(),
    };

    let levels: ParsedLevel[];
    let exhaustion: ExecutionAssessmentReason;
    const basis = order.side === 'buy' ? 'ask' : 'bid';
    // Validate the whole snapshot before using any portion. Corrupt unused
    // sides/levels must not disappear behind a small requested quantity.
    if (evidence.kind === 'l2') {
      const asks = parseLevels(evidence.asks, 'evidence.asks', true);
      const bids = parseLevels(evidence.bids, 'evidence.bids', false);
      rejectCrossedBook(bids[0], asks[0]);
      levels = order.side === 'buy' ? asks : bids;
      exhaustion = 'observed_depth_exhausted';
    } else if (evidence.kind === 'top_of_book') {
      const ask = parseQuote(evidence.ask, 'evidence.ask');
      const bid = parseQuote(evidence.bid, 'evidence.bid');
      rejectCrossedBook(bid, ask);
      const blocked = validationReason(evidence);
      if (blocked) return { ...result, reason: blocked };
      const quote = order.side === 'buy' ? ask : bid;
      if (!quote) return { ...result, reason: 'side_missing' };
      result.referencePrice = format(quote.price);
      result.referencePriceBasis = basis;
      if (!withinLimit(quote.price, limit, order.side)) {
        return observedResult(result, requested, [], 'limit_price_boundary');
      }
      if (quote.quantity === null) {
        return { ...result, reason: 'size_missing' };
      }
      levels = [{ price: quote.price, quantity: quote.quantity }];
      exhaustion = 'observed_size_exceeded';
    } else if (evidence.kind === 'price_only') {
      const reference =
        evidence.referencePrice === null
          ? null
          : financialDecimal(
              evidence.referencePrice,
              'evidence.referencePrice',
            );
      if (evidence.volume !== undefined) {
        if (evidence.volume === null) {
          throw new InvalidExecutionInput('evidence.volume');
        }
        financialDecimal(
          evidence.volume.quantity,
          'evidence.volume.quantity',
          true,
        );
        requireDate(evidence.volume.from, 'evidence.volume.from');
        requireDate(evidence.volume.to, 'evidence.volume.to');
        if (
          evidence.volume.from >= evidence.volume.to ||
          evidence.volume.to > evidence.capturedAt
        ) {
          throw new InvalidExecutionInput('evidence.volume.interval');
        }
      }
      const blocked = validationReason(evidence);
      if (blocked) return { ...result, reason: blocked };
      return {
        ...result,
        referencePrice: reference === null ? null : format(reference),
        referencePriceBasis: reference === null ? null : 'reference',
        reason:
          reference === null && evidence.volume === undefined
            ? 'evidence_missing'
            : 'liquidity_model_required',
      };
    } else {
      throw new InvalidExecutionInput('evidence.kind');
    }

    const blocked = validationReason(evidence);
    if (blocked) return { ...result, reason: blocked };
    if (levels.length === 0) {
      return observedResult(result, requested, [], 'no_observed_liquidity');
    }
    result.referencePrice = format(levels[0].price);
    result.referencePriceBasis = basis;
    const eligibleLevels = levels.filter((level) =>
      withinLimit(level.price, limit, order.side),
    );
    return observedResult(
      result,
      requested,
      eligibleLevels,
      eligibleLevels.length < levels.length
        ? 'limit_price_boundary'
        : exhaustion,
    );
  } catch (error) {
    if (!(error instanceof InvalidExecutionInput)) throw error;
    return {
      ...result,
      state: 'unassessable',
      reason: error.field.startsWith('order.')
        ? 'invalid_order'
        : 'invalid_evidence',
      invalidField: error.field,
    };
  }
}

function observedResult(
  result: ExecutionAssessment,
  requested: Prisma.Decimal,
  levels: readonly ParsedLevel[],
  shortageReason: ExecutionAssessmentReason,
): ExecutionAssessment {
  let filled = new D('0');
  let notional = new D('0');
  let consumed = 0;
  for (const level of levels) {
    const quantity = level.quantity.lt(requested.sub(filled))
      ? level.quantity
      : requested.sub(filled);
    filled = filled.add(quantity);
    notional = notional.add(level.price.mul(quantity));
    consumed += 1;
    if (filled.eq(requested)) break;
  }
  const weighted = filled.gt(0) ? notional.div(filled) : null;
  const reference =
    result.referencePrice === null ? null : new D(result.referencePrice);
  const adverse =
    weighted && reference
      ? (result.order.side === 'buy'
          ? weighted.sub(reference)
          : reference.sub(weighted)
        )
          .div(reference)
          .mul('10000')
      : null;
  return {
    ...result,
    state: filled.eq(requested)
      ? 'full_observed_fill'
      : filled.gt(0)
        ? 'partial_observed_fill'
        : 'no_observed_fill',
    reason: filled.eq(requested) ? null : shortageReason,
    observedFillableQuantity: format(filled),
    simulatedFillPrice: weighted === null ? null : format(weighted),
    adversePriceImpactBps: adverse === null ? null : format(adverse),
    levelsConsumed: consumed,
  };
}

function validateContext(
  order: ExecutionRealismOrder,
  evidence: ExecutionMarketEvidence,
) {
  for (const field of ['assetId', 'priceCurrency', 'quantityUnit'] as const) {
    requireLabel(evidence[field], `evidence.${field}`);
    if (order[field] !== evidence[field])
      throw new InvalidExecutionInput(`evidence.${field}`);
  }
  requireDate(evidence.capturedAt, 'evidence.capturedAt');
  requireDate(evidence.validation?.checkedAt, 'evidence.validation.checkedAt');
  if (evidence.effectiveAt !== null) {
    requireDate(evidence.effectiveAt, 'evidence.effectiveAt');
    if (evidence.effectiveAt > evidence.capturedAt) {
      throw new InvalidExecutionInput('evidence.effectiveAt');
    }
  }
  if (evidence.capturedAt > evidence.validation.checkedAt) {
    throw new InvalidExecutionInput('evidence.capturedAt');
  }
  if (
    !['usable', 'stale', 'ineligible', 'unchecked'].includes(
      evidence.validation.state,
    )
  ) {
    throw new InvalidExecutionInput('evidence.validation.state');
  }
}

function validationReason(
  evidence: ExecutionMarketEvidence,
): ExecutionAssessmentReason | null {
  const state = evidence.validation.state;
  return state === 'usable' ? null : `evidence_${state}`;
}

function parseLevels(
  levels: readonly ExecutionLiquidityLevel[],
  field: string,
  ascending: boolean,
): ParsedLevel[] {
  if (!Array.isArray(levels)) throw new InvalidExecutionInput(field);
  const seen = new Set<string>();
  return levels
    .map((level: ExecutionLiquidityLevel, index) => {
      const price = financialDecimal(level?.price, `${field}[${index}].price`);
      const quantity = financialDecimal(
        level?.quantity,
        `${field}[${index}].quantity`,
      );
      if (seen.has(price.toFixed()))
        throw new InvalidExecutionInput(`${field}[${index}].price`);
      seen.add(price.toFixed());
      return { price, quantity };
    })
    .sort((a, b) => (ascending ? a.price.cmp(b.price) : b.price.cmp(a.price)));
}

function parseQuote(
  quote: ExecutionTopQuote | null,
  field: string,
): ParsedQuote | null {
  if (quote === null) return null;
  const price = financialDecimal(quote?.price, `${field}.price`);
  return {
    price,
    quantity:
      quote.quantity === undefined
        ? null
        : financialDecimal(quote.quantity, `${field}.quantity`),
  };
}

function rejectCrossedBook(
  bid: { price: Prisma.Decimal } | null | undefined,
  ask: { price: Prisma.Decimal } | null | undefined,
) {
  if (bid && ask && bid.price.gt(ask.price))
    throw new InvalidExecutionInput('evidence.crossedBook');
}

function withinLimit(
  price: Prisma.Decimal,
  limit: Prisma.Decimal | null,
  side: ExecutionRealismOrder['side'],
): boolean {
  return (
    limit === null || (side === 'buy' ? price.lte(limit) : price.gte(limit))
  );
}

function financialDecimal(
  value: unknown,
  field: string,
  allowZero = false,
): Prisma.Decimal {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new InvalidExecutionInput(field);
  }
  const decimal = parseDecimalString(value);
  if (
    (allowZero ? decimal.lt(0) : decimal.lte(0)) ||
    decimal.decimalPlaces() > monetaryScale ||
    decimal.gte('10000000000000000')
  )
    throw new InvalidExecutionInput(field);
  return new D(decimal.toFixed());
}

function requireLabel(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new InvalidExecutionInput(field);
}

function requireDate(value: unknown, field: string): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new InvalidExecutionInput(field);
}

function format(value: Prisma.Decimal): string {
  return formatDecimalScale(value.toFixed(), monetaryScale);
}
