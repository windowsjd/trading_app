import type { AssetType, OrderSide } from '../generated/prisma/client';
import type { ExecutionMarketEvidence } from './execution-realism.types';

/** A normalized execution snapshot, never AssetOrderBook or provider transport. */
type WithoutValidation<T> = T extends unknown ? Omit<T, 'validation'> : never;
export type ExecutionEvidenceCandidate = {
  evidence: WithoutValidation<ExecutionMarketEvidence>;
  /** Public-safe, stable adapter source label, never a URL/token/raw payload. */
  source: string;
};

export type MarketExecutionContext = {
  assetId: string;
  assetType: AssetType;
  market: string;
  priceCurrency: string;
  /** Canonical shares for stocks, base asset units for crypto. */
  quantityUnit: 'share' | 'base_asset';
  side: OrderSide;
  executedAt: Date;
};

/**
 * TRUSTED SERVER COMPOSITION boundary. Deliberately NOT registered in
 * OrdersModule; there is no HTTP field/env flag that enables ERS.
 * B2-2 adapters must obtain snapshots outside DB locks. Both methods below
 * are synchronous, local-only, and operate on the exact same snapshot.
 * validate must use the adapter's audited source/session/freshness policies,
 * at context.executedAt, never a cached B1 assessment or validation verdict.
 */
export abstract class MarketExecutionEvidenceAdapter {
  abstract read(
    context: MarketExecutionContext,
  ): ExecutionEvidenceCandidate | null;
  abstract validate(
    candidate: ExecutionEvidenceCandidate,
    context: MarketExecutionContext,
  ): {
    sourceEligible: boolean;
    sessionEligible: boolean;
    fresh: boolean;
  };
}

export const MARKET_REMAINDER_CANCEL_REASON = 'insufficient_market_liquidity';
