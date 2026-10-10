import { Injectable } from '@nestjs/common';
import { KoscomCandleAdapter } from '../providers/koscom/koscom-candle.adapter';
import {
  KOSCOM_HISTORY_SOURCE,
  KOSCOM_MINUTE_SOURCE,
} from '../providers/koscom/koscom.config';
import { KisCandleNormalizerService } from '../providers/kis/candles/kis-candle-normalizer.service';
import { KisDomesticFiveMinuteBuilder } from '../providers/kis/candles/kis-domestic-five-minute.builder';
import { KisPeriodCandleNormalizerService } from '../providers/kis/candles/kis-period-candle-normalizer.service';
import { formatZonedCursor } from '../providers/kis/candles/kis-candle-time';
import type {
  AssetCandlesAsset,
  ParsedAssetCandlesQuery,
} from './asset-candles.service';
import { CandleReadPlanBuilder } from './candle-read-plan.builder';
import {
  CandleResponseBuilder,
  type PersistedResponseCandle,
} from './candle-response.builder';
import { MarketCandleAggregationService } from './market-candle-aggregation.service';

/** Bounded compatibility reads; normal charts use the existing durable serving path. */
@Injectable()
export class KoscomCandleReaderService {
  constructor(
    private readonly adapter: KoscomCandleAdapter,
    private readonly normalizer: KisCandleNormalizerService,
    private readonly builder: KisDomesticFiveMinuteBuilder,
    private readonly period: KisPeriodCandleNormalizerService,
    private readonly plans: CandleReadPlanBuilder,
    private readonly responses: CandleResponseBuilder,
    private readonly aggregation: MarketCandleAggregationService,
  ) {}

  async read(asset: AssetCandlesAsset, query: ParsedAssetCandlesQuery) {
    const plan = this.plans.build(asset, query);
    const from = plan.sourceRange.from,
      to = plan.sourceRange.to;
    const input = {
      asset: { id: asset.id, symbol: asset.symbol, marketCode: asset.market },
      from,
      to,
      now: query.clock,
      maxPages: 5,
      maxRows: 500,
      maxDurationMs: 15000,
    };
    let rows: PersistedResponseCandle[];
    let source: string;
    let requestedLimit = query.limit;
    if (query.interval === '1d' || query.interval === '1w') {
      source = KOSCOM_HISTORY_SOURCE;
      const maxPages = query.interval === '1w' ? 3 : 5;
      requestedLimit = Math.min(query.limit, maxPages * 100);
      const fromDate = formatZonedCursor(from, 'Asia/Seoul').date;
      let endDate = formatZonedCursor(
        new Date(Math.min(to.getTime() - 1, query.clock.getTime())),
        'Asia/Seoul',
      ).date;
      const raw: Awaited<
        ReturnType<KoscomCandleAdapter['fetchPeriodPage']>
      >['rows'] = [];
      const deadline = performance.now() + input.maxDurationMs;
      for (let page = 0; page < maxPages; page++) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        const fetched = await this.adapter.fetchPeriodPage({
          asset: input.asset,
          interval: query.interval,
          fromDate,
          endDate,
          timeoutMs: Math.min(5000, remaining),
        });
        raw.push(...fetched.rows);
        if (
          fetched.providerReturnedRows < 100 ||
          !fetched.oldestDate ||
          fetched.oldestDate <= fromDate ||
          raw.length >= requestedLimit
        )
          break;
        const d = fetched.oldestDate;
        const prev = new Date(
          `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`,
        );
        prev.setUTCDate(prev.getUTCDate() - 1);
        const next = prev.toISOString().slice(0, 10).replaceAll('-', '');
        if (next >= endDate) break;
        endDate = next;
      }
      rows = this.period.normalizeDomesticPeriodRows({
        rows: raw,
        interval: query.interval,
        from,
        to,
        now: query.clock,
      }).candles;
    } else {
      source = KOSCOM_MINUTE_SOURCE;
      const fetched = await this.adapter.fetchDomesticOneMinuteRows(input);
      const normalized = this.normalizer.normalizeDomesticOneMinuteRows({
        ...input,
        rows: fetched.rows,
      });
      if (query.interval === '1m') rows = normalized.rows;
      else {
        const built = this.builder.build({
          rows: normalized.rows,
          now: query.clock,
          completedMinutesOnly: true,
        });
        rows =
          query.interval === '5m'
            ? built.candles
            : this.aggregation
                .aggregateCandles({
                  assetType: asset.assetType,
                  interval: query.interval,
                  candles: built.candles,
                  from: plan.requestedRange.from,
                  to: plan.requestedRange.to,
                  now: query.clock,
                })
                .candles.filter((c) => c.complete || c.isCurrent);
      }
    }
    rows = rows
      .filter(
        (r) =>
          r.openTime >= plan.requestedRange.from &&
          r.openTime < plan.requestedRange.to,
      )
      .slice(-query.limit);
    return this.responses.buildPersisted(
      asset,
      { ...query, limit: requestedLimit },
      rows,
      [source],
    );
  }
}
