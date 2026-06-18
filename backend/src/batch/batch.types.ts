import {
  BatchJobRun,
  BatchJobStatus,
  Prisma,
} from '../generated/prisma/client';

export type BatchJobHandlerContext = {
  runId: string;
  jobName: string;
  idempotencyKey: string;
  dryRun: boolean;
  startedAt: Date;
};

export type BatchRunJobParams<TInput, TResult> = {
  jobName: string;
  idempotencyKey: string;
  dryRun?: boolean;
  requestedBy?: string;
  requestPayload?: TInput;
  handler: (context: BatchJobHandlerContext) => Promise<TResult> | TResult;
};

export type BatchJobRunListQuery = {
  jobName?: string;
  status?: string;
  limit?: string | number;
  offset?: string | number;
};

export type SerializedBatchJobRun = {
  id: string;
  jobName: string;
  idempotencyKey: string;
  status: BatchJobStatus;
  dryRun: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  requestedBy: string | null;
  requestPayloadJson: Prisma.JsonValue | null;
  resultPayloadJson: Prisma.JsonValue | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BatchRunJobResponse = {
  success: true;
  data: {
    run: SerializedBatchJobRun;
    deduplicated: boolean;
    skipped: boolean;
    message?: string;
  };
};

export type BatchGetJobRunResponse = {
  success: true;
  data: {
    run: SerializedBatchJobRun;
  };
};

export type BatchListJobRunsResponse = {
  success: true;
  data: {
    jobRuns: SerializedBatchJobRun[];
    pagination: {
      limit: number;
      offset: number;
      total: number;
      returned: number;
      nextOffset: number | null;
    };
  };
};

export type BatchJobRunRecord = BatchJobRun;
