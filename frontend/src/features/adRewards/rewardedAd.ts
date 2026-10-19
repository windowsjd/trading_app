/**
 * The device side of a rewarded ad (2026-10-20).
 *
 * The app chooses WHAT the completion is for before the ad is shown — the
 * 5,000,000 KRW top-up, or a general-account reset already confirmed by the
 * user — and passes it to the provider so the provider's server-side
 * verification can bind the completion to that purpose and account. The app
 * never decides that an ad was completed: it forwards the provider's opaque
 * proof, and the server verifies it.
 *
 * NO REWARDED-AD SDK IS INTEGRATED YET. `getRewardedAdProvider` therefore
 * returns null, the reward sheet shows "광고 기능 준비 중", and no completion —
 * real or fabricated — can be produced on a device. Integrating an SDK means
 * returning its adapter from `getRewardedAdProvider`; the claim/reset flow,
 * its idempotency and its result handling stay as they are.
 */

export type RewardedAdPurpose = 'funding' | 'account_reset';

export type RewardedAdOutcome =
  /** The provider's opaque proof of a completed ad, verified by the server. */
  | { status: 'completed'; proof: string }
  /** Closed before the reward point: nothing to claim. */
  | { status: 'dismissed' }
  /** No ad could be loaded or shown right now. */
  | { status: 'unavailable' };

export interface RewardedAdProvider {
  /** The provider key the server's AD_REWARD_PROVIDER names. */
  readonly key: string;
  show(input: {
    purpose: RewardedAdPurpose;
    tradingAccountId: string;
    /** The command this ad is for, so the proof can be bound to it. */
    idempotencyKey: string;
  }): Promise<RewardedAdOutcome>;
}

export function getRewardedAdProvider(): RewardedAdProvider | null {
  return null;
}
