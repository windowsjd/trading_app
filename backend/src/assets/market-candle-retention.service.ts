import { Injectable } from '@nestjs/common';
import {
  DEFAULT_FOUR_HOUR_RETENTION_DAYS,
  MIN_FOUR_HOUR_RETENTION_DAYS,
  MarketCandleRetentionConfigError,
  readMarketCandleRetentionConfig,
  type MarketCandleRetentionConfig,
} from './market-candle-retention.config';
import { MarketCandlesRepository } from './market-candles.repository';
import type { FuturesMarketCandlesRepository } from './market-candle-futures.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

export class MarketCandleRetentionSafetyLimitError extends Error {
  constructor() {
    super('Market candle retention reached its maximum batch safety limit.');
    this.name = 'MarketCandleRetentionSafetyLimitError';
  }
}

export class MarketCandleRetentionLockLostError extends Error {
  constructor() {
    super('Market candle retention lock ownership was lost.');
    this.name = 'MarketCandleRetentionLockLostError';
  }
}

export type MarketCandleRetentionPruneResult = {
  cutoff: Date;
  retentionDays: number;
  deletedCount: number;
  batchCount: number;
};

/**
 * Top-level cutoff/retentionDays/deletedCount/batchCount describe the 5m
 * prune exactly as before. The long-range 4h history is pruned independently
 * afterwards with its own cutoff (180 days by default); 1d/1w rows are never
 * deleted by this job.
 */
export type MarketCandleRetentionResult = MarketCandleRetentionPruneResult & {
  fourHour: MarketCandleRetentionPruneResult;
  /** Present when the futures candle store is wired (application runtime). */
  futuresFourHour: MarketCandleRetentionPruneResult | null;
  startedAt: Date;
  finishedAt: Date;
};

@Injectable()
export class MarketCandleRetentionService {
  constructor(
    private readonly repository: MarketCandlesRepository,
    private readonly config: MarketCandleRetentionConfig = readMarketCandleRetentionConfig(),
    private readonly yieldToEventLoop: () => Promise<void> = () =>
      new Promise((resolve) => setImmediate(resolve)),
    private readonly futuresRepository?: Pick<
      FuturesMarketCandlesRepository,
      'deleteClosedBeforeBatch'
    >,
  ) {}

  async run(
    input: {
      now?: Date;
      retentionDays?: number;
      fourHourRetentionDays?: number;
      batchSize?: number;
      maxBatches?: number;
      isLockOwned?: () => boolean;
    } = {},
  ): Promise<MarketCandleRetentionResult> {
    const startedAt = input.now ?? new Date();
    this.requireDate(startedAt, 'now');
    const retentionDays = input.retentionDays ?? this.config.retentionDays;
    const fourHourRetentionDays =
      input.fourHourRetentionDays ??
      this.config.fourHourRetentionDays ??
      DEFAULT_FOUR_HOUR_RETENTION_DAYS;
    const batchSize = input.batchSize ?? this.config.batchSize;
    const maxBatches = input.maxBatches ?? this.config.maxBatches;
    this.validateRunOptions(retentionDays, batchSize, maxBatches);
    this.validateFourHourRetention(fourHourRetentionDays);

    const fiveMinute = await this.prune(
      new Date(startedAt.getTime() - retentionDays * DAY_MS),
      retentionDays,
      (cutoff) =>
        this.repository.deleteClosedBeforeBatch({
          cutoff,
          interval: '5m',
          limit: batchSize,
        }),
      batchSize,
      maxBatches,
      input.isLockOwned,
    );
    // Independent of the 5m window: the long-range 4h history keeps its own
    // 180-day cutoff and is never extended or shortened by the 5m policy.
    const fourHourCutoff = new Date(
      startedAt.getTime() - fourHourRetentionDays * DAY_MS,
    );
    const fourHour = await this.prune(
      fourHourCutoff,
      fourHourRetentionDays,
      (cutoff) =>
        this.repository.deleteClosedBeforeBatch({
          cutoff,
          interval: '4h',
          limit: batchSize,
        }),
      batchSize,
      maxBatches,
      input.isLockOwned,
    );
    const futuresRepository = this.futuresRepository;
    const futuresFourHour = futuresRepository
      ? await this.prune(
          fourHourCutoff,
          fourHourRetentionDays,
          (cutoff) =>
            futuresRepository.deleteClosedBeforeBatch({
              cutoff,
              interval: '4h',
              limit: batchSize,
            }),
          batchSize,
          maxBatches,
          input.isLockOwned,
        )
      : null;

    return {
      ...fiveMinute,
      fourHour,
      futuresFourHour,
      startedAt,
      finishedAt: new Date(),
    };
  }

  private async prune(
    cutoff: Date,
    retentionDays: number,
    deleteBatch: (cutoff: Date) => Promise<number>,
    batchSize: number,
    maxBatches: number,
    isLockOwned: (() => boolean) | undefined,
  ): Promise<MarketCandleRetentionPruneResult> {
    let deletedCount = 0;
    let batchCount = 0;

    while (batchCount < maxBatches) {
      if (isLockOwned && !isLockOwned()) {
        throw new MarketCandleRetentionLockLostError();
      }
      const deleted = await deleteBatch(cutoff);
      batchCount += 1;
      deletedCount += deleted;
      if (deleted < batchSize) {
        return { cutoff, retentionDays, deletedCount, batchCount };
      }
      await this.yieldToEventLoop();
    }

    throw new MarketCandleRetentionSafetyLimitError();
  }

  private validateFourHourRetention(days: number): void {
    if (!Number.isSafeInteger(days) || days < MIN_FOUR_HOUR_RETENTION_DAYS) {
      // @diagnosticSurface internal: Retention run guard; the Ops runner records a fixed failure for it.
      throw new MarketCandleRetentionConfigError(
        `4h retention must be an integer of at least ${MIN_FOUR_HOUR_RETENTION_DAYS} days.`,
      );
    }
  }

  private validateRunOptions(
    retentionDays: number,
    batchSize: number,
    maxBatches: number,
  ): void {
    const config = readMarketCandleRetentionConfig({
      MARKET_CANDLE_5M_RETENTION_DAYS: String(retentionDays),
      MARKET_CANDLE_RETENTION_BATCH_SIZE: String(batchSize),
    });
    if (
      !Number.isSafeInteger(maxBatches) ||
      maxBatches <= 0 ||
      maxBatches > this.config.maxBatches
    ) {
      throw new MarketCandleRetentionSafetyLimitError();
    }
    void config;
  }

  private requireDate(value: Date, name: string): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new MarketCandleRetentionConfigError(
        `${name} must be a valid Date.`,
      );
    }
  }
}
