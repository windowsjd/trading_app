import { Inject, Injectable } from '@nestjs/common';
import {
  AssetType,
  MarketCandleSyncMode,
  MarketCandleSyncStatus,
  type MarketCandle,
} from '../generated/prisma/client';
import { findLatestCompletedMarketSession } from '../orders/market-calendar.policy';
import { zonedDateTimeToUtc } from '../providers/kis/candles/kis-candle-time';
import { PrismaService } from '../prisma/prisma.service';
import { LiveCandlePublisherService } from './live-candle-publisher.service';
import { LiveCandleStoreService } from './live-candle-store.service';
import {
  MARKET_CANDLE_RECONCILIATION_CONFIG,
  type MarketCandleReconciliationConfig,
} from './market-candle-reconciliation.config';
import { MarketCandlesRepository } from './market-candles.repository';
import { MarketCandleSyncService } from './market-candle-sync.service';
import type { MarketCandleFeed } from './market-candle-sync.types';

export type ReconciliationMarket = 'KRX' | 'US' | 'CRYPTO' | 'ALL';

export type MarketCandleReconciliationInput = {
  dryRun?: boolean;
  assetIds?: string[];
  assetTypes?: AssetType[];
  market?: ReconciliationMarket;
  from?: Date;
  to?: Date;
  targets?: MarketCandleFeed[];
  maxAssets?: number;
  maxPages?: number;
  continueOnError?: boolean;
  now?: Date;
};

export type ReconciliationAssetResult = {
  assetId: string;
  symbol: string;
  targets: MarketCandleFeed[];
  checkedRows: number;
  missingRows: number;
  correctedRows: number;
  unchangedRows: number;
  closeStateDrift: number;
  ohlcDrift: number;
  volumeDrift: number;
  amountDrift: number;
  sourceTimestampDrift: number;
  correctionReasons: Record<string, number>;
  failed: boolean;
  errorCode: string | null;
};

export type MarketCandleReconciliationSummary = {
  dryRun: boolean;
  market: ReconciliationMarket;
  assetsChecked: number;
  missingRows: number;
  correctedRows: number;
  unchangedRows: number;
  failedAssets: number;
  results: ReconciliationAssetResult[];
  startedAt: Date;
  finishedAt: Date;
};

