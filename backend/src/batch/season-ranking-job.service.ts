import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  ParticipantStatus,
  Prisma,
  OrderStatus,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import {
  formatDecimalScale,
  formatMoneyScale8,
  returnRateScale,
} from '../fx/fx-decimal-policy';
import { PrismaService } from '../prisma/prisma.service';
import {
  requireSeasonSnapshotParticipantId,
  seasonSnapshotWhere,
} from '../portfolio/season-snapshot-scope';
import {
  buildRankingRowsForSnapshots,
  RankingCalculatedRow,
} from '../ranking/ranking-calculation.policy';
import {
  assertRankingSourceOrderScopes,
  assertRankingSourceSnapshotScopes,
  buildRankingParticipantScopes,
  RANKING_PARTICIPANT_SCOPE_SELECT,
} from '../ranking/ranking-source-scope';
import {
  assertSeasonRankingScopes,
  resolveSeasonRankingAccountScopes,
  SEASON_RANKING_SCOPE_SELECT,
} from '../ranking/season-ranking-scope';
import { lockSeasonForWriteOrThrow } from '../ranking/season-write-lock';
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
      select: RANKING_PARTICIPANT_SCOPE_SELECT,
    });
    // The verified participant → season account map every source row below is
    // measured against (작업 8 §9.4). One query, no per-row lookup.
    const participantScopes = buildRankingParticipantScopes(
      seasonId,
      participants,
    );

    const snapshots = await this.prisma.dailyPortfolioSnapshot.findMany({
      where: {
        snapshotDate,
        ...seasonSnapshotWhere,
        seasonParticipant: {
          seasonId,
          participantStatus: {
            in: [...RANKABLE_PARTICIPANT_STATUSES],
          },
        },
      },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
        cumulativeExternalFundingKrw: true,
        investmentPnlKrw: true,
        timeWeightedReturnFactor: true,
        snapshotDate: true,
        totalAssetKrw: true,
        returnRate: true,
        capturedAt: true,
        createdAt: true,
        seasonParticipant: {
          select: {
            userId: true,
          },
        },
      },
    });
    assertRankingSourceSnapshotScopes({
      kind: 'daily portfolio snapshot',
      rows: snapshots,
      participantScopes,
    });

    const result = this.createBaseResult({
      seasonId,
      snapshotDate: snapshotDateText,
      dryRun,
      snapshotted: snapshots.length,
      missingSnapshots: Math.max(participants.length - snapshots.length, 0),
    });
    const existingRows = await this.findExistingRankingRows(
      snapshotDate,
      seasonId,
    );

    if (existingRows.length > 0) {
      result.rankings.existing = existingRows.length;
      result.rankings.skipped = existingRows.length;
      result.topRanks = existingRows
        .slice(0, TOP_RANKS_LIMIT)
        .map((row) => this.formatExistingRankingRow(row));
      result.message =
        'Season rankings already exist for this season and snapshotDate; overwrite is skipped.';

      return result;
    }

    if (snapshots.length === 0) {
      result.reason = 'NO_SNAPSHOTS_AVAILABLE';
      result.message =
        'No daily portfolio snapshots are available for this season and snapshotDate.';

      return result;
    }

    const [historicalSnapshots, executedOrders] = await Promise.all([
      this.findHistoricalSnapshots(seasonId, snapshotDate, participantScopes),
      this.findExecutedOrdersThroughLatestSnapshot(
        seasonId,
        snapshots.map((snapshot) => snapshot.capturedAt),
        participantScopes,
      ),
    ]);
    const rows = buildRankingRowsForSnapshots({
      rankingSnapshots: snapshots.map((snapshot) => ({
        // Season-only by query; narrowed here now that the column is nullable.
        seasonParticipantId: requireSeasonSnapshotParticipantId(
          snapshot.seasonParticipantId,
        ),
        userId: snapshot.seasonParticipant?.userId ?? '',
        snapshotDate: snapshot.snapshotDate,
        totalAssetKrw: snapshot.totalAssetKrw,
        returnRate: snapshot.returnRate,
        capturedAt: snapshot.capturedAt,
        createdAt: snapshot.createdAt,
      })),
      historicalSnapshots,
      executedOrders,
    });
    result.topRanks = rows
      .slice(0, TOP_RANKS_LIMIT)
      .map((row) => this.formatCalculatedRankingRow(row));

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
        .map((row) => this.formatExistingRankingRow(row));
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
    rows: readonly RankingCalculatedRow[];
  }): Promise<{
    createdRankingIds: string[];
    existingRows: Awaited<
      ReturnType<SeasonRankingJobService['findExistingRankingRows']>
    >;
  }> {
    return this.prisma.$transaction(async (tx) => {
      // SERIALIZATION POINT (작업 8 §13.2). The status check before the
      // transaction is a read; settlement may have closed the season since.
      const season = await lockSeasonForWriteOrThrow(tx, input.seasonId);
      if (season.status === SeasonStatus.settled) {
        // A settled season's results are final. Adding daily rows now would
        // reopen a leaderboard that settlement already closed.
        this.throwJobError(
          HttpStatus.CONFLICT,
          'SEASON_ALREADY_SETTLED',
          'Season was settled before this ranking write could commit; settled seasons never receive new daily rankings.',
        );
      }
      this.assertSeasonStatusAllowed(season.status);

      const existingRows = await this.findExistingRankingRows(
        input.rankingDate,
        input.seasonId,
        tx,
      );

      if (existingRows.length > 0) {
        // Existing rows keep the current immutable/skip contract — but they are
        // still verified, because reporting a damaged set as "already exists"
        // would present it as a healthy result (작업 8 §11).
        assertSeasonRankingScopes(existingRows);
        return {
          createdRankingIds: [],
          existingRows,
        };
      }

      const scopes = await resolveSeasonRankingAccountScopes(tx, {
        seasonId: input.seasonId,
        seasonParticipantIds: input.rows.map((row) => row.seasonParticipantId),
      });

      const createdRankingIds: string[] = [];
      for (const row of input.rows) {
        const created = await tx.seasonRanking.create({
          data: {
            seasonId: input.seasonId,
            seasonParticipantId: row.seasonParticipantId,
            tradingAccountId: scopes.get(row.seasonParticipantId)!
              .tradingAccountId,
            rankType: RANK_TYPE,
            rank: row.rank,
            totalAssetKrw: row.totalAssetKrw,
            returnRate: row.returnRate,
            maxDrawdown: row.maxDrawdown,
            totalFillCount: row.totalFillCount,
            reachedReturnAt: row.reachedReturnAt,
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

  private async findExistingRankingRows(
    rankingDate: Date,
    seasonId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const rows = await client.seasonRanking.findMany({
      where: {
        seasonId,
        rankType: RANK_TYPE,
        rankingDate,
      },
      orderBy: [{ rank: 'asc' }, { seasonParticipantId: 'asc' }],
      select: {
        ...SEASON_RANKING_SCOPE_SELECT,
        id: true,
        rank: true,
        totalAssetKrw: true,
        returnRate: true,
        maxDrawdown: true,
        totalFillCount: true,
        reachedReturnAt: true,
        seasonParticipant: {
          select: {
            ...SEASON_RANKING_SCOPE_SELECT.seasonParticipant.select,
            userId: true,
          },
        },
      },
    });

    assertSeasonRankingScopes(rows);

    return rows;
  }

  /**
   * Max-drawdown history. Scope-checked before use: dropping a damaged low
   * point would LOWER that participant's max drawdown, which is tie-break #2
   * (작업 8 §9.1).
   */
  private async findHistoricalSnapshots(
    seasonId: string,
    rankingDate: Date,
    participantScopes: ReadonlyMap<string, string>,
  ) {
    const rows = await this.prisma.dailyPortfolioSnapshot.findMany({
      where: {
        snapshotDate: {
          lte: rankingDate,
        },
        ...seasonSnapshotWhere,
        seasonParticipant: {
          seasonId,
          participantStatus: {
            in: [...RANKABLE_PARTICIPANT_STATUSES],
          },
        },
      },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
        cumulativeExternalFundingKrw: true,
        investmentPnlKrw: true,
        timeWeightedReturnFactor: true,
        snapshotDate: true,
        totalAssetKrw: true,
        returnRate: true,
        capturedAt: true,
        createdAt: true,
      },
    });

    assertRankingSourceSnapshotScopes({
      kind: 'daily portfolio snapshot',
      rows,
      participantScopes,
    });

    // Season-only by query (seasonSnapshotWhere); narrowed here because the
    // column is nullable for general-mode rows.
    return rows.map((row) => ({
      ...row,
      seasonParticipantId: requireSeasonSnapshotParticipantId(
        row.seasonParticipantId,
      ),
    }));
  }

  /**
   * totalFillCount source. Scope-checked before counting: dropping a damaged
   * order would LOWER a fill count, which is tie-break #3 (작업 8 §9.3).
   */
  private async findExecutedOrdersThroughLatestSnapshot(
    seasonId: string,
    capturedAtValues: readonly Date[],
    participantScopes: ReadonlyMap<string, string>,
  ) {
    const latestCapturedAt = capturedAtValues.reduce<Date | null>(
      (latest, capturedAt) =>
        latest === null || capturedAt.getTime() > latest.getTime()
          ? capturedAt
          : latest,
      null,
    );

    if (!latestCapturedAt) {
      return [];
    }

    const rows = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.executed,
        executedAt: {
          not: null,
          lte: latestCapturedAt,
        },
        seasonParticipant: {
          seasonId,
          participantStatus: {
            in: [...RANKABLE_PARTICIPANT_STATUSES],
          },
        },
      },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
        executedAt: true,
      },
    });

    assertRankingSourceOrderScopes({ rows, participantScopes });

    return rows.map((row) => ({
      ...row,
      seasonParticipantId: requireSeasonSnapshotParticipantId(
        row.seasonParticipantId,
      ),
    }));
  }

  private formatCalculatedRankingRow(
    row: RankingCalculatedRow,
  ): SeasonRankingJobTopRank {
    return {
      ...row,
      reachedReturnAt: row.reachedReturnAt.toISOString(),
    };
  }

  private formatExistingRankingRow(input: {
    seasonParticipantId: string;
    rank: number;
    totalAssetKrw: Prisma.Decimal;
    returnRate: Prisma.Decimal;
    maxDrawdown: Prisma.Decimal;
    totalFillCount: number;
    reachedReturnAt: Date | null;
    seasonParticipant: {
      userId: string;
    };
  }): SeasonRankingJobTopRank {
    return {
      seasonParticipantId: input.seasonParticipantId,
      userId: input.seasonParticipant.userId,
      rank: input.rank,
      totalAssetKrw: formatMoneyScale8(input.totalAssetKrw),
      returnRate: formatDecimalScale(input.returnRate, returnRateScale),
      maxDrawdown: formatDecimalScale(input.maxDrawdown, returnRateScale),
      totalFillCount: input.totalFillCount,
      reachedReturnAt: input.reachedReturnAt?.toISOString() ?? null,
    };
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
