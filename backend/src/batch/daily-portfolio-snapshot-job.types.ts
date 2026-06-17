import type { BatchRunJobResponse } from './batch.types';

export const DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME = 'daily-portfolio-snapshot';

export type DailyPortfolioSnapshotJobInput = {
  seasonId?: string;
  snapshotDate?: string;
  dryRun?: boolean;
  requestedBy?: string;
  idempotencyKey?: string;
};

export type DailyPortfolioSnapshotJobRequestPayload = {
  seasonId: string | null;
  snapshotDate: string | null;
  dryRun: boolean;
  requestedBy: string | null;
  idempotencyKey: string;
};

export type DailyPortfolioSnapshotJobParticipantSummary = {
  total: number;
  created: number;
  wouldCreate: number;
  existing: number;
  failed: number;
  skipped: number;
};

export type DailyPortfolioSnapshotJobErrorCode =
  | 'VALUATION_UNAVAILABLE'
  | 'FX_RATE_UNAVAILABLE'
  | 'FX_RATE_STALE'
  | 'ASSET_PRICE_UNAVAILABLE';

export type DailyPortfolioSnapshotJobParticipantError = {
  seasonParticipantId: string;
  userId: string;
  code: DailyPortfolioSnapshotJobErrorCode;
  message: string;
};

export type DailyPortfolioSnapshotJobSourceSummary = {
  participantsUsingProviderApi: number;
  participantsUsingAdminManual: number;
  participantsUsingFallback: number;
  fallbackReasons: string[];
  rejectedProviderReasons: string[];
  providerApiUsed: boolean;
  adminManualUsed: boolean;
  fallbackUsed: boolean;
};

export type DailyPortfolioSnapshotJobResult = {
  seasonId: string;
  snapshotDate: string;
  dryRun: boolean;
  participants: DailyPortfolioSnapshotJobParticipantSummary;
  createdSnapshotIds: string[];
  errors: DailyPortfolioSnapshotJobParticipantError[];
  sourceSummary?: DailyPortfolioSnapshotJobSourceSummary;
};

export type DailyPortfolioSnapshotJobRunResponse = BatchRunJobResponse;
