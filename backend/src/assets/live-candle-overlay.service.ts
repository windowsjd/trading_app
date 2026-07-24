import { Injectable } from '@nestjs/common';
import type { MarketCandle } from '../generated/prisma/client';
import type {
  AssetCandlesResponse,
  ParsedAssetCandlesQuery,
} from './asset-candles.service';
import { MarketCandleAggregationService } from './market-candle-aggregation.service';
import { MarketCandlesRepository } from './market-candles.repository';
import { LiveCandleStoreService } from './live-candle-store.service';
import type {
  AssetCandleSnapshotEvent,
  LiveCandleInterval,
  LiveFiveMinuteCandleState,
} from './live-candle.types';

const SOURCE_LOOKBACK_MS = 4 * 60 * 60_000;

@Injectable()
export class LiveCandleOverlayService {
  constructor(
    private readonly store: LiveCandleStoreService,
    private readonly repository: MarketCandlesRepository,
    private readonly aggregation: MarketCandleAggregationService,
  ) {}

  async buildCurrentSnapshots(
    state: LiveFiveMinuteCandleState,
  ): Promise<Omit<AssetCandleSnapshotEvent, 'sequence'>[]> {
    if (state.volume === null) return [];
    const openTime = new Date(state.openTime);
    const closeTime = new Date(state.closeTime);
    const stored = await this.repository.findRange({
      assetId: state.assetId,
      interval: '5m',
      from: new Date(openTime.getTime() - SOURCE_LOOKBACK_MS),
      to: closeTime,
    });
    const rows = mergeLiveFiveMinute(stored, state);
    const closedCurrent = stored.find(
      (row) => row.isClosed && row.openTime.getTime() === openTime.getTime(),
    );
    const fiveMinute = closedCurrent
      ? this.eventFromRow(state, '5m', closedCurrent)
      : this.eventFromState(state);
    const events: Omit<AssetCandleSnapshotEvent, 'sequence'>[] = [fiveMinute];

    for (const interval of ['15m', '30m', '1h', '4h'] as const) {
      const result = this.aggregation.aggregateCandles({
        assetType: state.assetType,
        interval,
        candles: rows,
        from: new Date(openTime.getTime() - SOURCE_LOOKBACK_MS),
        to: closeTime,
        now: new Date(Math.max(Date.now(), openTime.getTime())),
      });
      const candle = result.candles.find(
        (candidate) =>
          candidate.openTime.getTime() <= openTime.getTime() &&
          candidate.closeTime.getTime() > openTime.getTime(),
      );
      if (!candle) continue;
      events.push({
        type: 'asset_candle',
        assetId: state.assetId,
        interval,
        candle: {
          time: candle.openTime.toISOString(),
          openTime: candle.openTime.toISOString(),
          closeTime: candle.closeTime.toISOString(),
          open: candle.open.toFixed(8),
          high: candle.high.toFixed(8),
          low: candle.low.toFixed(8),
          close: candle.close.toFixed(8),
          volume: candle.volume.toFixed(8),
          amount: candle.amount?.toFixed(8) ?? null,
        },
        revision: state.revision,
        provisional: !candle.isClosed,
        complete: candle.complete,
        delayed: state.delayed,
        sourceUpdatedAt: candle.sourceUpdatedAt.toISOString(),
        final: candle.isClosed,
      });
    }
    return events;
  }

  async getCurrentSnapshot(
    assetId: string,
    interval: LiveCandleInterval,
  ): Promise<Omit<AssetCandleSnapshotEvent, 'sequence'> | null> {
    const state = await this.store.getCurrent(assetId);
    if (!state) return null;
    const snapshots = await this.buildCurrentSnapshots(state);
    return snapshots.find((event) => event.interval === interval) ?? null;
  }

