import { Injectable } from '@nestjs/common';
import { MarketCandlesRepository } from './market-candles.repository';
import { KisCandleNormalizerService } from '../providers/kis/candles/kis-candle-normalizer.service';
import { KisDomesticFiveMinuteBuilder } from '../providers/kis/candles/kis-domestic-five-minute.builder';
import { KisDomesticMinuteAdapter } from '../providers/kis/candles/kis-domestic-minute.adapter';
import { KisUsMinuteAdapter } from '../providers/kis/candles/kis-us-minute.adapter';
import {
  KIS_DOMESTIC_CANDLE_SOURCE,
  KIS_US_CANDLE_SOURCE,
  type CanonicalFiveMinuteCandle,
  type KisCandleFetchInput,
  type KisCandleStopReason,
} from '../providers/kis/candles/kis-candle.types';
import { AssetCandlesCacheService } from './asset-candles-cache.service';

export type KisFiveMinuteFetchResult = {
  provider: typeof KIS_DOMESTIC_CANDLE_SOURCE | typeof KIS_US_CANDLE_SOURCE;
  assetId: string;
  rangeFrom: Date;
  rangeTo: Date;
  pagesFetched: number;
  providerReturnedRows: number;
  acceptedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  candles: CanonicalFiveMinuteCandle[];
  complete: boolean;
  stopReason: KisCandleStopReason;
  oldestOpenTime: Date | null;
  latestOpenTime: Date | null;
  completeBuckets?: number;
  incompleteBuckets?: number;
  rejectedBuckets?: number;
};

export type KisFiveMinuteIngestionResult = Omit<
  KisFiveMinuteFetchResult,
  'candles'
> & {
  writtenRows: number;
};

@Injectable()
export class MarketCandleIngestionService {
  constructor(
    private readonly domesticAdapter: KisDomesticMinuteAdapter,
    private readonly usAdapter: KisUsMinuteAdapter,
    private readonly normalizer: KisCandleNormalizerService,
    private readonly domesticBuilder: KisDomesticFiveMinuteBuilder,
    private readonly repository: MarketCandlesRepository,
    private readonly cache: AssetCandlesCacheService,
  ) {}

  async fetchDomesticFiveMinuteCandles(
    input: KisCandleFetchInput & { now?: Date },
  ): Promise<KisFiveMinuteFetchResult> {
    const adapter =
      await this.domesticAdapter.fetchDomesticOneMinuteRows(input);
    const normalized = this.normalizer.normalizeDomesticOneMinuteRows({
      rows: adapter.rows,
      from: input.from,
      to: input.to,
      now: input.now,
    });
    const built = this.domesticBuilder.build({
      rows: normalized.rows,
      now: input.now,
    });
    return {
      provider: KIS_DOMESTIC_CANDLE_SOURCE,
      assetId: input.asset.id,
      rangeFrom: input.from,
      rangeTo: input.to,
      pagesFetched: adapter.pagesFetched,
      providerReturnedRows: adapter.providerReturnedRows,
      acceptedRows: normalized.acceptedRows,
      rejectedRows: normalized.rejectedRows,
      duplicateRows: adapter.duplicateRows + normalized.duplicateRows,
      candles: built.candles,
      complete:
        adapter.complete &&
        normalized.acceptedRows > 0 &&
        built.candles.length > 0 &&
        built.incompleteBuckets === 0,
      stopReason: adapter.stopReason,
      oldestOpenTime: built.candles[0]?.openTime ?? adapter.oldestOpenTime,
      latestOpenTime: built.candles.at(-1)?.openTime ?? adapter.latestOpenTime,
      completeBuckets: built.completeBuckets,
      incompleteBuckets: built.incompleteBuckets,
      rejectedBuckets: built.rejectedBuckets,
    };
  }

  async fetchUsFiveMinuteCandles(
    input: KisCandleFetchInput & { now?: Date },
  ): Promise<KisFiveMinuteFetchResult> {
    const adapter = await this.usAdapter.fetchUsFiveMinuteRows(input);
    const normalized = this.normalizer.normalizeUsFiveMinuteRows({
      rows: adapter.rows,
      from: input.from,
      to: input.to,
      now: input.now,
    });
    return {
      provider: KIS_US_CANDLE_SOURCE,
      assetId: input.asset.id,
      rangeFrom: input.from,
      rangeTo: input.to,
      pagesFetched: adapter.pagesFetched,
      providerReturnedRows: adapter.providerReturnedRows,
      acceptedRows: normalized.acceptedRows,
      rejectedRows: normalized.rejectedRows,
      duplicateRows: adapter.duplicateRows + normalized.duplicateRows,
      candles: normalized.candles,
      complete: adapter.complete && normalized.acceptedRows > 0,
      stopReason: adapter.stopReason,
      oldestOpenTime: normalized.candles[0]?.openTime ?? adapter.oldestOpenTime,
      latestOpenTime:
        normalized.candles.at(-1)?.openTime ?? adapter.latestOpenTime,
    };
  }

  async ingestDomesticFiveMinuteCandles(
    input: KisCandleFetchInput & { now?: Date },
  ): Promise<KisFiveMinuteIngestionResult> {
    return this.write(await this.fetchDomesticFiveMinuteCandles(input));
  }

  async ingestUsFiveMinuteCandles(
    input: KisCandleFetchInput & { now?: Date },
  ): Promise<KisFiveMinuteIngestionResult> {
    return this.write(await this.fetchUsFiveMinuteCandles(input));
  }

  private async write(
    result: KisFiveMinuteFetchResult,
  ): Promise<KisFiveMinuteIngestionResult> {
    if (result.candles.length === 0) {
      const { candles: _candles, ...metadata } = result;
      return { ...metadata, writtenRows: 0 };
    }
    const write = await this.repository.upsertMany(
      result.candles.map((candle) => ({
        assetId: result.assetId,
        interval: '5m' as const,
        openTime: candle.openTime,
        closeTime: candle.closeTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        amount: candle.amount,
        isClosed: candle.isClosed,
        sourceProvider: result.provider,
        sourceUpdatedAt: candle.sourceUpdatedAt,
      })),
    );
    if (write.writtenCount > 0) {
      await this.cache.invalidateAsset(result.assetId);
    }
    const { candles: _candles, ...metadata } = result;
    return { ...metadata, writtenRows: write.writtenCount };
  }
}
