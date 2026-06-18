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
  buildRankingRowsForSnapshots,
  RankingCalculatedRow,
} from '../ranking/ranking-calculation.policy';
import { BatchService } from './batch.service';
import {
  SEASON_SETTLEMENT_JOB_NAME,
  SeasonSettlementJobInput,
  SeasonSettlementJobRequestPayload,
  SeasonSettlementJobResult,
  SeasonSettlementJobRunResponse,
  SeasonSettlementJobTopRank,
} from './season-settlement-job.types';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TOP_RANKS_LIMIT = 10;
const FINAL_RANK_TYPE = SeasonRankingType.final;
const SETTLEMENT_PARTICIPANT_STATUSES: readonly ParticipantStatus[] = [
  ParticipantStatus.active,
  ParticipantStatus.finished,
  ParticipantStatus.rewarded,
];

@Injectable()
export class SeasonSettlementJobService {
  constructor(
    private readonly batchService: BatchService,
    private readonly prisma: PrismaService,
  ) {}

  async run(
    input: SeasonSettlementJobInput,
  ): Promise<SeasonSettlementJobRunResponse> {
    const dryRun = input.dryRun === true;
    const requestedBy = this.parseOptionalText(input.requestedBy);
    const idempotencyKey = this.resolveIdempotencyKey(input);
    const requestPayload: SeasonSettlementJobRequestPayload = {
      seasonId: this.parseOptionalText(input.seasonId) ?? null,
      settlementDate: this.parseOptionalText(input.settlementDate) ?? null,
      dryRun,
      requestedBy: requestedBy ?? null,
      idempotencyKey,
    };

    return this.batchService.runJob<
      SeasonSettlementJobRequestPayload,
      SeasonSettlementJobResult
    >({
      jobName: SEASON_SETTLEMENT_JOB_NAME,
      idempotencyKey,
      dryRun,
      requestedBy,
      requestPayload,
      handler: ({ startedAt }) =>
        this.runSeasonSettlementJob(input, dryRun, startedAt),
    });
  }

