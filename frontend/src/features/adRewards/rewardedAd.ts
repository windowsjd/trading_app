import type { RewardedAdProvider } from './rewardedAdTypes';

export type { RewardedAdOutcome, RewardedAdPhase, RewardedAdProvider, RewardedAdPurpose } from './rewardedAdTypes';

/**
 * Web, Node and other hosts without the native SDK show no rewarded ad (the
 * AdMob provider is rewardedAd.native.ts). The 보상 sheet then stays under
 * "광고 기능 준비 중" and sends nothing.
 */
export function getRewardedAdProvider(): RewardedAdProvider | null {
  return null;
}
