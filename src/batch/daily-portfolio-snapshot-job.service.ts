import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ParticipantStatus, SeasonStatus } from '../generated/prisma/client';
import { buildDailyPortfolioSnapshotData } from '../portfolio/daily-portfolio-snapshot-generation';
import {
  PortfolioValuationError,
  PortfolioValuationResult,
} from '../portfolio/portfolio-valuation.policy';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { PrismaService } from '../prisma/prisma.service';
import { BatchService } from './batch.service';
import {
  DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME,
  DailyPortfolioSnapshotJobErrorCode,
  DailyPortfolioSnapshotJobInput,
  DailyPortfolioSnapshotJobParticipantError,
  DailyPortfolioSnapshotJobRequestPayload,
  DailyPortfolioSnapshotJobResult,
  DailyPortfolioSnapshotJobRunResponse,
} from './daily-portfolio-snapshot-job.types';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class DailyPortfolioSnapshotJobService {
  constructor(
    private readonly batchService: BatchService,
    private readonly prisma: PrismaService,
    private readonly portfolioValuationService: PortfolioValuationService,
  ) {}

  async run(
    input: DailyPortfolioSnapshotJobInput,
  ): Promise<DailyPortfolioSnapshotJobRunResponse> {
    const dryRun = input.dryRun === true;
    const requestedBy = this.parseOptionalText(input.requestedBy);
    const idempotencyKey = this.resolveIdempotencyKey(input);
    const requestPayload: DailyPortfolioSnapshotJobRequestPayload = {
      seasonId: this.parseOptionalText(input.seasonId) ?? null,
      snapshotDate: this.parseOptionalText(input.snapshotDate) ?? null,
      dryRun,
      requestedBy: requestedBy ?? null,
      idempotencyKey,
    };

    return this.batchService.runJob<
      DailyPortfolioSnapshotJobRequestPayload,
      DailyPortfolioSnapshotJobResult
    >({
      jobName: DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME,
      idempotencyKey,
      dryRun,
      requestedBy,
      requestPayload,
      handler: ({ startedAt }) =>
        this.runDailySnapshotJob(input, dryRun, startedAt),
    });
  }

  private async runDailySnapshotJob(
    input: DailyPortfolioSnapshotJobInput,
    dryRun: boolean,
    capturedAt: Date,
  ): Promise<DailyPortfolioSnapshotJobResult> {
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
        participantStatus: ParticipantStatus.active,
      },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        userId: true,
      },
    });
    const result: DailyPortfolioSnapshotJobResult = {
      seasonId,
      snapshotDate: snapshotDateText,
      dryRun,
      participants: {
        total: participants.length,
        created: 0,
        wouldCreate: 0,
        existing: 0,
        failed: 0,
        skipped: 0,
      },
      createdSnapshotIds: [],
      errors: [],
    };

    for (const participant of participants) {
      const existing = await this.prisma.dailyPortfolioSnapshot.findUnique({
        where: {
          seasonParticipantId_snapshotDate: {
            seasonParticipantId: participant.id,
            snapshotDate,
          },
        },
        select: {
          id: true,
        },
      });

      if (existing) {
        result.participants.existing += 1;
        continue;
      }

      let valuation: PortfolioValuationResult;
      try {
        valuation =
          await this.portfolioValuationService.calculateSeasonParticipantValuation(
            participant.id,
            capturedAt,
          );
      } catch (error) {
        this.recordParticipantError(result, participant, error);
        continue;
      }

      if (dryRun) {
        result.participants.wouldCreate += 1;
        continue;
      }

      try {
        const snapshot = await this.prisma.dailyPortfolioSnapshot.create({
          data: buildDailyPortfolioSnapshotData({
            valuation,
            snapshotDate,
            capturedAt,
            dryRun: false,
          }),
          select: {
            id: true,
          },
        });

        result.participants.created += 1;
        result.createdSnapshotIds.push(snapshot.id);
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          result.participants.existing += 1;
          continue;
        }

        throw error;
      }
    }

    return result;
  }

  private assertSeasonStatusAllowed(status: SeasonStatus) {
    if (status === SeasonStatus.active || status === SeasonStatus.ended) {
      return;
    }

    this.throwJobError(
      HttpStatus.BAD_REQUEST,
      'SEASON_STATUS_NOT_ALLOWED',
      `Daily portfolio snapshot job does not support ${status} seasons.`,
    );
  }

  private recordParticipantError(
    result: DailyPortfolioSnapshotJobResult,
    participant: { id: string; userId: string },
    error: unknown,
  ) {
    result.participants.failed += 1;
    result.errors.push({
      seasonParticipantId: participant.id,
      userId: participant.userId,
      code: this.toParticipantErrorCode(error),
      message:
        error instanceof Error
          ? error.message
          : 'Portfolio valuation is unavailable.',
    });
  }

  private toParticipantErrorCode(
    error: unknown,
  ): DailyPortfolioSnapshotJobErrorCode {
    if (!(error instanceof PortfolioValuationError)) {
      return 'VALUATION_UNAVAILABLE';
    }

    if (
      error.code === 'FX_RATE_UNAVAILABLE' ||
      error.code === 'FX_RATE_STALE' ||
      error.code === 'ASSET_PRICE_UNAVAILABLE'
    ) {
      return error.code;
    }

    return 'VALUATION_UNAVAILABLE';
  }

  private resolveIdempotencyKey(input: DailyPortfolioSnapshotJobInput): string {
    const explicitKey = this.parseOptionalText(input.idempotencyKey);
    if (explicitKey) {
      return explicitKey;
    }

    return `${DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME}:${this.toBusinessKeySegment(
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

  private isUniqueConstraintError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }
}
