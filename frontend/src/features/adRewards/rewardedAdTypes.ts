/**
 * The device side of a rewarded ad (2026-10-20; AdMob 2026-11-07).
 *
 * The app chooses WHAT the ad is for before it is shown — the 5,000,000 KRW
 * top-up, or a general-account reset already confirmed by the user — and the
 * server opens a session for that command first (POST …/ad-rewards/sessions).
 * The provider only shows the ad with the session's server-side verification
 * options. Its `earned` outcome is NOT evidence: the server pays or resets
 * only once Google's signed callback confirmed that session.
 */
export type RewardedAdPurpose = 'funding' | 'account_reset';

/** What the ad is doing, for the sheet's status line. */
export type RewardedAdPhase = 'loading' | 'showing' | 'earned';

export type RewardedAdOutcome =
  /** The ad reported its reward and closed (or failed after it). Still to be confirmed by the server. */
  | { status: 'earned' }
  /** Closed before the reward point: nothing to claim. */
  | { status: 'dismissed' }
  /** No ad could be shown: consent forbids requests, none loaded, it failed to show, or another is on screen. */
  | { status: 'unavailable'; reason: 'consent' | 'load' | 'show' | 'busy' };

export interface RewardedAdProvider {
  /** The provider key the server's AD_REWARD_PROVIDER names. */
  readonly key: string;
  /** The session's platform (the server accepts only that platform's rewarded unit). */
  readonly platform: 'android' | 'ios';
  show(input: {
    /** From the server session: set on the ad before it is shown. */
    ssv: { userId: string; customData: string };
    onPhase?: (phase: RewardedAdPhase) => void;
  }): Promise<RewardedAdOutcome>;
}
