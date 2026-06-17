import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import {
  formatDecimalScale,
  formatMoneyScale8,
  returnRateScale,
} from '../fx/fx-decimal-policy';
import { PrismaService } from '../prisma/prisma.service';
import { BatchService } from './batch.service';
import {
  FINAL_TIER_ASSIGNMENT_JOB_NAME,
  FinalTierAssignmentJobInput,
  FinalTierAssignmentJobRequestPayload,
  FinalTierAssignmentJobResult,
  FinalTierAssignmentJobRunResponse,
  FinalTierAssignmentPolicySummary,
  FinalTierAssignmentPolicyTier,
  FinalTierAssignmentTopAssignment,
} from './final-tier-assignment-job.types';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FINAL_RANK_TYPE = SeasonRankingType.final;
const TOP_ASSIGNMENTS_LIMIT = 10;
const ALLOWED_TIERS = [
  'master',
  'diamond',
  'platinum',
  'gold',
  'silver',
  'bronze',
] as const;

type FinalTier = (typeof ALLOWED_TIERS)[number];
type JsonRecord = Record<string, unknown>;
type TierPolicyRule = {
  tier: FinalTier;
  rule: string;
  matches: (rank: number, totalParticipants: number) => boolean;
};
type ResolvedTierPolicy = {
  summary: FinalTierAssignmentPolicySummary;
  assignTier: (rank: number, totalParticipants: number) => FinalTier;
};
type FinalRankingRow = {
  seasonParticipantId: string;
  rank: number;
  totalAssetKrw: Prisma.Decimal;
  returnRate: Prisma.Decimal;
  seasonParticipant: {
    id: string;
    userId: string;
    finalRank: number | null;
    finalTier: string | null;
  };
};

@Injectable()
export class FinalTierAssignmentJobService {
  constructor(
    private readonly batchService: BatchService,
    private readonly prisma: PrismaService,
  ) {}

  async run(
    input: FinalTierAssignmentJobInput,
  ): Promise<FinalTierAssignmentJobRunResponse> {
    const dryRun = input.dryRun === true;
    const requestedBy = this.parseOptionalText(input.requestedBy);
    const idempotencyKey = this.resolveIdempotencyKey(input);
    const requestPayload: FinalTierAssignmentJobRequestPayload = {
      seasonId: this.parseOptionalText(input.seasonId) ?? null,
      rankingDate: this.parseOptionalText(input.rankingDate) ?? null,
      dryRun,
      requestedBy: requestedBy ?? null,
      idempotencyKey,
    };

    return this.batchService.runJob<
      FinalTierAssignmentJobRequestPayload,
      FinalTierAssignmentJobResult
    >({
      jobName: FINAL_TIER_ASSIGNMENT_JOB_NAME,
      idempotencyKey,
      dryRun,
      requestedBy,
      requestPayload,
      handler: () => this.runFinalTierAssignmentJob(input, dryRun),
    });
  }

  private async runFinalTierAssignmentJob(
    input: FinalTierAssignmentJobInput,
    dryRun: boolean,
  ): Promise<FinalTierAssignmentJobResult> {
    const seasonId = this.parseRequiredText(input.seasonId, 'seasonId');
    const { text: rankingDateText, date: rankingDate } = this.parseRankingDate(
      input.rankingDate,
    );
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

    const policy = this.resolveTierPolicy(season.rewardPolicyJson);
    const rows = await this.findFinalRankingRows(seasonId, rankingDate);
    const result = this.createBaseResult({
      seasonId,
      rankingDate: rankingDateText,
      dryRun,
      policy: policy.summary,
      totalFinalRanked: rows.length,
    });

    if (rows.length === 0) {
      this.failWithResult(
        HttpStatus.BAD_REQUEST,
        'FINAL_RANKING_UNAVAILABLE',
        'Final ranking rows are unavailable for this season and rankingDate.',
        result,
      );
    }

    const assignments = rows.map((row) =>
      this.buildAssignment(row, rows.length, policy),
    );
    const assignableRows = rows.filter(
      (row) => !this.hasExistingFinalResult(row),
    );
    const existingCount = rows.length - assignableRows.length;

    result.participants.wouldAssign = assignableRows.length;
    result.participants.existing = existingCount;
    result.participants.skipped = existingCount;
    result.topAssignments = assignments.slice(0, TOP_ASSIGNMENTS_LIMIT);

    if (dryRun) {
      return result;
    }

    const assignedParticipantIds = await this.assignFinalTiersAtomically(
      seasonId,
      assignableRows,
      rows.length,
      policy,
    );

    result.participants.assigned = assignedParticipantIds.length;
    result.assignedParticipantIds = assignedParticipantIds;
    result.message =
      'Final tier assignment completed. Reward handoff remains a separate gate.';

    return result;
  }

