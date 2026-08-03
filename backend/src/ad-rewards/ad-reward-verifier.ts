import { createHash } from 'node:crypto';

/**
 * Provider-neutral rewarded-ad verification (작업 6).
 *
 * NO real ad network has been chosen yet, so this file deliberately contains
 * NO provider protocol, SDK, callback shape, or signature scheme. It defines
 * only the contract a future adapter must satisfy, so that picking a provider
 * later is an additive change.
 *
 * WHAT A VERIFIER MUST PROVE before the server pays anything:
 *  - the ad-completion event was genuinely issued by that provider,
 *  - the event is in a COMPLETED state,
 *  - it is bound to the user the server expected,
 *  - it is bound to the general trading account the server expected,
 *  - its event id is a stable, unique identifier for that single completion.
 *
 * WHAT A CLIENT MAY NEVER DECIDE — none of these are read from the request:
 * rewardAmountKrw, providerEventId, userId, tradingAccountId, grantedAt,
 * balanceAfter, the daily counters, or the cooldown. The request carries only
 * the provider key and an opaque proof.
 *
 * PRODUCTION MUST NOT REGISTER A FAKE VERIFIER. With no adapter registered
 * the feature answers 503 AD_REWARD_PROVIDER_UNAVAILABLE; an unverifiable ad
 * completion is never treated as complete. Test-only deterministic fakes are
 * injected through the registry in tests (see ad-reward.module.ts, which
 * registers nothing).
 */

export type AdRewardVerificationRequest = {
  /** Provider key exactly as configured in AD_REWARD_PROVIDER. */
  provider: string;
  /** Opaque provider proof / verification token from the client. */
  proof: string;
  /** The authenticated user the completion must be bound to. */
  expectedUserId: string;
  /** The owned general account the completion must be bound to. */
  expectedTradingAccountId: string;
};

export type AdRewardVerificationSuccess = {
  ok: true;
  provider: string;
  /**
   * The provider's stable unique id for this ad completion. It is the
   * duplicate-payout key ((provider, providerEventId) is UNIQUE) and MUST
   * come from the verifier, never from the client.
   */
  providerEventId: string;
  /** When the provider says the completion happened. */
  occurredAt: Date;
  /**
   * Non-sensitive fields the adapter explicitly allows to be persisted.
   * Tokens, signatures, raw callback bodies, and personal identifiers must
   * never appear here.
   */
  metadata?: Record<string, string | number | boolean | null>;
};

export type AdRewardVerificationFailure = {
  ok: false;
  /** Short machine code for logs/claims; never provider secrets. */
  reasonCode: string;
  /** Operator-facing detail; never echoes the proof. */
  reason: string;
};

export type AdRewardVerificationResult =
  | AdRewardVerificationSuccess
  | AdRewardVerificationFailure;

export interface AdRewardVerifier {
  /** Provider key this adapter handles (matches AD_REWARD_PROVIDER). */
  readonly provider: string;
  verify(
    request: AdRewardVerificationRequest,
  ): Promise<AdRewardVerificationResult>;
}

/**
 * Registry of available provider adapters. It is EMPTY in production wiring
 * today; `resolve` returning undefined is what makes the feature answer 503
 * instead of paying out.
 */
export class AdRewardVerificationRegistry {
  private readonly verifiers = new Map<string, AdRewardVerifier>();

  constructor(verifiers: readonly AdRewardVerifier[] = []) {
    for (const verifier of verifiers) {
      this.register(verifier);
    }
  }

  register(verifier: AdRewardVerifier): void {
    this.verifiers.set(verifier.provider, verifier);
  }

  resolve(provider: string): AdRewardVerifier | undefined {
    return this.verifiers.get(provider);
  }

  listProviders(): string[] {
    return [...this.verifiers.keys()].sort();
  }
}

/** DI token for the registry (an empty registry is the production default). */
export const AD_REWARD_VERIFICATION_REGISTRY =
  'AD_REWARD_VERIFICATION_REGISTRY';

/**
 * One-way digest of the proof, stored INSTEAD of the proof itself so a
 * duplicate submission is still recognizable in an audit without the database
 * ever holding a replayable ad token.
 */
export function buildAdRewardProofFingerprint(proof: string): string {
  return createHash('sha256').update(proof, 'utf8').digest('hex');
}
