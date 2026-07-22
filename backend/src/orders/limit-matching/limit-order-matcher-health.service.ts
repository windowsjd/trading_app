import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  OpsJobName,
  OpsJobRunStatus,
  OpsJobTrigger,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { readLimitOrderMatchingConfig } from './limit-order-matching.config';

type HealthClient = Pick<Prisma.TransactionClient, 'opsJobRun'>;

@Injectable()
export class LimitOrderMatcherHealthService {
  private readonly config = readLimitOrderMatchingConfig();

  constructor(private readonly prisma: PrismaService) {}

  async startLeader(input: {
    consumerName: string;
    startedAt: Date;
  }): Promise<string> {
    const run = await this.prisma.opsJobRun.create({
      data: {
        jobName: OpsJobName.limit_order_matcher,
        status: OpsJobRunStatus.running,
        trigger: OpsJobTrigger.worker,
        requestedBy: input.consumerName,
        startedAt: input.startedAt,
        lockKey: 'limit-order-matcher:leader:v1',
        metadataJson: {
          consumerName: input.consumerName,
          lastHeartbeat: input.startedAt.toISOString(),
          degradedReason: null,
        },
      },
      select: { id: true },
    });
    return run.id;
  }

  async heartbeat(
    runId: string,
    metadata: Record<string, Prisma.InputJsonValue | null>,
  ): Promise<void> {
    const updated = await this.prisma.opsJobRun.updateMany({
      where: { id: runId, status: OpsJobRunStatus.running },
      data: {
        metadataJson: {
          ...metadata,
          lastHeartbeat: new Date().toISOString(),
          degradedReason: null,
        } as Prisma.InputJsonObject,
      },
    });
    if (updated.count !== 1) {
      throw new Error(
        'Limit-order matcher Ops heartbeat row is no longer active.',
      );
    }
  }

  async degradeActiveLeader(code: string, message: string): Promise<void> {
    const run = await this.prisma.opsJobRun.findFirst({
      where: {
        jobName: OpsJobName.limit_order_matcher,
        status: OpsJobRunStatus.running,
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    if (!run) return;
    await this.fail(run.id, code, message);
  }

  async recordEventFailure(input: {
    consumerName: string;
    streamId: string;
    eventId: string | null;
    code: string;
    message: string;
  }): Promise<void> {
    const now = new Date();
    await this.prisma.opsJobRun.create({
      data: {
        jobName: OpsJobName.limit_order_matcher,
        status: OpsJobRunStatus.failed,
        trigger: OpsJobTrigger.worker,
        requestedBy: input.consumerName,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        errorCode: input.code,
        errorMessage: input.message.slice(0, 1000),
        metadataJson: {
          streamId: input.streamId,
          eventId: input.eventId,
          dlq: true,
        },
      },
    });
  }

  async fail(runId: string, code: string, message: string): Promise<void> {
    const current = await this.prisma.opsJobRun.findUnique({
      where: { id: runId },
      select: { metadataJson: true },
    });
    const previousMetadata =
      current?.metadataJson &&
      typeof current.metadataJson === 'object' &&
      !Array.isArray(current.metadataJson)
        ? (current.metadataJson as Prisma.InputJsonObject)
        : {};
    await this.prisma.opsJobRun.updateMany({
      where: { id: runId, status: OpsJobRunStatus.running },
      data: {
        status: OpsJobRunStatus.failed,
        finishedAt: new Date(),
        errorCode: code,
        errorMessage: message.slice(0, 1000),
        metadataJson: { ...previousMetadata, degradedReason: code },
      },
    });
  }

  async finish(runId: string): Promise<void> {
    await this.prisma.opsJobRun.updateMany({
      where: { id: runId, status: OpsJobRunStatus.running },
      data: { status: OpsJobRunStatus.succeeded, finishedAt: new Date() },
    });
  }

  async assertAvailable(
    client: HealthClient = this.prisma,
    now = new Date(),
  ): Promise<void> {
    if (!this.config.enabled) return;
    const cutoff = new Date(now.getTime() - this.config.healthMaxAgeMs);
    const run = await client.opsJobRun.findFirst({
      where: {
        jobName: OpsJobName.limit_order_matcher,
        status: OpsJobRunStatus.running,
        updatedAt: { gte: cutoff },
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    if (!run) {
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'LIMIT_ORDER_MATCHER_UNAVAILABLE',
            message: 'Limit-order automatic matching is not healthy.',
          },
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