  private async findFinalRankingRows(seasonId: string, rankingDate: Date) {
    return this.prisma.seasonRanking.findMany({
      where: {
        seasonId,
        rankType: FINAL_RANK_TYPE,
        rankingDate,
      },
      orderBy: [{ rank: 'asc' }, { seasonParticipantId: 'asc' }],
      select: {
        seasonParticipantId: true,
        rank: true,
        totalAssetKrw: true,
        returnRate: true,
        seasonParticipant: {
          select: {
            id: true,
            userId: true,
            finalRank: true,
            finalTier: true,
          },
        },
      },
    });
  }

  private async assignFinalTiersAtomically(
    seasonId: string,
    rows: readonly FinalRankingRow[],
    totalParticipants: number,
    policy: ResolvedTierPolicy,
  ): Promise<string[]> {
    if (rows.length === 0) {
      return [];
    }

    return this.prisma.$transaction(async (tx) => {
      const assignedParticipantIds: string[] = [];

      for (const row of rows) {
        const finalTier = policy.assignTier(row.rank, totalParticipants);
        const updated = await tx.seasonParticipant.updateMany({
          where: {
            id: row.seasonParticipantId,
            seasonId,
            finalRank: null,
            finalTier: null,
          },
          data: {
            finalRank: row.rank,
            finalTier,
          },
        });

        if (updated.count !== 1) {
          this.throwJobError(
            HttpStatus.CONFLICT,
            'FINAL_TIER_ASSIGNMENT_CONFLICT',
            'Season participant final result changed before assignment could complete.',
          );
        }

        assignedParticipantIds.push(row.seasonParticipantId);
      }

      return assignedParticipantIds;
    });
  }

  private buildAssignment(
    row: FinalRankingRow,
    totalParticipants: number,
    policy: ResolvedTierPolicy,
  ): FinalTierAssignmentTopAssignment {
    return {
      seasonParticipantId: row.seasonParticipantId,
      userId: row.seasonParticipant.userId,
      finalRank: row.rank,
      finalTier: policy.assignTier(row.rank, totalParticipants),
      totalAssetKrw: formatMoneyScale8(row.totalAssetKrw),
      returnRate: formatDecimalScale(row.returnRate, returnRateScale),
    };
  }

  private hasExistingFinalResult(row: FinalRankingRow): boolean {
    return (
      row.seasonParticipant.finalRank !== null ||
      row.seasonParticipant.finalTier !== null
    );
  }

  private createBaseResult(input: {
    seasonId: string;
    rankingDate: string;
    dryRun: boolean;
    policy: FinalTierAssignmentPolicySummary;
    totalFinalRanked: number;
  }): FinalTierAssignmentJobResult {
    return {
      seasonId: input.seasonId,
      rankingDate: input.rankingDate,
      dryRun: input.dryRun,
      policy: input.policy,
      participants: {
        totalFinalRanked: input.totalFinalRanked,
        wouldAssign: 0,
        assigned: 0,
        existing: 0,
        skipped: 0,
      },
      assignedParticipantIds: [],
      topAssignments: [],
      errors: [],
    };
  }

  private resolveTierPolicy(
    rewardPolicyJson: Prisma.JsonValue | null,
  ): ResolvedTierPolicy {
    const customRules = this.parseSeasonRewardTierPolicy(rewardPolicyJson);

    if (customRules) {
      return {
        summary: {
          source: 'season_reward_policy',
          tiers: customRules.map((rule) => ({
            tier: rule.tier,
            rule: rule.rule,
          })),
        },
        assignTier: (rank, totalParticipants) =>
          this.assignTierFromRules(customRules, rank, totalParticipants),
      };
    }

    const defaultTiers: FinalTierAssignmentPolicyTier[] = [
      { tier: 'master', rule: 'rank == 1' },
      { tier: 'diamond', rule: 'rank <= 3' },
      { tier: 'platinum', rule: 'rank <= 10' },
      { tier: 'gold', rule: 'rank / totalParticipants <= 0.30' },
      { tier: 'silver', rule: 'rank / totalParticipants <= 0.60' },
      { tier: 'bronze', rule: 'fallback' },
    ];

    return {
      summary: {
        source: 'default_mvp',
        tiers: defaultTiers,
      },
      assignTier: (rank, totalParticipants) => {
        if (rank === 1) {
          return 'master';
        }

        if (rank <= 3) {
          return 'diamond';
        }

        if (rank <= 10) {
          return 'platinum';
        }

        const percentage = rank / totalParticipants;
        if (percentage <= 0.3) {
          return 'gold';
        }

        if (percentage <= 0.6) {
          return 'silver';
        }

        return 'bronze';
      },
    };
  }