  private async runSeasonSettlementJob(
    input: SeasonSettlementJobInput,
    dryRun: boolean,
    capturedAt: Date,
  ): Promise<SeasonSettlementJobResult> {
    const seasonId = this.parseRequiredText(input.seasonId, 'seasonId');
    const { text: settlementDateText, date: settlementDate } =
      this.parseSettlementDate(input.settlementDate);
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

    if (season.status === SeasonStatus.upcoming) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'SEASON_STATUS_NOT_ALLOWED',
        'Season settlement job does not support upcoming seasons.',
      );
    }

    if (season.status === SeasonStatus.active) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'SEASON_STATUS_NOT_ALLOWED',
        'Season settlement job does not support active seasons.',
      );
    }

    const participants = await this.findEligibleParticipants(seasonId);
    const existingFinalRankings = await this.findExistingFinalRankingRows(
      this.prisma,
      seasonId,
      settlementDate,
    );
    const existingResult = this.resultFromExistingFinalRankings({
      seasonId,
      settlementDate: settlementDateText,
      dryRun,
      previousStatus: season.status,
      participantsTotal: participants.length,
      existingRows: existingFinalRankings,
    });

    if (season.status === SeasonStatus.settled) {
      existingResult.message =
        existingFinalRankings.length > 0
          ? 'Season is already settled; existing final rankings are returned without overwrite.'
          : 'Season is already settled, but no final ranking rows exist for this settlementDate.';

      return existingResult;
    }

    if (existingFinalRankings.length > 0) {
      if (dryRun) {
        existingResult.message =
          'Final rankings already exist; dry-run would only transition the ended season to settled.';

        return existingResult;
      }

      const writeResult = await this.settleExistingFinalRankingsAtomically({
        seasonId,
        settlementDate,
      });

      existingResult.season.updated = writeResult.seasonUpdated;
      existingResult.message =
        'Final rankings already exist; existing rows were not overwritten and the season status was settled.';

      return existingResult;
    }

    const snapshots = await this.findSettlementSnapshots(
      seasonId,
      settlementDate,
    );
    const result = this.createBaseResult({
      seasonId,
      settlementDate: settlementDateText,
      dryRun,
      previousStatus: season.status,
      participantsTotal: participants.length,
      snapshotted: snapshots.length,
      missingSnapshots: Math.max(participants.length - snapshots.length, 0),
    });

    if (snapshots.length === 0) {
      this.failWithResult(
        HttpStatus.BAD_REQUEST,
        'NO_FINAL_SNAPSHOTS_AVAILABLE',
        'No daily portfolio snapshots are available for settlementDate.',
        result,
      );
    }

    if (result.participants.missingSnapshots > 0) {
      this.failWithResult(
        HttpStatus.BAD_REQUEST,
        'MISSING_FINAL_SNAPSHOTS',
        'Some eligible participants do not have daily portfolio snapshots for settlementDate.',
        result,
      );
    }

    const [historicalSnapshots, executedOrders] = await Promise.all([
      this.findHistoricalSnapshots(seasonId, settlementDate),
      this.findExecutedOrdersThroughLatestSnapshot(
        seasonId,
        snapshots.map((snapshot) => snapshot.capturedAt),
      ),
    ]);
    const rows = buildRankingRowsForSnapshots({
      rankingSnapshots: snapshots.map((snapshot) => ({
        seasonParticipantId: snapshot.seasonParticipantId,
        userId: snapshot.seasonParticipant.userId,
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
    result.finalRankings.wouldCreate = rows.length;

    if (dryRun) {
      return result;
    }

    const writeResult = await this.createFinalRankingsAtomically({
      seasonId,
      settlementDate,
      capturedAt,
      rows,
    });

    if (writeResult.existingRows.length > 0) {
      result.finalRankings.wouldCreate = 0;
      result.finalRankings.existing = writeResult.existingRows.length;
      result.finalRankings.skipped = writeResult.existingRows.length;
      result.topRanks = writeResult.existingRows
        .slice(0, TOP_RANKS_LIMIT)
        .map((row) => this.formatExistingRankingRow(row));
      result.message =
        'Final rankings already exist; existing rows were not overwritten.';

      return result;
    }

    result.season.updated = writeResult.seasonUpdated;
    result.finalRankings.created = writeResult.createdFinalRankingIds.length;
    result.createdFinalRankingIds = writeResult.createdFinalRankingIds;
    result.message =
      'Season settlement completed. Reward handoff remains a separate gate.';

    return result;
  }

  private async findEligibleParticipants(seasonId: string) {
    return this.prisma.seasonParticipant.findMany({
      where: {
        seasonId,
        participantStatus: {
          in: [...SETTLEMENT_PARTICIPANT_STATUSES],
        },
      },
      orderBy: [{ userId: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        userId: true,
      },
    });
  }

  private async findSettlementSnapshots(
    seasonId: string,
    settlementDate: Date,
  ) {
    return this.prisma.dailyPortfolioSnapshot.findMany({
      where: {
        snapshotDate: settlementDate,
        seasonParticipant: {
          seasonId,
          participantStatus: {
            in: [...SETTLEMENT_PARTICIPANT_STATUSES],
          },
        },
      },
      select: {
        seasonParticipantId: true,
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
  }

  private async findExistingFinalRankingRows(
    client: PrismaService | Prisma.TransactionClient,
    seasonId: string,
    settlementDate: Date,
  ) {
    return client.seasonRanking.findMany({
      where: {
        seasonId,
        rankType: FINAL_RANK_TYPE,
        rankingDate: settlementDate,
      },
      orderBy: [{ rank: 'asc' }, { seasonParticipantId: 'asc' }],
      select: {
        id: true,
        seasonParticipantId: true,
        rank: true,
        totalAssetKrw: true,
        returnRate: true,
        maxDrawdown: true,
        totalFillCount: true,
        reachedReturnAt: true,
        seasonParticipant: {
          select: {
            userId: true,
          },
        },
      },
    });
  }

  private async settleExistingFinalRankingsAtomically(input: {
    seasonId: string;
    settlementDate: Date;
  }): Promise<{ seasonUpdated: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const existingRows = await this.findExistingFinalRankingRows(
        tx,
        input.seasonId,
        input.settlementDate,
      );

      if (existingRows.length === 0) {
        this.throwJobError(
          HttpStatus.CONFLICT,
          'FINAL_RANKINGS_NOT_FOUND',
          'Final rankings disappeared before settlement status update.',
        );
      }

      const updated = await tx.season.updateMany({
        where: {
          id: input.seasonId,
          status: SeasonStatus.ended,
        },
        data: {
          status: SeasonStatus.settled,
        },
      });

      return {
        seasonUpdated: updated.count === 1,
      };
    });
  }

  private async createFinalRankingsAtomically(input: {
    seasonId: string;
    settlementDate: Date;
    capturedAt: Date;
    rows: readonly RankingCalculatedRow[];
  }): Promise<{
    createdFinalRankingIds: string[];
    existingRows: Awaited<
      ReturnType<SeasonSettlementJobService['findExistingFinalRankingRows']>
    >;
    seasonUpdated: boolean;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const existingRows = await this.findExistingFinalRankingRows(
        tx,
        input.seasonId,
        input.settlementDate,
      );

      if (existingRows.length > 0) {
        return {
          createdFinalRankingIds: [],
          existingRows,
          seasonUpdated: false,
        };
      }

      const createdFinalRankingIds: string[] = [];
      for (const row of input.rows) {
        const created = await tx.seasonRanking.create({
          data: {
            seasonId: input.seasonId,
            seasonParticipantId: row.seasonParticipantId,
            rankType: FINAL_RANK_TYPE,
            rank: row.rank,
            totalAssetKrw: row.totalAssetKrw,
            returnRate: row.returnRate,
            maxDrawdown: row.maxDrawdown,
            totalFillCount: row.totalFillCount,
            reachedReturnAt: row.reachedReturnAt,
            rankingDate: input.settlementDate,
            capturedAt: input.capturedAt,
          },
          select: {
            id: true,
          },
        });
        createdFinalRankingIds.push(created.id);
      }

      const updated = await tx.season.updateMany({
        where: {
          id: input.seasonId,
          status: SeasonStatus.ended,
        },
        data: {
          status: SeasonStatus.settled,
        },
      });

      if (updated.count !== 1) {
        this.throwJobError(
          HttpStatus.CONFLICT,
          'SEASON_STATUS_CHANGED',
          'Season status changed before settlement could complete.',
        );
      }

      return {
        createdFinalRankingIds,
        existingRows: [],
        seasonUpdated: true,
      };
    });
  }

  private async findHistoricalSnapshots(
    seasonId: string,
    settlementDate: Date,
  ) {
    return this.prisma.dailyPortfolioSnapshot.findMany({
      where: {
        snapshotDate: {
          lte: settlementDate,
        },
        seasonParticipant: {
          seasonId,
          participantStatus: {
            in: [...SETTLEMENT_PARTICIPANT_STATUSES],
          },
        },
      },
      select: {
        seasonParticipantId: true,
        snapshotDate: true,
        totalAssetKrw: true,
        returnRate: true,
        capturedAt: true,
        createdAt: true,
      },
    });
  }

  private async findExecutedOrdersThroughLatestSnapshot(
    seasonId: string,
    capturedAtValues: readonly Date[],
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

    return this.prisma.order.findMany({
      where: {
        status: OrderStatus.executed,
        executedAt: {
          not: null,
          lte: latestCapturedAt,
        },
        seasonParticipant: {
          seasonId,
          participantStatus: {
            in: [...SETTLEMENT_PARTICIPANT_STATUSES],
          },
        },
      },
      select: {
        seasonParticipantId: true,
        executedAt: true,
      },
    });
  }

  private formatCalculatedRankingRow(
    row: RankingCalculatedRow,
  ): SeasonSettlementJobTopRank {
    return {
      ...row,
      reachedReturnAt: row.reachedReturnAt.toISOString(),
    };
  }

  private resultFromExistingFinalRankings(input: {
    seasonId: string;
    settlementDate: string;
    dryRun: boolean;
    previousStatus: SeasonStatus;
    participantsTotal: number;
    existingRows: Awaited<
      ReturnType<SeasonSettlementJobService['findExistingFinalRankingRows']>
    >;
  }): SeasonSettlementJobResult {
    const result = this.createBaseResult({
      seasonId: input.seasonId,
      settlementDate: input.settlementDate,
      dryRun: input.dryRun,
      previousStatus: input.previousStatus,
      participantsTotal: input.participantsTotal,
      snapshotted: input.existingRows.length,
      missingSnapshots: Math.max(
        input.participantsTotal - input.existingRows.length,
        0,
      ),
    });

    result.finalRankings.existing = input.existingRows.length;
    result.finalRankings.skipped = input.existingRows.length;
    result.topRanks = input.existingRows
      .slice(0, TOP_RANKS_LIMIT)
      .map((row) => this.formatExistingRankingRow(row));

    return result;
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
  }): SeasonSettlementJobTopRank {
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
    settlementDate: string;
    dryRun: boolean;
    previousStatus: SeasonStatus;
    participantsTotal: number;
    snapshotted: number;
    missingSnapshots: number;
  }): SeasonSettlementJobResult {
    return {
      seasonId: input.seasonId,
      settlementDate: input.settlementDate,
      dryRun: input.dryRun,
      season: {
        previousStatus: input.previousStatus,
        nextStatus: SeasonStatus.settled,
        updated: false,
      },
      participants: {
        total: input.participantsTotal,
        snapshotted: input.snapshotted,
        missingSnapshots: input.missingSnapshots,
      },
      finalRankings: {
        wouldCreate: 0,
        created: 0,
        existing: 0,
        skipped: 0,
      },
      createdFinalRankingIds: [],
      topRanks: [],
      errors: [],
    };
  }

  private resolveIdempotencyKey(input: SeasonSettlementJobInput): string {
    const explicitKey = this.parseOptionalText(input.idempotencyKey);
    if (explicitKey) {
      return explicitKey;
    }

    return `${SEASON_SETTLEMENT_JOB_NAME}:${this.toBusinessKeySegment(
      input.seasonId,
      'missing-season-id',
    )}:${this.toBusinessKeySegment(input.settlementDate, 'missing-settlement-date')}`;
  }

  private parseSettlementDate(value: string | undefined): {
    text: string;
    date: Date;
  } {
    const text = this.parseRequiredText(value, 'settlementDate');
    if (!DATE_ONLY_PATTERN.test(text)) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        'settlementDate must be YYYY-MM-DD.',
      );
    }

    const date = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || this.formatDateOnly(date) !== text) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        'settlementDate must be YYYY-MM-DD.',
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
    result: SeasonSettlementJobResult,
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