  async overlayHttpResponse(
    response: AssetCandlesResponse,
    query: ParsedAssetCandlesQuery,
  ): Promise<AssetCandlesResponse> {
    if (!['5m', '15m', '30m', '1h', '4h'].includes(query.interval)) {
      return response;
    }
    const event = await this.getCurrentSnapshot(
      response.data.asset.id,
      query.interval as LiveCandleInterval,
    );
    if (!event) return response;
    const time = Date.parse(event.candle.time);
    const from = query.rangeStartAt?.getTime();
    const to = query.rangeEndAt?.getTime() ?? query.clock.getTime() + 1;
    if (
      !Number.isFinite(time) ||
      (from !== undefined && time < from) ||
      time >= to
    ) {
      return response;
    }
    const next = response.data.candles
      .filter((candle) => candle.time !== event.candle.time)
      .concat({
        time: event.candle.time,
        open: event.candle.open,
        high: event.candle.high,
        low: event.candle.low,
        close: event.candle.close,
        volume: event.candle.volume,
        amount: event.candle.amount ?? '0.00000000',
        sourceDate: event.candle.time.slice(0, 10).replace(/-/gu, ''),
        sourceTime: event.candle.time.slice(11, 19).replace(/:/gu, ''),
      })
      .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
    const limited = next.length > query.limit ? next.slice(-query.limit) : next;
    return {
      ...response,
      data: {
        ...response.data,
        state: limited.length > 0 ? 'available' : response.data.state,
        candles: limited,
        source: {
          ...response.data.source,
          returnedCount: limited.length,
        },
      },
    };
  }

  private eventFromState(
    state: LiveFiveMinuteCandleState,
  ): Omit<AssetCandleSnapshotEvent, 'sequence'> {
    return {
      type: 'asset_candle',
      assetId: state.assetId,
      interval: '5m',
      candle: {
        time: state.openTime,
        openTime: state.openTime,
        closeTime: state.closeTime,
        open: state.open,
        high: state.high,
        low: state.low,
        close: state.close,
        volume: state.volume as string,
        amount: state.amount,
      },
      revision: state.revision,
      provisional: state.provisional,
      complete: state.complete,
      delayed: state.delayed,
      sourceUpdatedAt: state.sourceUpdatedAt,
      final: state.finalized,
    };
  }

  private eventFromRow(
    state: LiveFiveMinuteCandleState,
    interval: '5m',
    row: MarketCandle,
  ): Omit<AssetCandleSnapshotEvent, 'sequence'> {
    return {
      type: 'asset_candle',
      assetId: state.assetId,
      interval,
      candle: {
        time: row.openTime.toISOString(),
        openTime: row.openTime.toISOString(),
        closeTime: row.closeTime.toISOString(),
        open: row.open.toFixed(8),
        high: row.high.toFixed(8),
        low: row.low.toFixed(8),
        close: row.close.toFixed(8),
        volume: row.volume.toFixed(8),
        amount: row.amount?.toFixed(8) ?? null,
      },
      revision: state.revision,
      provisional: false,
      complete: true,
      delayed: state.delayed,
      sourceUpdatedAt: row.sourceUpdatedAt.toISOString(),
      final: true,
    };
  }
}

function mergeLiveFiveMinute(
  stored: readonly MarketCandle[],
  state: LiveFiveMinuteCandleState,
) {
  const openMs = Date.parse(state.openTime);
  const hasClosed = stored.some(
    (row) => row.isClosed && row.openTime.getTime() === openMs,
  );
  if (hasClosed) return [...stored];
  const rows = stored.filter((row) => row.openTime.getTime() !== openMs);
  rows.push({
    id: `live:${state.assetId}:${openMs}`,
    assetId: state.assetId,
    interval: '5m',
    openTime: new Date(state.openTime),
    closeTime: new Date(state.closeTime),
    open: state.open as never,
    high: state.high as never,
    low: state.low as never,
    close: state.close as never,
    volume: state.volume as never,
    amount: state.amount as never,
    isClosed: false,
    sourceProvider: state.sourceProvider,
    sourceUpdatedAt: new Date(state.sourceUpdatedAt),
    createdAt: new Date(state.firstEventAt),
    updatedAt: new Date(state.sourceUpdatedAt),
  } as MarketCandle);
  return rows.sort(
    (left, right) => left.openTime.getTime() - right.openTime.getTime(),
  );
}
