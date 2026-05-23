import type { BatchRunJobResponse } from './batch.types';

export const REWARD_GRANT_JOB_NAME = 'reward-grant';

export type RewardGrantJobInput = {
  seasonId?: string;
  grantDate?: string;
  dryRun?: boolean;
  requestedBy?: string;
  idempotencyKey?: string;
};

export type RewardGrantJobRequestPayload = {
  seasonId: string | null;
  grantDate: string | null;
  dryRun: boolean;
  requestedBy: string | null;
  idempotencyKey: string;
};

export type RewardGrantPolicySummary = {
  source: 'internal_reward_foundation_mvp';
  description: string;
  rewardPolicyJsonAvailable: boolean;
};

export type RewardGrantParticipantSummary = {
  total: number;
  eligible: number;
  wouldGrant: number;
  granted: number;
  existing: number;
  ineligible: number;
  skipped: number;
};

export type RewardGrantTopGranted = {
  seasonParticipantId: string;
  userId: string;
  finalRank: number;
  finalTier: string;
  rewardGrantedAt: string;
};

export type RewardGrantTopReward = {
  seasonParticipantId: string;
  userId: string;
  finalRank: number;
  finalTier: string;
  rewardType: 'badge' | 'trophy';
  rewardCode: string;
  rewardName: string;
  grantedAt: string;
};

export type RewardGrantRowSummary = {
  wouldCreate: number;
  created: number;
  existing: number;
};

export type RewardGrantRowsSummary = {
  total: RewardGrantRowSummary;
  tierBadge: RewardGrantRowSummary;
  trophy: RewardGrantRowSummary;
};

export type RewardGrantUserBadgeSummary = RewardGrantRowSummary;

export type RewardGrantError = {
  code: string;
  message: string;
};

export type RewardGrantJobResult = {
  seasonId: string;
  dryRun: boolean;
  grantTimestamp: string;
  grantDate: string | null;
  policy: RewardGrantPolicySummary;
  participants: RewardGrantParticipantSummary;
  rewardRows: RewardGrantRowsSummary;
  userBadges: RewardGrantUserBadgeSummary;
  grantedParticipantIds: string[];
  rewardBackfilledParticipantIds: string[];
  topGranted: RewardGrantTopGranted[];
  topRewards: RewardGrantTopReward[];
  errors: RewardGrantError[];
  reason?: string;
  message?: string;
};

export type RewardGrantJobRunResponse = BatchRunJobResponse;
