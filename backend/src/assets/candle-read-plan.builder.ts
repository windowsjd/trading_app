import { Inject, Injectable } from '@nestjs/common';
import { AssetType } from '../generated/prisma/client';
import { zonedDateTimeToUtc } from '../providers/kis/candles/kis-candle-time';
import type {
  AssetCandlesAsset,
  CandleInterval,
  ParsedAssetCandlesQuery,
} from './asset-candles.service';
import {
  CANDLE_SERVING_CONFIG,
  type CandleServingConfig,
} from './candle-serving.config';
import type { MarketCandleInterval } from './market-candles.repository';

export type CandleReadPlan = {
  assetId: string;
  assetType: AssetType;
  market: string;
  targetInterval: CandleInterval;
  sourceInterval: MarketCandleInterval | null;
  requestedRange: { from: Date; to: Date };
  sourceRange: { from: Date; to: Date };
  limit: number;
  explicitTo: boolean;
  latestRequest: boolean;
  requiresAggregation: boolean;
  managedByPersistence: boolean;
  outOfPolicyReason: string | null;
};

const AGGREGATED_INTERVALS = new Set<CandleInterval>([
  '15m',
  '30m',
  '1h',
  '4h',
]);
const SOURCE_PADDING_MS = 4 * 60 * 60_000;

@Injectable()
export class CandleReadPlanBuilder {
  constructor(
    @Inject(CANDLE_SERVING_CONFIG)
    private readonly config: CandleServingConfig,
  ) {}

  build(
    asset: AssetCandlesAsset,
    query: ParsedAssetCandlesQuery,
  ): CandleReadPlan {
    const requestedRange = this.resolveRequestedRange(asset, query);
    const requiresAggregation = AGGREGATED_INTERVALS.has(query.interval);
    const sourceInterval = this.resolveSourceInterval(query.interval);
    const sourceRange = {
      from: new Date(
        requestedRange.from.getTime() -
          (requiresAggregation ? SOURCE_PADDING_MS : 0),
      ),
      to: requestedRange.to,
    };
    const durationMs = sourceRange.to.getTime() - sourceRange.from.getTime();
    let outOfPolicyReason: string | null = null;
    if (sourceInterval === null) {
      outOfPolicyReason = 'interval_not_persisted';
    } else if (
      sourceInterval === '5m' &&
      durationMs > this.config.maxManagedFiveMinuteRangeMs
    ) {
      outOfPolicyReason = 'five_minute_range_exceeds_retention';
    } else if (
      sourceInterval !== '5m' &&
      durationMs > this.config.maxManagedPeriodRangeMs
    ) {
      outOfPolicyReason = 'period_range_exceeds_policy';
    }

    return {
      assetId: asset.id,
      assetType: asset.assetType,
      market: asset.market,
      targetInterval: query.interval,
      sourceInterval,
      requestedRange,
      sourceRange,
      limit: query.limit,
      explicitTo: query.explicitTo,
      latestRequest: !query.explicitTo,
      requiresAggregation,
      managedByPersistence: outOfPolicyReason === null,
      outOfPolicyReason,
    };
  }

  private resolveSourceInterval(
    interval: CandleInterval,
  ): MarketCandleInterval | null {
    if (interval === '1m') return null;
    if (interval === '1d' || interval === '1w') return interval;
    return '5m';
  }

  private resolveRequestedRange(
    asset: AssetCandlesAsset,
    query: ParsedAssetCandlesQuery,
  ): { from: Date; to: Date } {
    if (query.rangeStartAt && query.rangeEndAt) {
      return { from: query.rangeStartAt, to: query.rangeEndAt };
    }

    const timeZone =
      asset.assetType === AssetType.domestic_stock
        ? 'Asia/Seoul'
        : asset.assetType === AssetType.us_stock
          ? 'America/New_York'
          : 'UTC';
    const compactDate = query.requestedDate.replace(/-/gu, '');
    const from = zonedDateTimeToUtc(compactDate, '000000', timeZone);
    const inclusiveTo =
      query.toInstant ??
      zonedDateTimeToUtc(compactDate, query.toHHmmss, timeZone);
    if (!from || !inclusiveTo) {
      throw new Error(
        'Validated candle request could not be converted to UTC.',
      );
    }
    const to = new Date(inclusiveTo.getTime() + 1);
    return { from, to };
  }
}
