import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  ParticipantStatus,
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
  SEASON_RANKING_JOB_NAME,
  SeasonRankingJobInput,
  SeasonRankingJobRequestPayload,
  SeasonRankingJobResult,
  SeasonRankingJobRunResponse,
  SeasonRankingJobTopRank,
} from './season-ranking-job.types';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TOP_RANKS_LIMIT = 10;
const RANK_TYPE = SeasonRankingType.daily;
const RANKABLE_PARTICIPANT_STATUSES: readonly ParticipantStatus[] = [
  ParticipantStatus.active,
  ParticipantStatus.finished,
  ParticipantStatus.rewarded,
];

type SnapshotRankingInput = {
  seasonParticipantId: string;
  userId: string;
  totalAssetKrw: Prisma.Decimal;
  returnRate: Prisma.Decimal;
};

@Injectable()
export class SeasonRankingJobService {
  constructor(
    private readonly batchService: BatchService,
    private readonly prisma: PrismaService,
  ) {}

  async run(
    input: SeasonRankingJobInput,
  ): Promise<SeasonRankingJobRunResponse> {
    const dryRun = input.dryRun === true;
    const requestedBy = this.parseOptionalText(input.requestedBy);
    const idempotencyKey = this.resolveIdempotencyKey(input);
    const requestPayload: SeasonRankingJobRequestPayload = {
      seasonId: this.parseOptionalText(input.seasonId) ?? null,
      snapshotDate: this.parseOptionalText(input.snapshotDate) ?? null,
      dryRun,
      requestedBy: requestedBy ?? null,
      idempotencyKey,
    };

    return this.batchService.runJob<
      SeasonRankingJobRequestPayload,
      SeasonRankingJobResult
    >({
      jobName: SEASON_RANKING_JOB_NAME,
      idempotencyKey,
      dryRun,
      requestedBy,
      requestPayload,
      handler: ({ startedAt }) =>
        this.runSeasonRankingJob(input, dryRun, startedAt),
    });
  }