@Injectable()
export class MarketCandleReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: MarketCandlesRepository,
    private readonly sync: MarketCandleSyncService,
    private readonly liveStore: LiveCandleStoreService,
    private readonly livePublisher: LiveCandlePublisherService,
    @Inject(MARKET_CANDLE_RECONCILIATION_CONFIG)
    private readonly config: MarketCandleReconciliationConfig,
  ) {}

  async reconcile(
    input: MarketCandleReconciliationInput = {},
  ): Promise<MarketCandleReconciliationSummary> {
    const startedAt = new Date();
    const now = input.now ?? startedAt;
    const market = input.market ?? 'ALL';
    const maxAssets = Math.min(
      input.maxAssets ?? this.config.maxAssets,
      this.config.maxAssets,
    );
    const assets = await this.prisma.asset.findMany({
      where: {
        isActive: true,
        ...(input.assetIds?.length ? { id: { in: input.assetIds } } : {}),
        ...(input.assetTypes?.length
          ? { assetType: { in: input.assetTypes } }
          : market === 'KRX'
            ? { assetType: AssetType.domestic_stock }
            : market === 'US'
              ? { assetType: AssetType.us_stock }
              : market === 'CRYPTO'
                ? { assetType: AssetType.crypto }
                : {}),
      },
      select: {
        id: true,
        symbol: true,
        assetType: true,
        market: true,
      },
      orderBy: [{ symbol: 'asc' }, { id: 'asc' }],
      take: maxAssets,
    });
    const results: ReconciliationAssetResult[] = [];
    for (const asset of assets) {
      const targets =
        input.targets ??
        (asset.assetType === AssetType.crypto ? ['5m'] : ['5m', '1d']);
      const range = this.resolveRange(asset, targets, input, now);
      if (!range) continue;
      const empty = emptyAssetResult(asset, targets);
      if (input.dryRun) {
        results.push(empty);
        continue;
      }
      try {
        const before = await this.loadRows(asset.id, targets, range);
        const sync = await this.sync.syncAsset({
          assetId: asset.id,
          targets,
          mode: MarketCandleSyncMode.repair,
          from: range.from,
          to: range.to,
          resume: false,
          now,
          budget: {
            maxPages: Math.min(
              input.maxPages ?? this.config.maxPages,
              this.config.maxPages,
            ),
            maxRows: 20_000,
            maxDurationMs: 60_000,
          },
        });
        if (
          sync.feeds.some(
            (feed) => feed.status !== MarketCandleSyncStatus.completed,
          )
        ) {
          empty.failed = true;
          empty.errorCode =
            sync.feeds.find(
              (feed) => feed.status !== MarketCandleSyncStatus.completed,
            )?.errorCode ?? 'RECONCILIATION_FEED_FAILED';
        }
        const after = await this.loadRows(asset.id, targets, range);
        const compared = compareRows(before, after);
        Object.assign(empty, compared);
        results.push(empty);
        await this.recoverLiveState(asset.id, after);
      } catch (error) {
        empty.failed = true;
        empty.errorCode = error instanceof Error ? error.name : 'UNKNOWN_ERROR';
        results.push(empty);
        if (input.continueOnError === false) throw error;
      }
    }
    return {
      dryRun: input.dryRun === true,
      market,
      assetsChecked: results.length,
      missingRows: sum(results, 'missingRows'),
      correctedRows: sum(results, 'correctedRows'),
      unchangedRows: sum(results, 'unchangedRows'),
      failedAssets: results.filter((result) => result.failed).length,
      results,
      startedAt,
      finishedAt: new Date(),
    };
  }

  async hasRecentCanonicalCoverage(
    market: Exclude<ReconciliationMarket, 'ALL'>,
    now = new Date(),
  ): Promise<boolean> {
    const assetType =
      market === 'KRX'
        ? AssetType.domestic_stock
        : market === 'US'
          ? AssetType.us_stock
          : AssetType.crypto;
    const assets = await this.prisma.asset.findMany({
      where: { isActive: true, assetType },
      select: { id: true, assetType: true, market: true },
    });
    if (assets.length === 0) return true;

    let from: Date;
    let to: Date;
    if (market === 'CRYPTO') {
      const completedBucketEnd = Math.floor(now.getTime() / 300_000) * 300_000;
      from = new Date(completedBucketEnd - 300_000);
      to = new Date(completedBucketEnd);
    } else {
      const session = findLatestCompletedMarketSession(assets[0], now, 10);
      if (!session) return false;
      from = new Date(session.closeTime.getTime() - 300_000);
      to = session.closeTime;
    }
    const covered = await this.prisma.marketCandle.findMany({
      where: {
        assetId: { in: assets.map((asset) => asset.id) },
        interval: '5m',
        isClosed: true,
        openTime: { gte: from, lt: to },
      },
      distinct: ['assetId'],
      select: { assetId: true },
    });
    return new Set(covered.map((row) => row.assetId)).size === assets.length;
  }

  private resolveRange(
    asset: { assetType: AssetType; market: string },
    targets: readonly MarketCandleFeed[],
    input: MarketCandleReconciliationInput,
    now: Date,
  ): { from: Date; to: Date } | null {
    if (input.from && input.to) return { from: input.from, to: input.to };
    if (asset.assetType === AssetType.crypto) {
      const completedTo = Math.floor(now.getTime() / 300_000) * 300_000;
      const lookback = targets.includes('1w')
        ? 21 * 86_400_000
        : targets.includes('1d')
          ? 3 * 86_400_000
          : this.config.lookbackBuckets * 300_000;
      return {
        from: new Date(completedTo - lookback),
        to: new Date(completedTo),
      };
    }
    const session = findLatestCompletedMarketSession(
      asset,
      now,
      Math.ceil(this.config.maxCatchUpHours / 24),
    );
    if (!session) return null;
    const localDate = session.localDate.replace(/-/gu, '');
    const rangeStartDate = targets.includes('1w')
      ? mondayOfWeek(localDate)
      : localDate;
    if (!rangeStartDate) return null;
    const midnight = zonedDateTimeToUtc(
      rangeStartDate,
      '000000',
      session.timeZone,
    );
    if (!midnight) return null;
    return { from: midnight, to: session.closeTime };
  }

  private async loadRows(
    assetId: string,
    targets: readonly MarketCandleFeed[],
    range: { from: Date; to: Date },
  ): Promise<MarketCandle[]> {
    const pages = await Promise.all(
      targets.map((interval) =>
        this.repository.findRange({ assetId, interval, ...range }),
      ),
    );
    return pages.flat();
  }

  private async recoverLiveState(
    assetId: string,
    canonicalRows: readonly MarketCandle[],
  ): Promise<void> {
    const current = await this.liveStore.getCurrent(assetId);
    if (!current) return;
    const canonical = canonicalRows.find(
      (row) =>
        row.interval === '5m' &&
        row.isClosed &&
        row.openTime.getTime() === Date.parse(current.openTime),
    );
    if (!canonical) return;
    await this.livePublisher.publishState({
      ...current,
      open: canonical.open.toFixed(8),
      high: canonical.high.toFixed(8),
      low: canonical.low.toFixed(8),
      close: canonical.close.toFixed(8),
      volume: canonical.volume.toFixed(8),
      amount: canonical.amount?.toFixed(8) ?? null,
      sourceUpdatedAt: canonical.sourceUpdatedAt.toISOString(),
      revision: current.revision + 1,
      provisional: false,
      complete: true,
      finalized: true,
      providerFinal: true,
    });
    await this.liveStore.discardReconciledCurrent(assetId, canonical.openTime);
  }
}

