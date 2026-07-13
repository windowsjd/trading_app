import { Injectable } from '@nestjs/common';
import {
  OpsJobName,
  OpsJobRun,
  OpsJobRunStatus,
  OpsJobTrigger,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { sanitizeOpsJson } from './ops-redaction';

export type SerializedOpsJobRun = {
  id: string;
  jobName: OpsJobName;
  status: OpsJobRunStatus;
  trigger: OpsJobTrigger;
  requestedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  lockKey: string | null;
  idempotencyKey: string | null;
  dryRun: boolean;
  attempt: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  resultJson: Prisma.JsonValue | null;
  metadataJson: Prisma.JsonValue | null;
  createdAt: string;
  updatedAt: string;
};

export type OpsJobRunCreateInput = {
  jobName: OpsJobName;
  trigger: OpsJobTrigger;
  requestedBy?: string | null;
  startedAt?: Date;
  lockKey?: string | null;
  idempotencyKey?: string | null;
  dryRun?: boolean;
  attempt?: number;
  maxAttempts?: number;
  metadataJson?: unknown;
};

@Injectable()
export class OpsJobRunService {
  constructor(private readonly prisma: PrismaService) {}

  createRunning(input: OpsJobRunCreateInput) {
    const startedAt = input.startedAt ?? new Date();

    return this.prisma.opsJobRun.create({
      data: {
        jobName: input.jobName,
        status: OpsJobRunStatus.running,
        trigger: input.trigger,
        requestedBy: this.optionalString(input.requestedBy),
        startedAt,
        lockKey: this.optionalString(input.lockKey),
        idempotencyKey: this.optionalString(input.idempotencyKey),
        dryRun: input.dryRun === true,
        attempt: input.attempt ?? 1,
        maxAttempts: input.maxAttempts ?? 1,
        ...(input.metadataJson === undefined
          ? {}
          : {
              metadataJson: this.toJsonInput(input.metadataJson),
            }),
      },
    });
  }

  async recordSucceeded(
    run: Pick<OpsJobRun, 'id' | 'startedAt'>,
    input: { finishedAt?: Date; resultJson?: unknown },
  ) {
    const finishedAt = input.finishedAt ?? new Date();

    return this.prisma.opsJobRun.update({
      where: {
        id: run.id,
      },
      data: {
        status: OpsJobRunStatus.succeeded,
        finishedAt,
        durationMs: this.durationMs(run.startedAt, finishedAt),
        ...(input.resultJson === undefined
          ? {}
          : {
              resultJson: this.toJsonInput(input.resultJson),
            }),
      },
    });
  }

  async recordFailed(
    run: Pick<OpsJobRun, 'id' | 'startedAt'>,
    input: {
      finishedAt?: Date;
      errorCode: string;
      errorMessage: string;
      resultJson?: unknown;
    },
  ) {
    const finishedAt = input.finishedAt ?? new Date();

    return this.prisma.opsJobRun.update({
      where: {
        id: run.id,
      },
      data: {
        status: OpsJobRunStatus.failed,
        finishedAt,
        durationMs: this.durationMs(run.startedAt, finishedAt),
        errorCode: this.requiredString(input.errorCode, 'errorCode'),
        errorMessage: this.requiredString(input.errorMessage, 'errorMessage'),
        ...(input.resultJson === undefined
          ? {}
          : {
              resultJson: this.toJsonInput(input.resultJson),
            }),
      },
    });
  }

  recordSkipped(input: OpsJobRunCreateInput & { resultJson?: unknown }) {
    return this.createTerminalRun(OpsJobRunStatus.skipped, input);
  }

  recordLocked(input: OpsJobRunCreateInput & { resultJson?: unknown }) {
    return this.createTerminalRun(OpsJobRunStatus.locked, input);
  }

  findLatestRunForJob(jobName: OpsJobName) {
    return this.prisma.opsJobRun.findFirst({
      where: {
        jobName,
      },
      orderBy: [
        { startedAt: 'desc' },
        { finishedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        jobName: true,
        status: true,
        startedAt: true,
        finishedAt: true,
      },
    });
  }

  findLatestSucceededRunForJob(jobName: OpsJobName) {
    return this.prisma.opsJobRun.findFirst({
      where: {
        jobName,
        status: OpsJobRunStatus.succeeded,
        dryRun: false,
      },
      orderBy: [{ finishedAt: 'desc' }, { startedAt: 'desc' }],
      select: {
        jobName: true,
        status: true,
        startedAt: true,
        finishedAt: true,
      },
    });
  }

  findLatestSucceededReconciliationRun(market: 'KRX' | 'US' | 'CRYPTO') {
    return this.prisma.opsJobRun.findFirst({
      where: {
        jobName: OpsJobName.market_candle_reconciliation,
        status: OpsJobRunStatus.succeeded,
        dryRun: false,
        metadataJson: {
          path: ['reconciliationMarket'],
          equals: market,
        },
      },
      orderBy: [{ finishedAt: 'desc' }, { startedAt: 'desc' }],
      select: {
        jobName: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        metadataJson: true,
      },
    });
  }

  serializeRun(run: OpsJobRun): SerializedOpsJobRun {
    return {
      id: run.id,
      jobName: run.jobName,
      status: run.status,
      trigger: run.trigger,
      requestedBy: run.requestedBy,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      durationMs: run.durationMs,
      lockKey: run.lockKey,
      idempotencyKey: run.idempotencyKey,
      dryRun: run.dryRun,
      attempt: run.attempt,
      maxAttempts: run.maxAttempts,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      resultJson: run.resultJson,
      metadataJson: run.metadataJson,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    };
  }

  private createTerminalRun(
    status: OpsJobRunStatus,
    input: OpsJobRunCreateInput & { resultJson?: unknown },
  ) {
    const startedAt = input.startedAt ?? new Date();
    const finishedAt = startedAt;

    return this.prisma.opsJobRun.create({
      data: {
        jobName: input.jobName,
        status,
        trigger: input.trigger,
        requestedBy: this.optionalString(input.requestedBy),
        startedAt,
        finishedAt,
        durationMs: 0,
        lockKey: this.optionalString(input.lockKey),
        idempotencyKey: this.optionalString(input.idempotencyKey),
        dryRun: input.dryRun === true,
        attempt: input.attempt ?? 1,
        maxAttempts: input.maxAttempts ?? 1,
        ...(input.resultJson === undefined
          ? {}
          : {
              resultJson: this.toJsonInput(input.resultJson),
            }),
        ...(input.metadataJson === undefined
          ? {}
          : {
              metadataJson: this.toJsonInput(input.metadataJson),
            }),
      },
    });
  }

  private toJsonInput(
    value: unknown,
  ): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
    const sanitized = sanitizeOpsJson(value);
    if (sanitized === null) {
      return Prisma.JsonNull;
    }

    return sanitized as Prisma.InputJsonValue;
  }

  private durationMs(startedAt: Date, finishedAt: Date) {
    return Math.max(0, finishedAt.getTime() - startedAt.getTime());
  }

  private optionalString(value: string | null | undefined) {
    if (value === null || value === undefined) {
      return null;
    }

    const normalized = value.trim();
    return normalized === '' ? null : normalized;
  }

  private requiredString(value: string, fieldName: string) {
    if (typeof value !== 'string' || value.trim() === '') {
      return `${fieldName} missing`;
    }

    return value.trim();
  }
}
