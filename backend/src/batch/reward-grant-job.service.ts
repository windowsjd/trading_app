import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BatchService } from './batch.service';
import {
  REWARD_GRANT_JOB_NAME,
  REWARD_POLICY_GATE_CLOSED,
  REWARD_POLICY_GATE_CLOSED_MESSAGE,
  RewardGrantJobInput,
  RewardGrantJobRequestPayload,
  RewardGrantJobResult,
  RewardGrantJobRunResponse,
} from './reward-grant-job.types';

@Injectable()
export class RewardGrantJobService {
  constructor(
    private readonly batchService: BatchService,
    private readonly prisma: PrismaService,
  ) {}

  async run(input: RewardGrantJobInput): Promise<RewardGrantJobRunResponse> {
    const dryRun = input.dryRun === true;
    const requestedBy = this.parseOptionalText(input.requestedBy);
    const idempotencyKey = this.resolveIdempotencyKey(input);
    const requestPayload: RewardGrantJobRequestPayload = {
      seasonId: this.parseOptionalText(input.seasonId) ?? null,
      grantDate: this.parseOptionalText(input.grantDate) ?? null,
      dryRun,
      requestedBy: requestedBy ?? null,
      idempotencyKey,
    };

    return this.batchService.runJob<
      RewardGrantJobRequestPayload,
      RewardGrantJobResult
    >({
      jobName: REWARD_GRANT_JOB_NAME,
      idempotencyKey,
      dryRun,
      requestedBy,
      requestPayload,
      handler: ({ startedAt }) => {
        this.assertNoRewardWritesConfigured();
        this.throwGateClosed(requestPayload, startedAt);
      },
    });
  }

  private throwGateClosed(
    requestPayload: RewardGrantJobRequestPayload,
    startedAt: Date,
  ): never {
    const result: RewardGrantJobResult = {
      seasonId: requestPayload.seasonId,
      dryRun: requestPayload.dryRun,
      grantTimestamp: startedAt.toISOString(),
      grantDate: requestPayload.grantDate,
      policy: {
        source: 'reward_policy_catalog_gate_closed',
        description: REWARD_POLICY_GATE_CLOSED_MESSAGE,
        rewardPolicyJsonAvailable: false,
      },
      participants: {
        total: 0,
        eligible: 0,
        wouldGrant: 0,
        granted: 0,
        existing: 0,
        ineligible: 0,
        skipped: 0,
      },
      rewardRows: {
        total: {
          wouldCreate: 0,
          created: 0,
          existing: 0,
        },
        tierBadge: {
          wouldCreate: 0,
          created: 0,
          existing: 0,
        },
        trophy: {
          wouldCreate: 0,
          created: 0,
          existing: 0,
        },
      },
      userBadges: {
        wouldCreate: 0,
        created: 0,
        existing: 0,
      },
      grantedParticipantIds: [],
      rewardBackfilledParticipantIds: [],
      topGranted: [],
      topRewards: [],
      errors: [
        {
          code: REWARD_POLICY_GATE_CLOSED,
          message: REWARD_POLICY_GATE_CLOSED_MESSAGE,
        },
      ],
      reason: REWARD_POLICY_GATE_CLOSED,
      message: REWARD_POLICY_GATE_CLOSED_MESSAGE,
    };

    throw new HttpException(
      {
        success: false,
        error: {
          code: REWARD_POLICY_GATE_CLOSED,
          message: REWARD_POLICY_GATE_CLOSED_MESSAGE,
        },
        data: {
          resultPayloadJson: result,
        },
      },
      HttpStatus.CONFLICT,
    );
  }

  private assertNoRewardWritesConfigured() {
    void this.prisma;
  }

  private resolveIdempotencyKey(input: RewardGrantJobInput): string {
    const explicitKey = this.parseOptionalText(input.idempotencyKey);
    if (explicitKey) {
      return explicitKey;
    }

    const key = `${REWARD_GRANT_JOB_NAME}:${this.toBusinessKeySegment(
      input.seasonId,
      'missing-season-id',
    )}`;
    const grantDate = this.parseOptionalText(input.grantDate);

    return grantDate ? `${key}:${grantDate}` : key;
  }

  private parseOptionalText(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const text = value.trim();
    return text === '' ? undefined : text;
  }

  private toBusinessKeySegment(value: unknown, fallback: string): string {
    return this.parseOptionalText(value) ?? fallback;
  }
}
