import { Injectable } from '@nestjs/common';
import {
  MarketCandleSyncMode,
  MarketCandleSyncStatus,
  Prisma,
  type MarketCandleSyncState,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { MarketCandleFeed } from './market-candle-sync.types';

const ERROR_MESSAGE_MAX_LENGTH = 500;

// Statuses a run can be resumed/taken over from. `running` is included
// because a crashed instance leaves its row as running; the caller must hold
// the asset/feed backfill lock before taking such a row over. `canceled` is
// included so a graceful shutdown leaves a resumable checkpoint, except runs
// superseded by a fresh run (errorCode SUPERSEDED).
const RESUMABLE_STATUSES: readonly MarketCandleSyncStatus[] = [
  MarketCandleSyncStatus.pending,
  MarketCandleSyncStatus.running,
  MarketCandleSyncStatus.failed,
  MarketCandleSyncStatus.canceled,
];

export class ActiveMarketCandleSyncExistsError extends Error {
  constructor(assetId: string, feed: string) {
    super(
      `An active market candle sync already exists for asset ${assetId} feed ${feed}.`,
    );
    this.name = 'ActiveMarketCandleSyncExistsError';
  }
}

export type MarketCandleSyncPageProgress = {
  cursorJson: Prisma.JsonObject | null;
  pagesFetched: number;
  providerRowsReceived: number;
  rowsAccepted: number;
  rowsRejected: number;
  rowsDuplicated: number;
  rowsWritten: number;
  lastSuccessfulPageAt: Date;
  // Accumulated half-open [coveredFrom, coveredTo) range the run has
  // confirmed so far (already merged with prior pages by the caller). Null
  // when nothing has been confirmed yet.
  coveredFrom: Date | null;
  coveredTo: Date | null;
};

export type MarketCandleSyncCompletionInput = {
  // True only when the provider cursor confirmed the whole target range.
  coverageComplete: boolean;
  completionReason: string;
  coveredFrom: Date | null;
  coveredTo: Date | null;
};

/**
 * Persistence for MarketCandleSyncState checkpoints.
 *
 * Guarded transitions keep the checkpoint trustworthy:
 * - at most one pending/running row per (asset, feed) — enforced by the
 *   partial unique index market_candle_sync_states_active_unique;
 * - page progress (cursor + counters) is only recorded while running, and
 *   callers persist candles BEFORE calling recordPageSuccess, so a stored
 *   cursor always points past durably written data;
 * - completed rows can never regress: markFailed/markCanceled/resumeRun all
 *   exclude completed from their guards.
 */
@Injectable()
export class MarketCandleSyncStateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createRunning(input: {
    assetId: string;
    feed: MarketCandleFeed;
    sourceProvider: string;
    mode: MarketCandleSyncMode;
    targetFrom: Date;
    targetTo: Date;
  }): Promise<MarketCandleSyncState> {
    try {
      return await this.prisma.marketCandleSyncState.create({
        data: {
          assetId: input.assetId,
          feed: input.feed,
          sourceProvider: input.sourceProvider,
          mode: input.mode,
          status: MarketCandleSyncStatus.running,
          targetFrom: input.targetFrom,
          targetTo: input.targetTo,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ActiveMarketCandleSyncExistsError(input.assetId, input.feed);
      }
      throw error;
    }
  }

  findResumable(
    assetId: string,
    feed: MarketCandleFeed,
  ): Promise<MarketCandleSyncState | null> {
    return this.prisma.marketCandleSyncState.findFirst({
      where: {
        assetId,
        feed,
        status: { in: [...RESUMABLE_STATUSES] },
        NOT: { errorCode: 'SUPERSEDED' },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  findLatest(
    assetId: string,
    feed: MarketCandleFeed,
  ): Promise<MarketCandleSyncState | null> {
    return this.prisma.marketCandleSyncState.findFirst({
      where: { assetId, feed },
      orderBy: { createdAt: 'desc' },
    });
  }

  findById(id: string): Promise<MarketCandleSyncState | null> {
    return this.prisma.marketCandleSyncState.findUnique({ where: { id } });
  }

  /**
   * Returns the newest checkpoint that overlaps a serving source range. The
   * serving loader uses the persisted target range and terminal status rather
   * than inferring completeness from candle min/max/count.
   */
  findLatestOverlapping(
    assetId: string,
    feed: MarketCandleFeed,
    from: Date,
    to: Date,
  ): Promise<MarketCandleSyncState | null> {
    return this.prisma.marketCandleSyncState.findFirst({
      where: {
        assetId,
        feed,
        targetFrom: { lt: to },
        targetTo: { gt: from },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Serving coverage evidence. A checkpoint only qualifies when the run
   * terminated normally AND its provider cursor confirmed the whole requested
   * range: status=completed, coverageComplete=true, and the persisted
   * [coveredFrom, coveredTo) range spans [from, to). Legacy completed rows
   * (created before coverage auditing) have coverageComplete=false and are
   * deliberately excluded until a re-sync writes an audited checkpoint.
   */
  findCompletedCovering(
    assetId: string,
    feed: MarketCandleFeed,
    from: Date,
    to: Date,
  ): Promise<MarketCandleSyncState | null> {
    return this.prisma.marketCandleSyncState.findFirst({
      where: {
        assetId,
        feed,
        status: MarketCandleSyncStatus.completed,
        coverageComplete: true,
        coveredFrom: { not: null, lte: from },
        coveredTo: { not: null, gte: to },
        completedAt: { not: null },
      },
      orderBy: { completedAt: 'desc' },
    });
  }

  /** Returns the refreshed row, or null when the run was not resumable. */
  async resumeRun(id: string): Promise<MarketCandleSyncState | null> {
    const updated = await this.prisma.marketCandleSyncState.updateMany({
      where: { id, status: { in: [...RESUMABLE_STATUSES] } },
      data: {
        status: MarketCandleSyncStatus.running,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
      },
    });
    if (updated.count !== 1) return null;
    return this.prisma.marketCandleSyncState.findUnique({ where: { id } });
  }

  /**
   * Records one durably written page: cursor + additive counters. The caller
   * MUST have persisted the page's candles first — a failed candle write
   * skips this call so the cursor never moves past unwritten data.
   */
  async recordPageSuccess(
    id: string,
    progress: MarketCandleSyncPageProgress,
  ): Promise<boolean> {
    const updated = await this.prisma.marketCandleSyncState.updateMany({
      where: { id, status: MarketCandleSyncStatus.running },
      data: {
        cursorJson:
          progress.cursorJson === null ? Prisma.DbNull : progress.cursorJson,
        pagesFetched: { increment: requireNonNegative(progress.pagesFetched) },
        providerRowsReceived: {
          increment: requireNonNegative(progress.providerRowsReceived),
        },
        rowsAccepted: { increment: requireNonNegative(progress.rowsAccepted) },
        rowsRejected: { increment: requireNonNegative(progress.rowsRejected) },
        rowsDuplicated: {
          increment: requireNonNegative(progress.rowsDuplicated),
        },
        rowsWritten: { increment: requireNonNegative(progress.rowsWritten) },
        lastSuccessfulPageAt: progress.lastSuccessfulPageAt,
        coveredFrom: progress.coveredFrom,
        coveredTo: progress.coveredTo,
      },
    });
    return updated.count === 1;
  }

  /**
   * Terminates a run as completed. Coverage is a REQUIRED input: `completed`
   * alone never implies the target range was fully confirmed. A
   * coverageComplete=true claim must span the run's target range; violating
   * that is a programmer error and is rejected before touching the row.
   */
  async markCompleted(
    id: string,
    completedAt: Date,
    coverage: MarketCandleSyncCompletionInput,
  ): Promise<boolean> {
    if (coverage.coverageComplete) {
      const row = await this.prisma.marketCandleSyncState.findUnique({
        where: { id },
        select: { targetFrom: true, targetTo: true },
      });
      if (
        row &&
        (coverage.coveredFrom === null ||
          coverage.coveredTo === null ||
          coverage.coveredFrom.getTime() > row.targetFrom.getTime())
      ) {
        throw new Error(
          'coverageComplete=true requires a covered range spanning the target range.',
        );
      }
    }
    const updated = await this.prisma.marketCandleSyncState.updateMany({
      where: { id, status: MarketCandleSyncStatus.running },
      data: {
        status: MarketCandleSyncStatus.completed,
        completedAt,
        coverageComplete: coverage.coverageComplete,
        completionReason: coverage.completionReason,
        coveredFrom: coverage.coveredFrom,
        coveredTo: coverage.coveredTo,
        errorCode: null,
        errorMessage: null,
      },
    });
    return updated.count === 1;
  }

  async markFailed(
    id: string,
    failure: { errorCode: string; errorMessage: string | null },
  ): Promise<boolean> {
    const updated = await this.prisma.marketCandleSyncState.updateMany({
      where: {
        id,
        status: {
          in: [MarketCandleSyncStatus.running, MarketCandleSyncStatus.pending],
        },
      },
      data: {
        status: MarketCandleSyncStatus.failed,
        errorCode: failure.errorCode,
        errorMessage: truncateMessage(failure.errorMessage),
      },
    });
    return updated.count === 1;
  }

  async markCanceled(
    id: string,
    reason: { errorCode: string; errorMessage: string | null },
  ): Promise<boolean> {
    const updated = await this.prisma.marketCandleSyncState.updateMany({
      where: {
        id,
        status: {
          in: [MarketCandleSyncStatus.running, MarketCandleSyncStatus.pending],
        },
      },
      data: {
        status: MarketCandleSyncStatus.canceled,
        errorCode: reason.errorCode,
        errorMessage: truncateMessage(reason.errorMessage),
      },
    });
    return updated.count === 1;
  }

  /**
   * Cancels stale pending/running rows for an asset/feed. Used when a caller
   * that holds the asset/feed backfill lock starts a fresh run (resume=false
   * or changed target range) while a crashed run's active row still exists.
   */
  async cancelActiveRuns(
    assetId: string,
    feed: MarketCandleFeed,
    reason: string,
  ): Promise<number> {
    const updated = await this.prisma.marketCandleSyncState.updateMany({
      where: {
        assetId,
        feed,
        status: {
          in: [MarketCandleSyncStatus.pending, MarketCandleSyncStatus.running],
        },
      },
      data: {
        status: MarketCandleSyncStatus.canceled,
        errorCode: 'SUPERSEDED',
        errorMessage: truncateMessage(reason),
      },
    });
    return updated.count;
  }
}

function requireNonNegative(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Sync progress counters must be non-negative integers.');
  }
  return value;
}

function truncateMessage(message: string | null): string | null {
  if (message === null) return null;
  const trimmed = message.trim();
  if (trimmed === '') return null;
  return trimmed.length > ERROR_MESSAGE_MAX_LENGTH
    ? `${trimmed.slice(0, ERROR_MESSAGE_MAX_LENGTH - 1)}…`
    : trimmed;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'P2002' || code === '23505') return true;
  const meta = (error as { meta?: Record<string, unknown> }).meta;
  if (!meta) return false;
  if (meta.code === '23505') return true;
  const cause = (
    meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined
  )?.cause;
  return (
    cause?.kind === 'UniqueConstraintViolation' ||
    cause?.originalCode === '23505'
  );
}