  private parseSeasonRewardTierPolicy(
    rewardPolicyJson: Prisma.JsonValue | null,
  ): TierPolicyRule[] | null {
    const root = this.asRecord(rewardPolicyJson);
    if (!root) {
      return null;
    }

    const policy = this.asRecord(root.tierPolicy) ?? root;
    const tiers = Array.isArray(policy.tiers) ? policy.tiers : null;
    if (!tiers || tiers.length === 0) {
      return null;
    }

    const rules: TierPolicyRule[] = [];
    let hasFallback = false;

    for (const entry of tiers) {
      const record = this.asRecord(entry);
      const tier = this.parseTier(record?.tier);
      if (!record || !tier) {
        return null;
      }

      const rankEquals = this.parsePositiveInteger(
        record.rank ?? record.rankEquals ?? record.exactRank,
      );
      const maxRank = this.parsePositiveInteger(
        record.maxRank ?? record.rankMax,
      );
      const maxPercent = this.parsePositiveFraction(
        record.maxPercent ?? record.percentMax ?? record.maxPercentile,
      );
      const fallback = record.fallback === true || record.rule === 'fallback';
      const activeRules = [
        rankEquals !== null,
        maxRank !== null,
        maxPercent !== null,
        fallback,
      ].filter(Boolean).length;

      if (activeRules !== 1) {
        return null;
      }

      if (rankEquals !== null) {
        rules.push({
          tier,
          rule: `rank == ${rankEquals}`,
          matches: (rank) => rank === rankEquals,
        });
        continue;
      }

      if (maxRank !== null) {
        rules.push({
          tier,
          rule: `rank <= ${maxRank}`,
          matches: (rank) => rank <= maxRank,
        });
        continue;
      }

      if (maxPercent !== null) {
        rules.push({
          tier,
          rule: `rank / totalParticipants <= ${maxPercent.toFixed(2)}`,
          matches: (rank, totalParticipants) =>
            rank / totalParticipants <= maxPercent,
        });
        continue;
      }

      hasFallback = true;
      rules.push({
        tier,
        rule: 'fallback',
        matches: () => true,
      });
    }

    return hasFallback ? rules : null;
  }

  private assignTierFromRules(
    rules: readonly TierPolicyRule[],
    rank: number,
    totalParticipants: number,
  ): FinalTier {
    return (
      rules.find((rule) => rule.matches(rank, totalParticipants))?.tier ??
      'bronze'
    );
  }

  private parseTier(value: unknown): FinalTier | null {
    if (typeof value !== 'string') {
      return null;
    }

    const tier = value.trim().toLowerCase();
    return this.isFinalTier(tier) ? tier : null;
  }

  private isFinalTier(value: string): value is FinalTier {
    return ALLOWED_TIERS.some((tier) => tier === value);
  }

  private asRecord(value: unknown): JsonRecord | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }

    return value as JsonRecord;
  }

  private parsePositiveInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      return null;
    }

    return value;
  }

  private parsePositiveFraction(value: unknown): number | null {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;

    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
      return null;
    }

    return parsed;
  }

  private assertSeasonStatusAllowed(status: SeasonStatus) {
    if (status === SeasonStatus.settled) {
      return;
    }

    if (status === SeasonStatus.ended) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'SETTLEMENT_REQUIRED',
        'Final tier assignment requires a settled season.',
      );
    }

    this.throwJobError(
      HttpStatus.BAD_REQUEST,
      'SEASON_STATUS_NOT_ALLOWED',
      `Final tier assignment job does not support ${status} seasons.`,
    );
  }

  private resolveIdempotencyKey(input: FinalTierAssignmentJobInput): string {
    const explicitKey = this.parseOptionalText(input.idempotencyKey);
    if (explicitKey) {
      return explicitKey;
    }

    return `${FINAL_TIER_ASSIGNMENT_JOB_NAME}:${this.toBusinessKeySegment(
      input.seasonId,
      'missing-season-id',
    )}:${this.toBusinessKeySegment(input.rankingDate, 'missing-ranking-date')}`;
  }

  private parseRankingDate(value: string | undefined): {
    text: string;
    date: Date;
  } {
    const text = this.parseRequiredText(value, 'rankingDate');
    if (!DATE_ONLY_PATTERN.test(text)) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        'rankingDate must be YYYY-MM-DD.',
      );
    }

    const date = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || this.formatDateOnly(date) !== text) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        'rankingDate must be YYYY-MM-DD.',
      );
    }

    return {
      text,
      date,
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
    result: FinalTierAssignmentJobResult,
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
