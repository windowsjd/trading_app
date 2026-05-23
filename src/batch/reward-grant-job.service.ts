import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, SeasonStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BatchService } from './batch.service';
import {
  REWARD_GRANT_JOB_NAME,
  RewardGrantJobInput,
  RewardGrantJobRequestPayload,
  RewardGrantJobResult,
  RewardGrantJobRunResponse,
  RewardGrantTopReward,
  RewardGrantTopGranted,
} from './reward-grant-job.types';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TOP_GRANTED_LIMIT = 10;
const TOP_REWARDS_LIMIT = 10;
const TOP_TROPHY_RANK = 10;
const REWARD_MARKER_DESCRIPTION =
  'Creates internal reward, badge, and trophy rows while preserving SeasonParticipant.rewardGrantedAt marker semantics. No payment, point, delivery, or external fulfillment is performed.';

const TIER_BADGE_POLICY: Record<
  string,
  {
    rewardCode: string;
    rewardName: string;
  }
> = {
  master: {
    rewardCode: 'TIER_MASTER',
    rewardName: '마스터 뱃지',
  },
  diamond: {
    rewardCode: 'TIER_DIAMOND',
    rewardName: '다이아 뱃지',
  },
  platinum: {
    rewardCode: 'TIER_PLATINUM',
    rewardName: '플래티넘 뱃지',
  },
  gold: {
    rewardCode: 'TIER_GOLD',
    rewardName: '골드 뱃지',
  },
  silver: {
    rewardCode: 'TIER_SILVER',
    rewardName: '실버 뱃지',
  },
  bronze: {
    rewardCode: 'TIER_BRONZE',
    rewardName: '브론즈 뱃지',
  },
};

const TOP10_TROPHY_POLICY = {
  rewardCode: 'TROPHY_TOP10',
  rewardName: 'TOP 10 트로피',
};

type RewardGrantParticipant = {
  id: string;
  userId: string;
  finalRank: number | null;
  finalTier: string | null;
  rewardGrantedAt: Date | null;
};

type FinalAssignedParticipant = RewardGrantParticipant & {
  finalRank: number;
  finalTier: string;
};

type GrantableParticipant = FinalAssignedParticipant & {
  rewardGrantedAt: null;
};

type RewardPlan = {
  seasonId: string;
  seasonParticipantId: string;
  userId: string;
  finalRank: number;
  finalTier: string;
  rewardType: 'badge' | 'trophy';
  badgeType: 'tier_badge' | 'ranker_trophy';
  rewardCode: string;
  rewardName: string;
  grantedAt: Date;
  fromExistingMarker: boolean;
};

type ExistingSeasonRewardRow = {
  seasonParticipantId: string;
  rewardCode: string;
};

type ExistingUserBadgeRow = {
  userId: string;
  seasonId: string;
  badgeCode: string;
};

type BadgeIdRow = {
  id: string;
};

type InsertedIdRow = {
  id: string;
};