  private async runSeasonRankingJob(
    input: SeasonRankingJobInput,
    dryRun: boolean,
    capturedAt: Date,
  ): Promise<SeasonRankingJobResult> {
    const seasonId = this.parseRequiredText(input.seasonId, 'seasonId');
    const { text: snapshotDateText, date: snapshotDate } =
      this.parseSnapshotDate(input.snapshotDate);
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

    const participants = await this.prisma.seasonParticipant.findMany({
      where: {
        seasonId,
        participantStatus: {
          in: [...RANKABLE_PARTICIPANT_STATUSES],
        },
      },
      orderBy: [{ userId: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        userId: true,
      },
    });
    const snapshots = await this.prisma.dailyPortfolioSnapshot.findMany({
      where: {
        snapshotDate,
        seasonParticipant: {
          seasonId,
          participantStatus: {
            in: [...RANKABLE_PARTICIPANT_STATUSES],
          },
        },
      },
      select: {
        seasonParticipantId: true,
        totalAssetKrw: true,
        returnRate: true,
        seasonParticipant: {
          select: {
            userId: true,
          },
        },
      },
    });
    const result = this.createBaseResult({
      seasonId,
      snapshotDate: snapshotDateText,
      dryRun,
      snapshotted: snapshots.length,
      missingSnapshots: Math.max(participants.length - snapshots.length, 0),
    });
    const existingRows = await this.findExistingRankingRows(
      seasonId,
      snapshotDate,
    );

    if (existingRows.length > 0) {
      result.rankings.existing = existingRows.length;
      result.rankings.skipped = existingRows.length;
      result.topRanks = existingRows.slice(0, TOP_RANKS_LIMIT).map((row) => ({
        seasonParticipantId: row.seasonParticipantId,
        userId: row.seasonParticipant.userId,
        rank: row.rank,
        totalAssetKrw: formatMoneyScale8(row.totalAssetKrw),
        returnRate: formatDecimalScale(row.returnRate, returnRateScale),
      }));
      result.message =
        'Season rankings already exist for this season and snapshotDate; overwrite is skipped.';

      return result;
    }

    const rows = this.buildRankingRows(
      snapshots.map((snapshot) => ({
        seasonParticipantId: snapshot.seasonParticipantId,
        userId: snapshot.seasonParticipant.userId,
        totalAssetKrw: snapshot.totalAssetKrw,
        returnRate: snapshot.returnRate,
      })),
    );
    result.topRanks = rows.slice(0, TOP_RANKS_LIMIT);

    if (rows.length === 0) {
      result.reason = 'NO_SNAPSHOTS_AVAILABLE';
      result.message =
        'No daily portfolio snapshots are available for this season and snapshotDate.';

      return result;
    }

    result.rankings.wouldCreate = rows.length;

    if (dryRun) {
      return result;
    }

    const writeResult = await this.createRankingRowsAtomically({
      seasonId,
      rankingDate: snapshotDate,
      capturedAt,
      rows,
    });

    if (writeResult.existingRows.length > 0) {
      result.rankings.wouldCreate = 0;
      result.rankings.existing = writeResult.existingRows.length;
      result.rankings.skipped = writeResult.existingRows.length;
      result.topRanks = writeResult.existingRows
        .slice(0, TOP_RANKS_LIMIT)
        .map((row) => ({
          seasonParticipantId: row.seasonParticipantId,
          userId: row.seasonParticipant.userId,
          rank: row.rank,
          totalAssetKrw: formatMoneyScale8(row.totalAssetKrw),
          returnRate: formatDecimalScale(row.returnRate, returnRateScale),
        }));
      result.message =
        'Season rankings already exist for this season and snapshotDate; overwrite is skipped.';

      return result;
    }

    result.rankings.created = writeResult.createdRankingIds.length;
    result.createdRankingIds = writeResult.createdRankingIds;

    return result;
  }

  private async createRankingRowsAtomically(input: {
    seasonId: string;
    rankingDate: Date;
    capturedAt: Date;
    rows: readonly SeasonRankingJobTopRank[];
  }): Promise<{
    createdRankingIds: string[];
    existingRows: Awaited<
      ReturnType<SeasonRankingJobService['findExistingRankingRows']>
    >;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const existingRows = await tx.seasonRanking.findMany({
        where: {
          seasonId: input.seasonId,
          rankType: RANK_TYPE,
          rankingDate: input.rankingDate,
        },
        orderBy: [{ rank: 'asc' }, { seasonParticipantId: 'asc' }],
        select: {
          id: true,
          seasonParticipantId: true,
          rank: true,
          totalAssetKrw: true,
          returnRate: true,
          seasonParticipant: {
            select: {
              userId: true,
            },
          },
        },
      });

      if (existingRows.length > 0) {
        return {
          createdRankingIds: [],
          existingRows,
        };
      }

      const createdRankingIds: string[] = [];
      for (const row of input.rows) {
        const created = await tx.seasonRanking.create({
          data: {
            seasonId: input.seasonId,
            seasonParticipantId: row.seasonParticipantId,
            rankType: RANK_TYPE,
            rank: row.rank,
            totalAssetKrw: row.totalAssetKrw,
            returnRate: row.returnRate,
            rankingDate: input.rankingDate,
            capturedAt: input.capturedAt,
          },
          select: {
            id: true,
          },
        });
        createdRankingIds.push(created.id);
      }

      return {
        createdRankingIds,
        existingRows: [],
      };
    });
  }

  private async findExistingRankingRows(seasonId: string, rankingDate: Date) {
    return this.prisma.seasonRanking.findMany({
      where: {
        seasonId,
        rankType: RANK_TYPE,
        rankingDate,
      },
      orderBy: [{ rank: 'asc' }, { seasonParticipantId: 'asc' }],
      select: {
        id: true,
        seasonParticipantId: true,
        rank: true,
        totalAssetKrw: true,
        returnRate: true,
        seasonParticipant: {
          select: {
            userId: true,
          },
        },
      },
    });
  }

  private buildRankingRows(
    snapshots: readonly SnapshotRankingInput[],
  ): SeasonRankingJobTopRank[] {
    return snapshots
      .toSorted((left, right) => {
        const totalAssetDiff = right.totalAssetKrw.cmp(left.totalAssetKrw);
        if (totalAssetDiff !== 0) {
          return totalAssetDiff;
        }

        return (
          left.userId.localeCompare(right.userId) ||
          left.seasonParticipantId.localeCompare(right.seasonParticipantId)
        );
      })
      .map((snapshot, index) => ({
        seasonParticipantId: snapshot.seasonParticipantId,
        userId: snapshot.userId,
        rank: index + 1,
        totalAssetKrw: formatMoneyScale8(snapshot.totalAssetKrw),
        returnRate: formatDecimalScale(snapshot.returnRate, returnRateScale),
      }));
  }

  private createBaseResult(input: {
    seasonId: string;
    snapshotDate: string;
    dryRun: boolean;
    snapshotted: number;
    missingSnapshots: number;
  }): SeasonRankingJobResult {
    return {
      seasonId: input.seasonId,
      snapshotDate: input.snapshotDate,
      dryRun: input.dryRun,
      participants: {
        snapshotted: input.snapshotted,
        missingSnapshots: input.missingSnapshots,
      },
      rankings: {
        wouldCreate: 0,
        created: 0,
        existing: 0,
        skipped: 0,
      },
      createdRankingIds: [],
      topRanks: [],
      errors: [],
    };
  }

  private assertSeasonStatusAllowed(status: SeasonStatus) {
    if (status === SeasonStatus.active || status === SeasonStatus.ended) {
      return;
    }

    this.throwJobError(
      HttpStatus.BAD_REQUEST,
      'SEASON_STATUS_NOT_ALLOWED',
      `Season ranking job does not support ${status} seasons.`,
    );
  }

  private resolveIdempotencyKey(input: SeasonRankingJobInput): string {
    const explicitKey = this.parseOptionalText(input.idempotencyKey);
    if (explicitKey) {
      return explicitKey;
    }

    return `${SEASON_RANKING_JOB_NAME}:${this.toBusinessKeySegment(
      input.seasonId,
      'missing-season-id',
    )}:${this.toBusinessKeySegment(input.snapshotDate, 'missing-snapshot-date')}`;
  }

  private parseSnapshotDate(value: string | undefined): {
    text: string;
    date: Date;
  } {
    const text = this.parseRequiredText(value, 'snapshotDate');
    if (!DATE_ONLY_PATTERN.test(text)) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        'snapshotDate must be YYYY-MM-DD.',
      );
    }

    const date = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || this.formatDateOnly(date) !== text) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        'snapshotDate must be YYYY-MM-DD.',
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
