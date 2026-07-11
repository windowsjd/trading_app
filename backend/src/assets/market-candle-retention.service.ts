import { Injectable } from '@nestjs/common';
import {
  MarketCandleRetentionConfigError,
  readMarketCandleRetentionConfig,
  type MarketCandleRetentionConfig,
} from './market-candle-retention.config';
import { MarketCandlesRepository } from './market-candles.repository';

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

export type MarketCandleRetentionResult = {
  cutoff: Date;
  retentionDays: number;
  deletedCount: number;
  batchCount: number;
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
  ) {}

  async run(
    input: {
      now?: Date;
      retentionDays?: number;
      batchSize?: number;
      maxBatches?: number;
      isLockOwned?: () => boolean;
    } = {},
  ): Promise<MarketCandleRetentionResult> {
    const startedAt = input.now ?? new Date();
    this.requireDate(startedAt, 'now');
    const retentionDays = input.retentionDays ?? this.config.retentionDays;
    const batchSize = input.batchSize ?? this.config.batchSize;
    const maxBatches = input.maxBatches ?? this.config.maxBatches;
    this.validateRunOptions(retentionDays, batchSize, maxBatches);
    const cutoff = new Date(startedAt.getTime() - retentionDays * DAY_MS);
    let deletedCount = 0;
    let batchCount = 0;

    while (batchCount < maxBatches) {
      if (input.isLockOwned && !input.isLockOwned()) {
        throw new MarketCandleRetentionLockLostError();
      }
      const deleted = await this.repository.deleteClosedBeforeBatch({
        cutoff,
        interval: '5m',
        limit: batchSize,
      });
      batchCount += 1;
      deletedCount += deleted;
      if (deleted < batchSize) {
        return {
          cutoff,
          retentionDays,
          deletedCount,
          batchCount,
          startedAt,
          finishedAt: new Date(),
        };
      }
      await this.yieldToEventLoop();
    }

    throw new MarketCandleRetentionSafetyLimitError();
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
