import type { BatchRunJobResponse } from './batch.types';

export const GENERAL_DAILY_SNAPSHOT_JOB_NAME = 'general-account-daily-snapshot';

export type GeneralDailySnapshotJobInput = {
  snapshotDate?: string;
  dryRun?: boolean;
  requestedBy?: string;
  idempotencyKey?: string;
};

export type GeneralDailySnapshotJobRequestPayload = {
  snapshotDate: string | null;
  dryRun: boolean;
  requestedBy: string | null;
  idempotencyKey: string;
};

/**
 * Per-account outcome counters.
 *
 * `integrityFailed` and `valuationFailed` are reported separately on purpose:
 * a valuation gap is a transient market-data condition an operator waits out,
 * while an integrity failure is damage that needs
 * `pnpm trading-accounts:audit-general`. Collapsing both into `failed` would
 * make a dry run unable to tell the two apart.
 */
export type GeneralDailySnapshotJobAccountSummary = {
  total: number;
  created: number;
  wouldCreate: number;
  existing: number;
  failed: number;
  integrityFailed: number;
  valuationFailed: number;
  excludedClosed: number;
};

export type GeneralDailySnapshotJobErrorCode =
  | 'VALUATION_UNAVAILABLE'
  | 'FX_RATE_UNAVAILABLE'
  | 'FX_RATE_STALE'
  | 'ASSET_PRICE_UNAVAILABLE'
  | 'GENERAL_ACCOUNT_INTEGRITY'
  | 'GENERAL_PERFORMANCE_NOT_INITIALIZED'
  | 'GENERAL_PERFORMANCE_INTEGRITY'
  | 'GENERAL_PERFORMANCE_DISCONTINUITY'
  | 'AD_REWARD_CLAIM_INTEGRITY';

export type GeneralDailySnapshotJobAccountError = {
  tradingAccountId: string;
  userId: string;
  code: GeneralDailySnapshotJobErrorCode;
  message: string;
};

export type GeneralDailySnapshotJobResult = {
  snapshotDate: string;
  dryRun: boolean;
  accounts: GeneralDailySnapshotJobAccountSummary;
  createdSnapshotIds: string[];
  createdEquitySnapshotIds: string[];
  errors: GeneralDailySnapshotJobAccountError[];
};

export type GeneralDailySnapshotJobRunResponse = BatchRunJobResponse;