function emptyAssetResult(
  asset: { id: string; symbol: string },
  targets: readonly MarketCandleFeed[],
): ReconciliationAssetResult {
  return {
    assetId: asset.id,
    symbol: asset.symbol,
    targets: [...targets],
    checkedRows: 0,
    missingRows: 0,
    correctedRows: 0,
    unchangedRows: 0,
    closeStateDrift: 0,
    ohlcDrift: 0,
    volumeDrift: 0,
    amountDrift: 0,
    sourceTimestampDrift: 0,
    correctionReasons: {},
    failed: false,
    errorCode: null,
  };
}

function compareRows(
  beforeRows: readonly MarketCandle[],
  afterRows: readonly MarketCandle[],
): Pick<
  ReconciliationAssetResult,
  | 'checkedRows'
  | 'missingRows'
  | 'correctedRows'
  | 'unchangedRows'
  | 'closeStateDrift'
  | 'ohlcDrift'
  | 'volumeDrift'
  | 'amountDrift'
  | 'sourceTimestampDrift'
  | 'correctionReasons'
> {
  const before = new Map(beforeRows.map((row) => [rowKey(row), row]));
  let missingRows = 0;
  let correctedRows = 0;
  let unchangedRows = 0;
  let closeStateDrift = 0;
  let ohlcDrift = 0;
  let volumeDrift = 0;
  let amountDrift = 0;
  let sourceTimestampDrift = 0;
  const correctionReasons: Record<string, number> = {};
  for (const row of afterRows) {
    const previous = before.get(rowKey(row));
    if (!previous) {
      missingRows += 1;
      increment(correctionReasons, 'missing_bucket');
      continue;
    }
    const reasons: string[] = [];
    if (
      previous.open.toFixed(8) !== row.open.toFixed(8) ||
      previous.high.toFixed(8) !== row.high.toFixed(8) ||
      previous.low.toFixed(8) !== row.low.toFixed(8) ||
      previous.close.toFixed(8) !== row.close.toFixed(8)
    ) {
      ohlcDrift += 1;
      reasons.push('ohlc');
    }
    if (previous.volume.toFixed(8) !== row.volume.toFixed(8)) {
      volumeDrift += 1;
      reasons.push('volume');
    }
    if (
      (previous.amount?.toFixed(8) ?? null) !== (row.amount?.toFixed(8) ?? null)
    ) {
      amountDrift += 1;
      reasons.push('amount');
    }
    if (previous.isClosed !== row.isClosed) {
      closeStateDrift += 1;
      reasons.push('close_state');
    }
    if (previous.sourceUpdatedAt.getTime() !== row.sourceUpdatedAt.getTime()) {
      sourceTimestampDrift += 1;
      reasons.push('source_updated_at');
    }
    if (reasons.length === 0) unchangedRows += 1;
    else {
      correctedRows += 1;
      for (const reason of reasons) increment(correctionReasons, reason);
    }
  }
  return {
    checkedRows: afterRows.length,
    missingRows,
    correctedRows,
    unchangedRows,
    closeStateDrift,
    ohlcDrift,
    volumeDrift,
    amountDrift,
    sourceTimestampDrift,
    correctionReasons,
  };
}

function rowKey(row: MarketCandle): string {
  return `${row.interval}:${row.openTime.getTime()}`;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function sum(
  results: readonly ReconciliationAssetResult[],
  key: 'missingRows' | 'correctedRows' | 'unchangedRows',
): number {
  return results.reduce((total, result) => total + result[key], 0);
}

function mondayOfWeek(localDate: string): string | null {
  if (!/^\d{8}$/u.test(localDate)) return null;
  const year = Number(localDate.slice(0, 4));
  const month = Number(localDate.slice(4, 6));
  const day = Number(localDate.slice(6, 8));
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) {
    return null;
  }
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value.toISOString().slice(0, 10).replace(/-/gu, '');
}
