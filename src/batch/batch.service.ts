import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  BatchJobRun,
  BatchJobStatus,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  BatchGetJobRunResponse,
  BatchJobRunListQuery,
  BatchListJobRunsResponse,
  BatchRunJobParams,
  BatchRunJobResponse,
  SerializedBatchJobRun,
} from './batch.types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

@Injectable()
export class BatchService {
  constructor(private readonly prisma: PrismaService) {}

  async runJob<TInput, TResult>(
    params: BatchRunJobParams<TInput, TResult>,
  ): Promise<BatchRunJobResponse> {
    const jobName = this.parseRequiredText(params.jobName, 'jobName');
    const idempotencyKey = this.parseRequiredText(
      params.idempotencyKey,
      'idempotencyKey',
    );
    const dryRun = params.dryRun === true;
    const requestedBy = this.parseOptionalText(params.requestedBy);
    const startedAt = new Date();
    const createData: Prisma.BatchJobRunCreateInput = {
      jobName,
      idempotencyKey,
      status: BatchJobStatus.running,
      dryRun,
      startedAt,
      requestedBy,
      ...(params.requestPayload === undefined
        ? {}
        : {
            requestPayloadJson: this.toJsonInput(params.requestPayload),
          }),
    };

    let run: BatchJobRun;
    try {
      run = await this.prisma.batchJobRun.create({
        data: createData,
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return this.handleDuplicateJob(jobName, idempotencyKey);
      }

      throw error;
    }

    try {
      const result = await params.handler({
        runId: run.id,
        jobName,
        idempotencyKey,
        dryRun,
        startedAt,
      });
      const finishedAt = new Date();
      const succeededRun = await this.prisma.batchJobRun.update({
        where: {
          id: run.id,
        },
        data: {
          status: BatchJobStatus.succeeded,
          finishedAt,
          ...(result === undefined
            ? {}
            : {
                resultPayloadJson: this.toJsonInput(result),
              }),
        },
      });

      return this.runResponse(succeededRun, {
        deduplicated: false,
        skipped: false,
      });
    } catch (error) {
      const errorCode = this.extractErrorCode(error);
      const errorMessage = this.extractErrorMessage(error);
      const failedRun = await this.prisma.batchJobRun.update({
        where: {
          id: run.id,
        },
        data: {
          status: BatchJobStatus.failed,
          finishedAt: new Date(),
          errorCode,
          errorMessage,
        },
      });

      throw new HttpException(
        {
          ...this.createErrorBody('BATCH_JOB_FAILED', 'Batch job failed.'),
          data: {
            run: this.serializeRun(failedRun),
          },
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getJobRun(runId: string | undefined): Promise<BatchGetJobRunResponse> {
    const id = this.parseRequiredText(runId, 'runId');
    const run = await this.prisma.batchJobRun.findUnique({
      where: {
        id,
      },
    });

    if (!run) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'BATCH_JOB_RUN_NOT_FOUND',
        'Batch job run not found.',
      );
    }

    return {
      success: true,
      data: {
        run: this.serializeRun(run),
      },
    };
  }

  async listJobRuns(
    query: BatchJobRunListQuery = {},
  ): Promise<BatchListJobRunsResponse> {
    const parsedQuery = this.parseListQuery(query);
    const where: Prisma.BatchJobRunWhereInput = {
      ...(parsedQuery.jobName ? { jobName: parsedQuery.jobName } : {}),
      ...(parsedQuery.status ? { status: parsedQuery.status } : {}),
    };
    const [total, runs] = await Promise.all([
      this.prisma.batchJobRun.count({ where }),
      this.prisma.batchJobRun.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: parsedQuery.offset,
        take: parsedQuery.limit,
      }),
    ]);

    return {
      success: true,
      data: {
        jobRuns: runs.map((run) => this.serializeRun(run)),
        pagination: {
          limit: parsedQuery.limit,
          offset: parsedQuery.offset,
          total,
          returned: runs.length,
        },
      },
    };
  }

  private async handleDuplicateJob(
    jobName: string,
    idempotencyKey: string,
  ): Promise<BatchRunJobResponse> {
    const existingRun = await this.prisma.batchJobRun.findUnique({
      where: {
        jobName_idempotencyKey: {
          jobName,
          idempotencyKey,
        },
      },
    });

    if (!existingRun) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'BATCH_JOB_IDEMPOTENCY_CONFLICT',
        'Batch job idempotency conflict.',
      );
    }

