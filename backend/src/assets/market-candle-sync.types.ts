import type {
  MarketCandleSyncMode,
  MarketCandleSyncStatus,
  Prisma,
} from '../generated/prisma/client';
import type { MarketCandleInterval } from './market-candles.repository';

// A "feed" is one persisted interval of one asset (5m, 1d, or 1w).
export type MarketCandleFeed = MarketCandleInterval;

export const MARKET_CANDLE_SYNC_FEEDS: readonly MarketCandleFeed[] = [
  '5m',
  '1d',
  '1w',
];

export type MarketCandleSyncStopReason =
  | 'target_reached'
  | 'provider_exhausted'
  | 'empty_page'
  | 'max_pages'
  | 'max_rows'
  | 'max_duration'
  | 'cursor_not_advanced'
  | 'canceled'
  | 'malformed_response'
  // A provider call or the candle write threw; the checkpoint cursor was not
  // advanced past the failed page, so the run is resumable.
  | 'provider_error'
  | 'write_failed'
  // Lock acquisition failed or ownership was lost between pages.
  | 'lock_not_acquired'
  | 'lock_lost'
  // dryRun planning result; no provider call or DB write happened.
  | 'dry_run';

// Canonical candle shape shared by every feed engine; matches what
// MarketCandlesRepository.upsertMany accepts once assetId/interval/source are
// attached.
export type CanonicalSyncCandle = {
  openTime: Date;
  closeTime: Date;
  open: Prisma.Decimal | string;
  high: Prisma.Decimal | string;
  low: Prisma.Decimal | string;
  close: Prisma.Decimal | string;
  volume: Prisma.Decimal | string;
  amount: Prisma.Decimal | string | null;
  isClosed: boolean;
  sourceUpdatedAt: Date;
};

// One checkpointable unit of provider work. For Binance and the KIS period
// APIs this is a single provider page; for the KIS 5m paths (owned by the
// 2-1/2-2 ingestion services) it is one bounded time segment that may span
// several provider pages internally.
export type MarketCandleFeedPage = {
  candles: CanonicalSyncCandle[];
  pagesFetched: number;
  providerReturnedRows: number;
  acceptedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  // Opaque resume cursor persisted to the checkpoint AFTER the page's
  // candles are written; null when the feed terminated on this page.
  nextCursor: Prisma.JsonObject | null;
  // Set when nextCursor is null.
  stopReason: MarketCandleSyncStopReason | null;
  // True only when the target range was fully swept.
  complete: boolean;
};

export type MarketCandleFeedResult = {
  provider: string;
  assetId: string;
  interval: MarketCandleFeed;
  rangeFrom: Date;
  rangeTo: Date;
  pagesFetched: number;
  providerReturnedRows: number;
  acceptedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  writtenRows: number;
  oldestOpenTime: Date | null;
  latestOpenTime: Date | null;
  complete: boolean;
  stopReason: MarketCandleSyncStopReason;
  status: MarketCandleSyncStatus;
  syncStateId: string | null;
  mode: MarketCandleSyncMode;
  resumed: boolean;
  dryRun: boolean;
  errorCode: string | null;
  errorMessage: string | null;
};

export type MarketCandleAssetSyncResult = {
  assetId: string;
  symbol: string;
  assetType: string;
  feeds: MarketCandleFeedResult[];
  failedFeeds: number;
};

export type MarketCandleSyncSummary = {
  mode: MarketCandleSyncMode;
  dryRun: boolean;
  requestedAssets: number;
  processedAssets: number;
  skippedAssets: {
    assetId: string;
    symbol: string;
    reason: string;
  }[];
  assets: MarketCandleAssetSyncResult[];
  totalFeeds: number;
  completedFeeds: number;
  failedFeeds: number;
  startedAt: Date;
  finishedAt: Date;
};

export class MarketCandleSyncInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketCandleSyncInputError';
  }
}
