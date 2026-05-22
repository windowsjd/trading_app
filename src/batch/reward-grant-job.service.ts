import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { SeasonStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BatchService } from './batch.service';
import {
  REWARD_GRANT_JOB_NAME,
  RewardGrantJobInput,
  RewardGrantJobRequestPayload,
  RewardGrantJobResult,
  RewardGrantJobRunResponse,
  RewardGrantTopGranted,
} from './reward-grant-job.types';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TOP_GRANTED_LIMIT = 10;
const REWARD_MARKER_DESCRIPTION =
  'Marks reward as granted by setting SeasonParticipant.rewardGrantedAt. No payment, point, badge, or trophy is created.';

type RewardGrantParticipant = {
  id: string;
  userId: string;
  finalRank: number | null;
  finalTier: string | null;
  rewardGrantedAt: Date | null;
};

type GrantableParticipant = RewardGrantParticipant & {
  finalRank: number;
  finalTier: string;
  rewardGrantedAt: null;
};

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
      handler: ({ startedAt }) =>
        this.runRewardGrantJob(input, dryRun, startedAt),
    });
  }

  private async runRewardGrantJob(
    input: RewardGrantJobInput,
    dryRun: boolean,
    startedAt: Date,
  ): Promise<RewardGrantJobResult> {
    const seasonId = this.parseRequiredText(input.seasonId, 'seasonId');
    const { text: grantDate, timestamp: grantTimestamp } =
      this.parseGrantTimestamp(input.grantDate, startedAt);
    const season = await this.prisma.season.findUnique({
      where: {
        id: seasonId,
      },
      select: {
        id: true,
        status: true,
        rewardPolicyJson: true,
      },
    });

    if (!season) {
      this.throwJobError(
        HttpStatus.NOT_FOUND,
        'SEASON_NOT_FOUND',
        'Season not found.',
      );
    }

    this.assertSeasonStatusAllowed(season.status);

    const participants = await this.findParticipants(seasonId);
    const result = this.createBaseResult({
      seasonId,
      dryRun,
      grantTimestamp,
      grantDate,
      rewardPolicyJsonAvailable: season.rewardPolicyJson !== null,
      participantsTotal: participants.length,
    });
    const finalAssignedParticipants =
      this.sortFinalAssignedParticipants(participants);
    const grantableParticipants = finalAssignedParticipants.filter(
      this.isGrantableParticipant,
    );
    const existingCount =
      finalAssignedParticipants.length - grantableParticipants.length;
    const ineligibleCount =
      participants.length - finalAssignedParticipants.length;

    result.participants.eligible = grantableParticipants.length;
    result.participants.wouldGrant = grantableParticipants.length;
    result.participants.existing = existingCount;
    result.participants.ineligible = ineligibleCount;
    result.participants.skipped = existingCount + ineligibleCount;
    result.topGranted = this.buildTopGranted(
      grantableParticipants,
      grantTimestamp,
    );

    if (finalAssignedParticipants.length === 0) {
      this.failWithResult(
        HttpStatus.BAD_REQUEST,
        'FINAL_TIER_ASSIGNMENT_REQUIRED',
        'Reward grant requires settled participants with finalRank and finalTier assigned.',
        result,
      );
    }

    if (dryRun) {
      result.message =
        'Reward grant marker dry-run completed. Actual payment/badge/trophy fulfillment remains a separate gate.';
      return result;
    }

    const grantedParticipantIds = await this.grantRewardsAtomically({
      seasonId,
      grantTimestamp,
      participants: grantableParticipants,
    });

    result.participants.granted = grantedParticipantIds.length;
    result.grantedParticipantIds = grantedParticipantIds;
    result.message =
      'Reward grant marker completed. Actual payment/badge/trophy fulfillment remains a separate gate.';

    return result;
  }

  private async findParticipants(seasonId: string) {
    return this.prisma.seasonParticipant.findMany({
      where: {
        seasonId,
      },
      orderBy: [{ userId: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        userId: true,
        finalRank: true,
        finalTier: true,
        rewardGrantedAt: true,
      },
    });
  }

  private async grantRewardsAtomically(input: {
    seasonId: string;
    grantTimestamp: Date;
    participants: readonly GrantableParticipant[];
  }): Promise<string[]> {
    if (input.participants.length === 0) {
      return [];
    }

    return this.prisma.$transaction(async (tx) => {
      const grantedParticipantIds: string[] = [];

      for (const participant of input.participants) {
        const updated = await tx.seasonParticipant.updateMany({
          where: {
            id: participant.id,
            seasonId: input.seasonId,
            finalRank: participant.finalRank,
            finalTier: participant.finalTier,
            rewardGrantedAt: null,
          },
          data: {
            rewardGrantedAt: input.grantTimestamp,
          },
        });

        if (updated.count !== 1) {
          this.throwJobError(
            HttpStatus.CONFLICT,
            'REWARD_GRANT_CONFLICT',
            'Season participant reward state changed before reward marker could be granted.',
          );
        }

        grantedParticipantIds.push(participant.id);
      }

      return grantedParticipantIds;
    });
  }

  private sortFinalAssignedParticipants(
    participants: readonly RewardGrantParticipant[],
  ) {
    return participants
      .filter(this.hasFinalAssignment)
      .toSorted((left, right) => {
        const rankDiff = left.finalRank - right.finalRank;
        if (rankDiff !== 0) {
          return rankDiff;
        }

        return left.id.localeCompare(right.id);
      });
  }

  private hasFinalAssignment(
    participant: RewardGrantParticipant,
  ): participant is RewardGrantParticipant & {
    finalRank: number;
    finalTier: string;
  } {
    return participant.finalRank !== null && participant.finalTier !== null;
  }

  private isGrantableParticipant(
    participant: RewardGrantParticipant & {
      finalRank: number;
      finalTier: string;
    },
  ): participant is GrantableParticipant {
    return participant.rewardGrantedAt === null;
  }

  private buildTopGranted(
    participants: readonly GrantableParticipant[],
    grantTimestamp: Date,
  ): RewardGrantTopGranted[] {
    return participants.slice(0, TOP_GRANTED_LIMIT).map((participant) => ({
      seasonParticipantId: participant.id,
      userId: participant.userId,
      finalRank: participant.finalRank,
      finalTier: participant.finalTier,
      rewardGrantedAt: grantTimestamp.toISOString(),
    }));
  }

  private createBaseResult(input: {
    seasonId: string;
    dryRun: boolean;
    grantTimestamp: Date;
    grantDate: string | null;
    rewardPolicyJsonAvailable: boolean;
    participantsTotal: number;
  }): RewardGrantJobResult {
    return {
      seasonId: input.seasonId,
      dryRun: input.dryRun,
      grantTimestamp: input.grantTimestamp.toISOString(),
      grantDate: input.grantDate,
      policy: {
        source: 'reward_marker_mvp',
        description: REWARD_MARKER_DESCRIPTION,
        rewardPolicyJsonAvailable: input.rewardPolicyJsonAvailable,
      },
      participants: {
        total: input.participantsTotal,
        eligible: 0,
        wouldGrant: 0,
        granted: 0,
        existing: 0,
        ineligible: 0,
        skipped: 0,
      },
      grantedParticipantIds: [],
      topGranted: [],
      errors: [],
    };
  }

  private assertSeasonStatusAllowed(status: SeasonStatus) {
    if (status === SeasonStatus.settled) {
      return;
    }

    if (status === SeasonStatus.ended) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'SETTLEMENT_REQUIRED',
        'Reward grant requires a settled season.',
      );
    }

    this.throwJobError(
      HttpStatus.BAD_REQUEST,
      'SEASON_STATUS_NOT_ALLOWED',
      `Reward grant job does not support ${status} seasons.`,
    );
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

  private parseGrantTimestamp(
    value: string | undefined,
    startedAt: Date,
  ): {
    text: string | null;
    timestamp: Date;
  } {
    const text = this.parseOptionalText(value);
    if (!text) {
      return {
        text: null,
        timestamp: startedAt,
      };
    }

    if (!DATE_ONLY_PATTERN.test(text)) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        'grantDate must be YYYY-MM-DD.',
      );
    }

    const timestamp = new Date(`${text}T00:00:00.000Z`);
    if (
      Number.isNaN(timestamp.getTime()) ||
      this.formatDateOnly(timestamp) !== text
    ) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        'grantDate must be YYYY-MM-DD.',
      );
    }

    return {
      text,
      timestamp,
    };
  }

  private parseRequiredText(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
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

  private toBusinessKeySegment(value: unknown, fallback: string): string {
    return this.parseOptionalText(value) ?? fallback;
  }

  private formatDateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private failWithResult(
    status: HttpStatus,
    code: string,
    message: string,
    result: RewardGrantJobResult,
  ): never {
    result.reason = code;
    result.message = message;
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