    if (existingRun.status === BatchJobStatus.succeeded) {
      return this.runResponse(existingRun, {
        deduplicated: true,
        skipped: true,
        message: 'Batch job already succeeded for this idempotency key.',
      });
    }

    if (
      existingRun.status === BatchJobStatus.running ||
      existingRun.status === BatchJobStatus.pending
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'BATCH_JOB_ALREADY_RUNNING',
        'Batch job is already running for this idempotency key.',
      );
    }

    if (existingRun.status === BatchJobStatus.failed) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'BATCH_JOB_RETRY_REQUIRES_NEW_IDEMPOTENCY_KEY',
        'Failed batch jobs require a new idempotencyKey for retry.',
      );
    }

    return this.runResponse(existingRun, {
      deduplicated: true,
      skipped: true,
      message: 'Batch job was already skipped for this idempotency key.',
    });
  }

  private runResponse(
    run: BatchJobRun,
    metadata: {
      deduplicated: boolean;
      skipped: boolean;
      message?: string;
    },
  ): BatchRunJobResponse {
    return {
      success: true,
      data: {
        run: this.serializeRun(run),
        ...metadata,
      },
    };
  }

  private parseListQuery(query: BatchJobRunListQuery) {
    return {
      jobName: this.parseOptionalText(query.jobName),
      status: this.parseStatus(query.status),
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
  }

  private parseStatus(value: string | undefined): BatchJobStatus | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (
      text === BatchJobStatus.pending ||
      text === BatchJobStatus.running ||
      text === BatchJobStatus.succeeded ||
      text === BatchJobStatus.failed ||
      text === BatchJobStatus.skipped
    ) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_BATCH_JOB_STATUS',
      'Invalid batch job status.',
    );
  }

  private parseLimit(value: string | number | undefined): number {
    if (value === undefined) {
      return DEFAULT_LIMIT;
    }

    const limit = this.parseNonNegativeInteger(value, 'INVALID_LIMIT', 'limit');
    if (limit < 1) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_LIMIT',
        'limit must be greater than 0.',
      );
    }

    return Math.min(limit, MAX_LIMIT);
  }

  private parseOffset(value: string | number | undefined): number {
    if (value === undefined) {
      return 0;
    }

    return this.parseNonNegativeInteger(value, 'INVALID_OFFSET', 'offset');
  }

  private parseNonNegativeInteger(
    value: string | number,
    code: string,
    fieldName: string,
  ) {
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        `${fieldName} must be a non-negative integer.`,
      );
    }

    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        `${fieldName} must be a safe integer.`,
      );
    }

    return parsed;
  }

  private parseRequiredText(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_BATCH_JOB_REQUEST',
        `${fieldName} is required.`,
      );
    }

    return value.trim();
  }

  private parseOptionalText(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const text = value.trim();
    return text === '' ? undefined : text;
  }

  private serializeRun(run: BatchJobRun): SerializedBatchJobRun {
    return {
      id: run.id,
      jobName: run.jobName,
      idempotencyKey: run.idempotencyKey,
      status: run.status,
      dryRun: run.dryRun,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      requestedBy: run.requestedBy,
      requestPayloadJson: run.requestPayloadJson,
      resultPayloadJson: run.resultPayloadJson,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    };
  }

  private toJsonInput(
    value: unknown,
  ): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
    if (value === null) {
      return Prisma.JsonNull;
    }

    return value as Prisma.InputJsonValue;
  }

  private isUniqueConstraintError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }

  private extractErrorCode(error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.trim() !== ''
    ) {
      return error.code.trim();
    }

    return 'BATCH_JOB_FAILED';
  }

  private extractErrorMessage(error: unknown) {
    if (error instanceof Error && error.message.trim() !== '') {
      return error.message;
    }

    return 'Batch job failed.';
  }

  private createErrorBody(code: string, message: string) {
    return {
      success: false,
      error: {
        code,
        message,
      },
    };
  }

  private throwApiError(status: HttpStatus, code: string, message: string): never {
    throw new HttpException(this.createErrorBody(code, message), status);
  }
}
