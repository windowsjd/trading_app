import type { BatchRunJobResponse } from './batch.types';
import type {
  DailyPortfolioSnapshotJobParticipantError,
  DailyPortfolioSnapshotJobParticipantSummary,
} from './daily-portfolio-snapshot-job.types';
import type {
  SeasonRankingJobError,
  SeasonRankingJobParticipantSummary,
  SeasonRankingJobRankingSummary,
  SeasonRankingJobTopRank,
} from './season-ranking-job.types';

export const DAILY_SEASON_CYCLE_JOB_NAME = 'daily-season-cycle';

export type DailySeasonCycleJobInput = {
  seasonId?: string;
  snapshotDate?: string;
  dryRun?: boolean;
  requestedBy?: string;
  idempotencyKey?: string;
};

export type DailySeasonCycleJobRequestPayload = {
  seasonId: string | null;
  snapshotDate: string | null;
  dryRun: boolean;
  requestedBy: string | null;
  idempotencyKey: string;
};

export type DailySeasonCycleStepState =
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'not_run';

export type DailySeasonCycleDailySnapshotSummary = {
  participants: DailyPortfolioSnapshotJobParticipantSummary;
  createdSnapshotIds: string[];
};

export type DailySeasonCycleSeasonRankingSummary = {
  participants: SeasonRankingJobParticipantSummary;
  rankings: SeasonRankingJobRankingSummary;
  createdRankingIds: string[];
  topRanks: SeasonRankingJobTopRank[];
  reason?: string;
  message?: string;
};

export type DailySeasonCycleStep<TSummary, TError> = {
  state: DailySeasonCycleStepState;
  runId: string | null;
  deduplicated: boolean;
  skipped: boolean;
  summary: TSummary | null;
  errors: TError[];
};

export type DailySeasonCycleJobError = {
  code: string;
  message: string;
};

export type DailySeasonCycleJobResult = {
  seasonId: string;
  snapshotDate: string;
  dryRun: boolean;
  steps: {
    dailyPortfolioSnapshot: DailySeasonCycleStep<
      DailySeasonCycleDailySnapshotSummary,
      DailyPortfolioSnapshotJobParticipantError | DailySeasonCycleJobError
    >;
    seasonRanking: DailySeasonCycleStep<
      DailySeasonCycleSeasonRankingSummary,
      SeasonRankingJobError | DailySeasonCycleJobError
    >;
  };
};

export type DailySeasonCycleJobRunResponse = BatchRunJobResponse;
