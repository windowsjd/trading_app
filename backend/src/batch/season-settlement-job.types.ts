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

/**
 * Season TradingAccount lifecycle (작업 8 §14.4).
 *
 * `linked` counts every participant account of the season, including excluded
 * ones — closure is season-wide, unlike final ranking which is eligible-only.
 * `closed` is what this run actually closed or completed (already-closed
 * accounts with a closedAt are left untouched and still counted here, because
 * the post-condition being reported is "all of them are closed").
 */
export type SeasonSettlementJobAccountSummary = {
  linked: number;
  closed: number;
  wouldClose: number;
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
  seasonAccounts: SeasonSettlementJobAccountSummary;
  createdFinalSnapshotIds: string[];
  updatedFinalSnapshotIds: string[];
  createdFinalRankingIds: string[];
  assignedFinalTierParticipantIds: string[];
  closedTradingAccountIds: string[];
  finishedParticipantIds: string[];
  topRanks: SeasonSettlementJobTopRank[];
  errors: SeasonSettlementJobError[];
  reason?: string;
  message?: string;
};

export type SeasonSettlementJobRunResponse = BatchRunJobResponse;
