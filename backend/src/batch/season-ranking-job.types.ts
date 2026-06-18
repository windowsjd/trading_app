import type { BatchRunJobResponse } from './batch.types';

export const SEASON_RANKING_JOB_NAME = 'season-ranking';

export type SeasonRankingJobInput = {
  seasonId?: string;
  snapshotDate?: string;
  dryRun?: boolean;
  requestedBy?: string;
  idempotencyKey?: string;
};

export type SeasonRankingJobRequestPayload = {
  seasonId: string | null;
  snapshotDate: string | null;
  dryRun: boolean;
  requestedBy: string | null;
  idempotencyKey: string;
};

export type SeasonRankingJobParticipantSummary = {
  snapshotted: number;
  missingSnapshots: number;
};

export type SeasonRankingJobRankingSummary = {
  wouldCreate: number;
  created: number;
  existing: number;
  skipped: number;
};

export type SeasonRankingJobTopRank = {
  seasonParticipantId: string;
  userId: string;
  rank: number;
  totalAssetKrw: string;
  returnRate: string;
  maxDrawdown: string;
  totalFillCount: number;
  reachedReturnAt: string | null;
};

export type SeasonRankingJobError = {
  code: string;
  message: string;
};

export type SeasonRankingJobResult = {
  seasonId: string;
  snapshotDate: string;
  dryRun: boolean;
  participants: SeasonRankingJobParticipantSummary;
  rankings: SeasonRankingJobRankingSummary;
  createdRankingIds: string[];
  topRanks: SeasonRankingJobTopRank[];
  errors: SeasonRankingJobError[];
  reason?: string;
  message?: string;
};

export type SeasonRankingJobRunResponse = BatchRunJobResponse;
