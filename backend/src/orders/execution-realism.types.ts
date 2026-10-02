import type { OrderSide } from '../generated/prisma/client';

/** Hypothetical quantity or maximum BUY principal; never a persisted Order. */
export type ExecutionRealismOrder = {
  assetId: string;
  side: OrderSide;
  /** Price currency per quantityUnit; no implicit currency/unit conversion. */
  priceCurrency: string;
  quantityUnit: string;
  /** Optional buy ceiling / sell floor for this assessment only. */
  limitPrice?: string;
} & (
  | { quantity: string; amount?: never }
  | { side: 'buy'; amount: string; quantity?: never }
);

export type ExecutionLiquidityLevel = {
  price: string;
  quantity: string;
};

export type ExecutionTopQuote = {
  price: string;
  /** Absent means unknown size, never unlimited liquidity. */
  quantity?: string;
};

type ExecutionEvidenceContext = {
  assetId: string;
  priceCurrency: string;
  quantityUnit: string;
  effectiveAt: Date | null;
  capturedAt: Date;
  /**
   * Verdict for THIS evidence from the caller's existing source/session/
   * freshness gates, at checkedAt. ERS never selects a source or defines TTLs.
   */
  validation: {
    state: 'usable' | 'stale' | 'ineligible' | 'unchecked';
    checkedAt: Date;
  };
};

/** Execution contract, deliberately independent of display/transport books. */
export type ExecutionMarketEvidence = ExecutionEvidenceContext &
  (
    | {
        kind: 'l2';
        /** Complete observed snapshot, possibly truncated; no diff updates. */
        asks: readonly ExecutionLiquidityLevel[];
        bids: readonly ExecutionLiquidityLevel[];
      }
    | {
        kind: 'top_of_book';
        /** null means this side was not supplied, distinct from empty L2. */
        ask: ExecutionTopQuote | null;
        bid: ExecutionTopQuote | null;
      }
    | {
        kind: 'price_only';
        /** Not an inferred bid or ask; null also permits volume-only evidence. */
        referencePrice: string | null;
        /** Historical traded quantity over [from,to), never immediate depth. */
        volume?: { quantity: string; from: Date; to: Date };
      }
  );

export type ExecutionAssessmentReason =
  | 'observed_depth_exhausted'
  | 'observed_size_exceeded'
  | 'no_observed_liquidity'
  | 'limit_price_boundary'
  | 'side_missing'
  | 'size_missing'
  | 'liquidity_model_required'
  | 'evidence_missing'
  | 'evidence_stale'
  | 'evidence_ineligible'
  | 'evidence_unchecked'
  | 'invalid_order'
  | 'invalid_evidence';

/** An observation/proposal only; no persistence or order rejection decision. */
export type ExecutionAssessment = {
  order: ExecutionRealismOrder;
  evidenceKind: ExecutionMarketEvidence['kind'] | 'missing';
  evidenceTimestamps: {
    effectiveAt: string | null;
    capturedAt: string;
    checkedAt: string;
  } | null;
  state:
    | 'full_observed_fill'
    | 'partial_observed_fill'
    | 'no_observed_fill'
    | 'unassessable';
  reason: ExecutionAssessmentReason | null;
  invalidField: string | null;
  referencePrice: string | null;
  referencePriceBasis: 'ask' | 'bid' | 'reference' | null;
  /** null = unknown quantity; zero = known zero observable quantity. */
  observedFillableQuantity: string | null;
  /** Rounded consumed notional; do not reconstruct it from rounded VWAP. */
  observedGrossAmount: string | null;
  /** Amount intents only; may include precision dust even on a full fill. */
  unspentAmount: string | null;
  /** VWAP of the observed consumed quantity only, including partial results. */
  simulatedFillPrice: string | null;
  /** Positive = adverse to the order side, relative to referencePrice. */
  adversePriceImpactBps: string | null;
  levelsConsumed: number;
};
