import type { BatchRunJobResponse } from './batch.types';

export const FINAL_TIER_ASSIGNMENT_JOB_NAME = 'final-tier-assignment';

export type FinalTierAssignmentJobInput = {
  seasonId?: string;
  rankingDate?: string;
  dryRun?: boolean;
  requestedBy?: string;
  idempotencyKey?: string;
};

export type FinalTierAssignmentJobRequestPayload = {
  seasonId: string | null;
  rankingDate: string | null;
  dryRun: boolean;
  requestedBy: string | null;
  idempotencyKey: string;
};

export type FinalTierAssignmentPolicySource =
  | 'default_mvp'
  | 'season_reward_policy';

export type FinalTierAssignmentPolicyTier = {
  tier: string;
  rule: string;
};

export type FinalTierAssignmentPolicySummary = {
  source: FinalTierAssignmentPolicySource;
  tiers: FinalTierAssignmentPolicyTier[];
};

export type FinalTierAssignmentParticipantSummary = {
  totalFinalRanked: number;
  wouldAssign: number;
  assigned: number;
  existing: number;
  skipped: number;
};

export type FinalTierAssignmentTopAssignment = {
  seasonParticipantId: string;
  userId: string;
  finalRank: number;
  finalTier: string;
  totalAssetKrw: string;
  returnRate: string;
};

export type FinalTierAssignmentError = {
  code: string;
  message: string;
};

export type FinalTierAssignmentJobResult = {
  seasonId: string;
  rankingDate: string;
  dryRun: boolean;
  policy: FinalTierAssignmentPolicySummary;
  participants: FinalTierAssignmentParticipantSummary;
  assignedParticipantIds: string[];
  topAssignments: FinalTierAssignmentTopAssignment[];
  errors: FinalTierAssignmentError[];
  reason?: string;
  message?: string;
};

export type FinalTierAssignmentJobRunResponse = BatchRunJobResponse;
