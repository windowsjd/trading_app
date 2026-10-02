import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { assessExecutionRealism } from './execution-realism.policy';
import { orderInputQuantityScale } from './order-input-policy';
import type { ExecutionRealismOrder } from './execution-realism.types';
import {
  MARKET_REMAINDER_CANCEL_REASON,
  type MarketExecutionContext,
  type MarketExecutionEvidenceAdapter,
} from './market-execution-evidence.adapter';

const D = Prisma.Decimal.clone({ precision: 50 });

/** Called only after quote/account/session locks, before any financial write. */
export function decideMarketExecution(
  adapter: MarketExecutionEvidenceAdapter,
  context: MarketExecutionContext,
  intent: { quantity: Prisma.Decimal; amount: Prisma.Decimal | null },
) {
  const candidate = adapter.read(context);
  if (!candidate || !/^[a-z][a-z0-9_]{0,63}$/u.test(candidate.source)) {
    return unavailable();
  }
  const gates = adapter.validate(candidate, context);
  // Ignore any injected B1 validation property; only this adapter boundary
  // can issue a usable verdict for the locked execution instant.
  const state =
    gates.sourceEligible !== true || gates.sessionEligible !== true
      ? 'ineligible'
      : gates.fresh !== true
        ? 'stale'
        : 'usable';
  const identity = {
    assetId: context.assetId,
    priceCurrency: context.priceCurrency,
    quantityUnit: context.quantityUnit,
  };
  const order: ExecutionRealismOrder = intent.amount
    ? { ...identity, side: 'buy', amount: intent.amount.toFixed() }
    : { ...identity, side: context.side, quantity: intent.quantity.toFixed() };
  if (intent.amount && context.side !== 'buy') return unavailable();
  const assessment = assessExecutionRealism({
    order,
    evidence: {
      ...candidate.evidence,
      validation: { state, checkedAt: context.executedAt },
    },
    quantityScale: orderInputQuantityScale,
  });
  if (assessment.state === 'unassessable') return unavailable();
  const quantity = new Prisma.Decimal(assessment.observedFillableQuantity!);
  const grossAmount = new Prisma.Decimal(assessment.observedGrossAmount!);
  if (
    assessment.state === 'no_observed_fill' ||
    quantity.lte(0) ||
    grossAmount.lte(0)
  ) {
    throw new HttpException(
      {
        success: false,
        error: {
          code: 'ORDER_LIQUIDITY_UNAVAILABLE',
          message:
            'No executable market liquidity is available; try a new quote.',
        },
      },
      HttpStatus.CONFLICT,
    );
  }
  if (
    quantity.gte('10000000000000000') ||
    grossAmount.gte('10000000000000000')
  ) {
    return unavailable();
  }
  const unspentAmount = intent.amount
    ? new D(intent.amount.toFixed()).sub(grossAmount)
    : null;
  const partial =
    assessment.state === 'partial_observed_fill' &&
    (unspentAmount === null || unspentAmount.gt(0));
  return {
    quantity,
    price: new Prisma.Decimal(assessment.simulatedFillPrice!),
    grossAmount,
    canceledQuantity: intent.amount
      ? null
      : new D(intent.quantity.toFixed()).sub(quantity),
    requestedAmount: intent.amount,
    unspentAmount,
    cancelReason: partial ? MARKET_REMAINDER_CANCEL_REASON : null,
    evidence: {
      kind: assessment.evidenceKind,
      source: candidate.source,
      ...assessment.evidenceTimestamps!,
      state: assessment.state,
      reason: assessment.reason,
      referencePrice: assessment.referencePrice,
      adversePriceImpactBps: assessment.adversePriceImpactBps,
      levelsConsumed: assessment.levelsConsumed,
    },
  };
}

function unavailable(): never {
  throw new HttpException(
    {
      success: false,
      error: {
        code: 'EXECUTION_EVIDENCE_UNAVAILABLE',
        message: 'Trusted execution evidence is unavailable; try again later.',
      },
    },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}