type RewardPersistenceClient = {
  $queryRaw: PrismaService['$queryRaw'];
  seasonParticipant: Pick<PrismaService['seasonParticipant'], 'updateMany'>;
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
    const rewardPlans = this.buildRewardPlans({
      seasonId,
      participants: finalAssignedParticipants,
      fallbackGrantTimestamp: grantTimestamp,
    });
    const [existingSeasonRewardKeys, existingUserBadgeKeys] = await Promise.all(
      [
        this.findExistingSeasonRewardKeys(rewardPlans),
        this.findExistingUserBadgeKeys(rewardPlans),
      ],
    );
    const rewardPlanSummary = this.summarizeRewardPlans(
      rewardPlans,
      existingSeasonRewardKeys,
      existingUserBadgeKeys,
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
    result.rewardRows = rewardPlanSummary.rewardRows;
    result.userBadges = rewardPlanSummary.userBadges;
    result.topGranted = this.buildTopGranted(
      grantableParticipants,
      grantTimestamp,
    );
    result.topRewards = this.buildTopRewards(rewardPlans);

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
        'Reward grant dry-run completed. Internal reward rows are previewed; external fulfillment remains a separate gate.';
      return result;
    }

    const persistenceResult = await this.grantRewardsAtomically({
      seasonId,
      grantTimestamp,
      participants: grantableParticipants,
      rewardPlans,
      missingSeasonRewardKeys: rewardPlanSummary.missingSeasonRewardKeys,
      missingUserBadgeKeys: rewardPlanSummary.missingUserBadgeKeys,
    });

    result.participants.granted =
      persistenceResult.grantedParticipantIds.length;
    result.rewardRows.total.created =
      persistenceResult.createdSeasonRewardRows.total;
    result.rewardRows.tierBadge.created =
      persistenceResult.createdSeasonRewardRows.tierBadge;
    result.rewardRows.trophy.created =
      persistenceResult.createdSeasonRewardRows.trophy;
    result.userBadges.created = persistenceResult.createdUserBadges;
    result.grantedParticipantIds = persistenceResult.grantedParticipantIds;
    result.rewardBackfilledParticipantIds =
      persistenceResult.rewardBackfilledParticipantIds;
    result.message =
      'Reward grant completed for internal reward rows and rewardGrantedAt markers. External fulfillment remains a separate gate.';

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
    rewardPlans: readonly RewardPlan[];
    missingSeasonRewardKeys: ReadonlySet<string>;
    missingUserBadgeKeys: ReadonlySet<string>;
  }): Promise<{
    grantedParticipantIds: string[];
    rewardBackfilledParticipantIds: string[];
    createdSeasonRewardRows: {
      total: number;
      tierBadge: number;
      trophy: number;
    };
    createdUserBadges: number;
  }> {
    const hasMissingRewardRows = input.rewardPlans.some((plan) =>
      input.missingSeasonRewardKeys.has(this.seasonRewardKey(plan)),
    );
    const hasMissingUserBadges = input.rewardPlans.some((plan) =>
      input.missingUserBadgeKeys.has(this.userBadgeKey(plan)),
    );

    if (
      input.participants.length === 0 &&
      !hasMissingRewardRows &&
      !hasMissingUserBadges
    ) {
      return {
        grantedParticipantIds: [],
        rewardBackfilledParticipantIds: [],
        createdSeasonRewardRows: {
          total: 0,
          tierBadge: 0,
          trophy: 0,
        },
        createdUserBadges: 0,
      };
    }

    return this.prisma.$transaction(async (tx) => {
      const grantedParticipantIds: string[] = [];
      const backfilledParticipantIds = new Set<string>();
      const createdSeasonRewardRows = {
        total: 0,
        tierBadge: 0,
        trophy: 0,
      };
      let createdUserBadges = 0;

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

      for (const plan of input.rewardPlans) {
        const rewardKey = this.seasonRewardKey(plan);
        const userBadgeKey = this.userBadgeKey(plan);
        const needsSeasonReward = input.missingSeasonRewardKeys.has(rewardKey);
        const needsUserBadge = input.missingUserBadgeKeys.has(userBadgeKey);

        if (!needsSeasonReward && !needsUserBadge) {
          continue;
        }

        const badgeId = await this.upsertBadge(tx, plan);

        if (needsUserBadge) {
          const insertedUserBadge = await this.insertUserBadgeIfMissing(
            tx,
            plan,
            badgeId,
          );
          if (insertedUserBadge) {
            createdUserBadges += 1;
          }
        }

        if (needsSeasonReward) {
          const insertedSeasonReward = await this.insertSeasonRewardIfMissing(
            tx,
            plan,
          );
          if (insertedSeasonReward) {
            createdSeasonRewardRows.total += 1;
            if (plan.rewardType === 'badge') {
              createdSeasonRewardRows.tierBadge += 1;
            } else {
              createdSeasonRewardRows.trophy += 1;
            }
          }
        }

        if (plan.fromExistingMarker) {
          backfilledParticipantIds.add(plan.seasonParticipantId);
        }
      }

      return {
        grantedParticipantIds,
        rewardBackfilledParticipantIds: [...backfilledParticipantIds].sort(),
        createdSeasonRewardRows,
        createdUserBadges,
      };
    });
  }

  private buildRewardPlans(input: {
    seasonId: string;
    participants: readonly FinalAssignedParticipant[];
    fallbackGrantTimestamp: Date;
  }): RewardPlan[] {
    return input.participants.flatMap((participant) => {
      const grantedAt =
        participant.rewardGrantedAt ?? input.fallbackGrantTimestamp;
      const fromExistingMarker = participant.rewardGrantedAt !== null;
      const tierPolicy = TIER_BADGE_POLICY[participant.finalTier];
      const plans: RewardPlan[] = tierPolicy
        ? [
            {
              seasonId: input.seasonId,
              seasonParticipantId: participant.id,
              userId: participant.userId,
              finalRank: participant.finalRank,
              finalTier: participant.finalTier,
              rewardType: 'badge',
              badgeType: 'tier_badge',
              rewardCode: tierPolicy.rewardCode,
              rewardName: tierPolicy.rewardName,
              grantedAt,
              fromExistingMarker,
            },
          ]
        : [];

      if (participant.finalRank <= TOP_TROPHY_RANK) {
        plans.push({
          seasonId: input.seasonId,
          seasonParticipantId: participant.id,
          userId: participant.userId,
          finalRank: participant.finalRank,
          finalTier: participant.finalTier,
          rewardType: 'trophy',
          badgeType: 'ranker_trophy',
          rewardCode: TOP10_TROPHY_POLICY.rewardCode,
          rewardName: TOP10_TROPHY_POLICY.rewardName,
          grantedAt,
          fromExistingMarker,
        });
      }

      return plans;
    });
  }

  private async findExistingSeasonRewardKeys(
    rewardPlans: readonly RewardPlan[],
  ): Promise<Set<string>> {
    if (rewardPlans.length === 0) {
      return new Set();
    }

    const participantIds = this.uniqueSorted(
      rewardPlans.map((plan) => plan.seasonParticipantId),
    );
    const rewardCodes = this.uniqueSorted(
      rewardPlans.map((plan) => plan.rewardCode),
    );
    const rows = await this.prisma.$queryRaw<ExistingSeasonRewardRow[]>(
      Prisma.sql`
        SELECT
          "season_participant_id" AS "seasonParticipantId",
          "reward_code" AS "rewardCode"
        FROM "season_rewards"
        WHERE "season_participant_id" IN (${Prisma.join(participantIds)})
          AND "reward_code" IN (${Prisma.join(rewardCodes)})
      `,
    );

    return new Set(
      rows.map((row) =>
        this.seasonRewardKey({
          seasonParticipantId: row.seasonParticipantId,
          rewardCode: row.rewardCode,
        }),
      ),
    );
  }

  private async findExistingUserBadgeKeys(
    rewardPlans: readonly RewardPlan[],
  ): Promise<Set<string>> {
    if (rewardPlans.length === 0) {
      return new Set();
    }

    const userIds = this.uniqueSorted(rewardPlans.map((plan) => plan.userId));
    const seasonIds = this.uniqueSorted(
      rewardPlans.map((plan) => plan.seasonId),
    );
    const badgeCodes = this.uniqueSorted(
      rewardPlans.map((plan) => plan.rewardCode),
    );
    const rows = await this.prisma.$queryRaw<ExistingUserBadgeRow[]>(
      Prisma.sql`
        SELECT
          ub."user_id" AS "userId",
          ub."season_id" AS "seasonId",
          b."code" AS "badgeCode"
        FROM "user_badges" ub
        INNER JOIN "badges" b ON b."id" = ub."badge_id"
        WHERE ub."user_id" IN (${Prisma.join(userIds)})
          AND ub."season_id" IN (${Prisma.join(seasonIds)})
          AND b."code" IN (${Prisma.join(badgeCodes)})
      `,
    );

    return new Set(
      rows.map((row) =>
        this.userBadgeKey({
          userId: row.userId,
          seasonId: row.seasonId,
          rewardCode: row.badgeCode,
        }),
      ),
    );
  }

  private summarizeRewardPlans(
    rewardPlans: readonly RewardPlan[],
    existingSeasonRewardKeys: ReadonlySet<string>,
    existingUserBadgeKeys: ReadonlySet<string>,
  ) {
    const missingSeasonRewardKeys = new Set<string>();
    const missingUserBadgeKeys = new Set<string>();
    const rewardRows = {
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
    };
    const userBadges = {
      wouldCreate: 0,
      created: 0,
      existing: 0,
    };

    for (const plan of rewardPlans) {
      const rewardKey = this.seasonRewardKey(plan);
      const userBadgeKey = this.userBadgeKey(plan);
      const rewardRowBucket =
        plan.rewardType === 'badge' ? rewardRows.tierBadge : rewardRows.trophy;

      if (existingSeasonRewardKeys.has(rewardKey)) {
        rewardRows.total.existing += 1;
        rewardRowBucket.existing += 1;
      } else {
        missingSeasonRewardKeys.add(rewardKey);
        rewardRows.total.wouldCreate += 1;
        rewardRowBucket.wouldCreate += 1;
      }

      if (existingUserBadgeKeys.has(userBadgeKey)) {
        userBadges.existing += 1;
      } else {
        missingUserBadgeKeys.add(userBadgeKey);
        userBadges.wouldCreate += 1;
      }
    }

    return {
      rewardRows,
      userBadges,
      missingSeasonRewardKeys,
      missingUserBadgeKeys,
    };
  }

  private async upsertBadge(
    tx: RewardPersistenceClient,
    plan: RewardPlan,
  ): Promise<string> {
    const now = new Date();
    const rows = await tx.$queryRaw<BadgeIdRow[]>(
      Prisma.sql`
        INSERT INTO "badges" (
          "id",
          "badge_type",
          "code",
          "name",
          "description",
          "icon_url",
          "created_at",
          "updated_at"
        )
        VALUES (
          ${randomUUID()},
          ${plan.badgeType}::"BadgeType",
          ${plan.rewardCode},
          ${plan.rewardName},
          NULL,
          NULL,
          ${now},
          ${now}
        )
        ON CONFLICT ("code") DO UPDATE
        SET
          "badge_type" = EXCLUDED."badge_type",
          "name" = EXCLUDED."name",
          "updated_at" = EXCLUDED."updated_at"
        RETURNING "id"
      `,
    );

    const badgeId = rows[0]?.id;
    if (!badgeId) {
      this.throwJobError(
        HttpStatus.CONFLICT,
        'BADGE_UPSERT_FAILED',
        'Badge row could not be created or found.',
      );
    }

    return badgeId;
  }

  private async insertUserBadgeIfMissing(
    tx: RewardPersistenceClient,
    plan: RewardPlan,
    badgeId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<InsertedIdRow[]>(
      Prisma.sql`
        INSERT INTO "user_badges" (
          "id",
          "user_id",
          "badge_id",
          "season_id",
          "awarded_at",
          "created_at"
        )
        VALUES (
          ${randomUUID()},
          ${plan.userId},
          ${badgeId},
          ${plan.seasonId},
          ${plan.grantedAt},
          ${new Date()}
        )
        ON CONFLICT ("user_id", "badge_id", "season_id") DO NOTHING
        RETURNING "id"
      `,
    );

    return rows.length > 0;
  }

  private async insertSeasonRewardIfMissing(
    tx: RewardPersistenceClient,
    plan: RewardPlan,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<InsertedIdRow[]>(
      Prisma.sql`
        INSERT INTO "season_rewards" (
          "id",
          "season_id",
          "season_participant_id",
          "user_id",
          "reward_type",
          "reward_code",
          "reward_name",
          "reward_value_json",
          "granted_at",
          "created_at"
        )
        VALUES (
          ${randomUUID()},
          ${plan.seasonId},
          ${plan.seasonParticipantId},
          ${plan.userId},
          ${plan.rewardType}::"SeasonRewardType",
          ${plan.rewardCode},
          ${plan.rewardName},
          NULL,
          ${plan.grantedAt},
          ${new Date()}
        )
        ON CONFLICT ("season_participant_id", "reward_code") DO NOTHING
        RETURNING "id"
      `,
    );

    return rows.length > 0;
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

  private buildTopRewards(
    rewardPlans: readonly RewardPlan[],
  ): RewardGrantTopReward[] {
    return rewardPlans.slice(0, TOP_REWARDS_LIMIT).map((plan) => ({
      seasonParticipantId: plan.seasonParticipantId,
      userId: plan.userId,
      finalRank: plan.finalRank,
      finalTier: plan.finalTier,
      rewardType: plan.rewardType,
      rewardCode: plan.rewardCode,
      rewardName: plan.rewardName,
      grantedAt: plan.grantedAt.toISOString(),
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
        source: 'internal_reward_foundation_mvp',
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
      errors: [],
    };
  }

  private seasonRewardKey(input: {
    seasonParticipantId: string;
    rewardCode: string;
  }) {
    return `${input.seasonParticipantId}:${input.rewardCode}`;
  }

  private userBadgeKey(input: {
    userId: string;
    seasonId: string;
    rewardCode: string;
  }) {
    return `${input.userId}:${input.seasonId}:${input.rewardCode}`;
  }

  private uniqueSorted(values: readonly string[]) {
    return [...new Set(values)].sort();
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
