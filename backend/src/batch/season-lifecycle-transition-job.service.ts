import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, SeasonStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { BatchRunJobResponse } from './batch.types';
import { BatchService } from './batch.service';
import {
  SEASON_LIFECYCLE_TRANSITION_JOB_NAME,
  SeasonLifecycleTransitionJobInput,
  SeasonLifecycleTransitionJobRequestPayload,
  SeasonLifecycleTransitionJobResult,
} from './season-lifecycle-transition-job.types';

type LifecycleSeason = {
  id: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
};

type LifecycleTransactionClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class SeasonLifecycleTransitionJobService {
  constructor(
    private readonly batchService: BatchService,
    private readonly prisma: PrismaService,
  ) {}

  async run(
    input: SeasonLifecycleTransitionJobInput,
  ): Promise<BatchRunJobResponse> {
    const dryRun = input.dryRun === true;
    const requestedBy = this.parseOptionalText(input.requestedBy);
    const parsedNow = this.parseOptionalDate(input.now);
    const idempotencyKey = this.resolveIdempotencyKey(input, parsedNow);
    const requestPayload: SeasonLifecycleTransitionJobRequestPayload = {
      now: parsedNow?.toISOString() ?? null,
      dryRun,
      requestedBy: requestedBy ?? null,
      idempotencyKey,
    };

    return this.batchService.runJob<
      SeasonLifecycleTransitionJobRequestPayload,
      SeasonLifecycleTransitionJobResult
    >({
      jobName: SEASON_LIFECYCLE_TRANSITION_JOB_NAME,
      idempotencyKey,
      dryRun,
      requestedBy,
      requestPayload,
      handler: ({ startedAt }) =>
        this.runLifecycleTransition({
          now: parsedNow ?? startedAt,
          dryRun,
        }),
    });
  }

  private async runLifecycleTransition(input: {
    now: Date;
    dryRun: boolean;
  }): Promise<SeasonLifecycleTransitionJobResult> {
    const result = this.createBaseResult(input.now, input.dryRun);
    const candidates = await this.findLifecycleCandidates(
      this.prisma,
      input.now,
    );
    result.summary.scanned = candidates.length;

    const plan = this.buildTransitionPlan(candidates, input.now, result);

    if (input.dryRun) {
      result.summary.wouldActivate = plan.toActivate.length;
      result.summary.wouldEnd = plan.toEnd.length;
      result.activatedSeasonIds = plan.toActivate.map((season) => season.id);
      result.endedSeasonIds = plan.toEnd.map((season) => season.id);

      return result;
    }

    return this.prisma.$transaction(async (tx) => {
      const refreshedCandidates = await this.findLifecycleCandidates(tx, input.now);
      result.summary.scanned = refreshedCandidates.length;
      const refreshedPlan = this.buildTransitionPlan(
        refreshedCandidates,
        input.now,
        result,
      );

      if (refreshedPlan.toEnd.length > 0) {
        const endResult = await tx.season.updateMany({
          where: {
            id: {
              in: refreshedPlan.toEnd.map((season) => season.id),
            },
            status: SeasonStatus.active,
            endAt: {
              lte: input.now,
            },
          },
          data: {
            status: SeasonStatus.ended,
          },
        });
        result.summary.ended = endResult.count;
        result.endedSeasonIds = refreshedPlan.toEnd.map((season) => season.id);
      }

      if (refreshedPlan.toActivate.length === 1) {
        const activateResult = await tx.season.updateMany({
          where: {
            id: refreshedPlan.toActivate[0].id,
            status: SeasonStatus.upcoming,
            startAt: {
              lte: input.now,
            },
            endAt: {
              gt: input.now,
            },
          },
          data: {
            status: SeasonStatus.active,
          },
        });
        result.summary.activated = activateResult.count;
        result.activatedSeasonIds =
          activateResult.count === 1 ? [refreshedPlan.toActivate[0].id] : [];
      }

      return result;
    });
  }

  private async findLifecycleCandidates(
    client: LifecycleTransactionClient,
    now: Date,
  ): Promise<LifecycleSeason[]> {
    return client.season.findMany({
      where: {
        OR: [
          {
            status: SeasonStatus.active,
          },
          {
            status: SeasonStatus.upcoming,
            startAt: {
              lte: now,
            },
            endAt: {
              gt: now,
            },
          },
        ],
      },
      orderBy: [{ startAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        status: true,
        startAt: true,
        endAt: true,
      },
    });
  }

  private buildTransitionPlan(
    candidates: readonly LifecycleSeason[],
    now: Date,
    result: SeasonLifecycleTransitionJobResult,
  ): {
    toActivate: LifecycleSeason[];
    toEnd: LifecycleSeason[];
  } {
    const activeBlockingActivation = candidates.filter(
      (season) =>
        season.status === SeasonStatus.active &&
        now.getTime() < season.endAt.getTime(),
    );
    const toEnd = candidates.filter(
      (season) =>
        season.status === SeasonStatus.active &&
        season.endAt.getTime() <= now.getTime(),
    );
    const dueUpcoming = candidates.filter(
      (season) =>
        season.status === SeasonStatus.upcoming &&
        season.startAt.getTime() <= now.getTime() &&
        now.getTime() < season.endAt.getTime(),
    );

    if (activeBlockingActivation.length > 1) {
      this.failWithResult(
        HttpStatus.CONFLICT,
        'DUPLICATE_ACTIVE_SEASON',
        'More than one active season is not expired.',
        result,
      );
    }

    if (activeBlockingActivation.length > 0 && dueUpcoming.length > 0) {
      this.failWithResult(
        HttpStatus.CONFLICT,
        'DUPLICATE_ACTIVE_SEASON',
        'A due upcoming season would create duplicate active seasons.',
        result,
      );
    }

    if (activeBlockingActivation.length === 0 && dueUpcoming.length > 1) {
      this.failWithResult(
        HttpStatus.CONFLICT,
        'DUPLICATE_ACTIVE_SEASON',
        'More than one upcoming season is due for activation.',
        result,
      );
    }

    return {
      toActivate: activeBlockingActivation.length === 0 ? dueUpcoming : [],
      toEnd,
    };
  }

  private createBaseResult(
    now: Date,
    dryRun: boolean,
  ): SeasonLifecycleTransitionJobResult {
    return {
      now: now.toISOString(),
      dryRun,
      summary: {
        scanned: 0,
        wouldActivate: 0,
        activated: 0,
        wouldEnd: 0,
        ended: 0,
      },
      activatedSeasonIds: [],
      endedSeasonIds: [],
      errors: [],
    };
  }

  private resolveIdempotencyKey(
    input: SeasonLifecycleTransitionJobInput,
    parsedNow: Date | undefined,
  ): string {
    const explicitKey = this.parseOptionalText(input.idempotencyKey);
    if (explicitKey) {
      return explicitKey;
    }

    return `${SEASON_LIFECYCLE_TRANSITION_JOB_NAME}:${
      parsedNow?.toISOString() ?? 'auto-now'
    }`;
  }

  private parseOptionalDate(value: unknown): Date | undefined {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        'now must be a valid ISO date-time.',
      );
    }

    return date;
  }

  private parseOptionalText(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const text = value.trim();
    return text === '' ? undefined : text;
  }

  private failWithResult(
    status: HttpStatus,
    code: string,
    message: string,
    result: SeasonLifecycleTransitionJobResult,
  ): never {
    result.errors.push({
      code,
      message,
    });

    throw new HttpException(
      {
        success: false,
        error: {
          code,
          message,
        },
        data: {
          resultPayloadJson: result,
        },
      },
      status,
    );
  }

  private throwJobError(
    status: HttpStatus,
    code: string,
    message: string,
  ): never {
    throw new HttpException(
      {
        success: false,
        error: {
          code,
          message,
        },
      },
      status,
    );
  }
}
