import type { RewardedTestSdk } from './rewardedTest';

// Web/Node/unsupported hosts never import a native ads module.
export const getRewardedTestUnit = (): string | null => null;
export const loadRewardedTestSdk = (): Promise<RewardedTestSdk> => Promise.reject(new Error('Native development or preview build required.'));
