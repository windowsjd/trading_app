import type { SeasonStatus } from '../generated/prisma/client';
import type { BatchRunJobResponse } from './batch.types';

export const SEASON_SETTLEMENT_JOB_NAME = 'season-settlement';

export type SeasonSettlementJobInput = {
  seasonId?: string;
  settlementDate?: string;
  dryRun?: boolean;
  requestedBy?: string;
  idempotencyKey?: string;
};

export type SeasonSettlementJobRequestPayload = {
  seasonId: string | null;
  settlementDate: string | null;
  dryRun: boolean;
  requestedBy: string | null;
  idempotencyKey: string;
};

export type SeasonSettlementJobSeasonSummary = {
  previousStatus: SeasonStatus;
  nextStatus: SeasonStatus;
  updated: boolean;
};

export type SeasonSettlementJobParticipantSummary = {
  total: number;
  snapshotted: number;
  missingSnapshots: number;
};

export type SeasonSettlementJobFinalRankingSummary = {
  wouldCreate: number;
  created: number;
  existing: number;
  skipped: number;
};

export type SeasonSettlementJobFinalSnapshotSummary = {
  wouldCreate: number;
  created: number;
  updated: number;
  existing: number;
};

export type SeasonSettlementJobFinalTierSummary = {
  wouldAssign: number;
  assigned: number;
  existing: number;
  skipped: number;
};

export type SeasonSettlementJobTopRank = {
  seasonParticipantId: string;
  userId: string;
  rank: number;
  totalAssetKrw: string;
  returnRate: string;
  maxDrawdown: string;
  totalFillCount: number;
  reachedReturnAt: string | null;
};

export type SeasonSettlementJobError = {
  code: string;
  message: string;
};

export type SeasonSettlementJobResult = {
  seasonId: string;
  settlementDate: string;
  dryRun: boolean;
  season: SeasonSettlementJobSeasonSummary;
  participants: SeasonSettlementJobParticipantSummary;
  finalSnapshots: SeasonSettlementJobFinalSnapshotSummary;
  finalRankings: SeasonSettlementJobFinalRankingSummary;
  finalTiers: SeasonSettlementJobFinalTierSummary;
  createdFinalSnapshotIds: string[];
  updatedFinalSnapshotIds: string[];
  createdFinalRankingIds: string[];
  assignedFinalTierParticipantIds: string[];
  topRanks: SeasonSettlementJobTopRank[];
  errors: SeasonSettlementJobError[];
  reason?: string;
  message?: string;
};

export type SeasonSettlementJobRunResponse = BatchRunJobResponse;
