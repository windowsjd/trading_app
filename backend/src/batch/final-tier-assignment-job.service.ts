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
const FINAL_TIER_CUTOFF_RULES = [
  { tier: 'master', cumulativeRatio: 0.04 },
  { tier: 'diamond', cumulativeRatio: 0.11 },
  { tier: 'platinum', cumulativeRatio: 0.23 },
  { tier: 'gold', cumulativeRatio: 0.4 },
  { tier: 'silver', cumulativeRatio: 0.7 },
  { tier: 'bronze', cumulativeRatio: 1 },
] as const satisfies readonly FinalTierCutoffRule[];

type FinalTier = (typeof ALLOWED_TIERS)[number];
type FinalTierCutoffRule = {
  tier: FinalTier;
  cumulativeRatio: number;
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

    const policy = this.resolveTierPolicy();
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
    const computedFinalTier = policy.assignTier(row.rank, totalParticipants);
    const willAssign = !this.hasExistingFinalResult(row);

    return {
      seasonParticipantId: row.seasonParticipantId,
      userId: row.seasonParticipant.userId,
      finalRank: row.rank,
      finalTier: computedFinalTier,
      existingFinalRank: row.seasonParticipant.finalRank,
      existingFinalTier: row.seasonParticipant.finalTier,
      computedFinalTier,
      willAssign,
      skipReason: willAssign ? null : 'FINAL_RESULT_ALREADY_EXISTS',
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

  private resolveTierPolicy(): ResolvedTierPolicy {
    return {
      summary: {
        source: 'default_mvp',
        tiers: FINAL_TIER_CUTOFF_RULES.map((rule) => ({
          tier: rule.tier,
          cumulativeRatio: rule.cumulativeRatio,
          rule: `rank <= ceil(totalParticipants * ${rule.cumulativeRatio})`,
        })),
      },
      assignTier: (rank, totalParticipants) => {
        return this.assignTierFromCumulativeCutoffs(rank, totalParticipants);
      },
    };
  }

  private assignTierFromCumulativeCutoffs(
    rank: number,
    totalParticipants: number,
  ): FinalTier {
    for (const rule of FINAL_TIER_CUTOFF_RULES) {
      const cutoff = Math.ceil(totalParticipants * rule.cumulativeRatio);
      if (rank <= cutoff) {
        return rule.tier;
      }
    }

    return 'bronze';
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
