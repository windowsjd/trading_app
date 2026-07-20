import type { Prisma } from '../../../generated/prisma/client';

export const KIS_DOMESTIC_MINUTE_PATH =
  '/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice';
export const KIS_DOMESTIC_MINUTE_TR_ID = 'FHKST03010230';
export const KIS_US_MINUTE_PATH =
  '/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice';
export const KIS_US_MINUTE_TR_ID = 'HHDFS76950200';
export const KIS_DOMESTIC_CANDLE_SOURCE = 'kis_domestic_minute';
export const KIS_US_CANDLE_SOURCE = 'kis_overseas_minute';

export type KisCandleStopReason =
  | 'target_reached'
  | 'expected_no_data'
  | 'calendar_unavailable'
  | 'provider_exhausted'
  | 'empty_page'
  | 'max_pages'
  | 'max_rows'
  | 'max_duration'
  | 'cursor_not_advanced'
  | 'canceled'
  | 'malformed_response';

export type KisCandleAssetInput = {
  id: string;
  symbol: string;
  marketCode: string;
};

export type KisCandleFetchInput = {
  asset: KisCandleAssetInput;
  from: Date;
  to: Date;
  maxPages?: number;
  maxRows?: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
  now?: Date;
};

export type KisRawCandleRow = {
  value: Record<string, unknown>;
  receivedAt: Date;
  sequence: number;
};

export type KisCandleAdapterResult = {
  pagesFetched: number;
  providerReturnedRows: number;
  rows: KisRawCandleRow[];
  duplicateRows: number;
  complete: boolean;
  stopReason: KisCandleStopReason;
  oldestOpenTime: Date | null;
  latestOpenTime: Date | null;
};

export type NormalizedKisCandleRow = {
  openTime: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: Prisma.Decimal;
  amount: Prisma.Decimal | null;
  sourceUpdatedAt: Date;
};

export type KisNormalizationResult = {
  rows: NormalizedKisCandleRow[];
  acceptedRows: number;
  // Every row that was not accepted, for any reason (benign exclusions AND
  // integrity failures). Kept as the historical total for feed counters.
  rejectedRows: number;
  // Subset of rejectedRows that are OBSERVABLE data-integrity failures:
  // unparsable timestamps, regular-session rows off the 5-minute grid, and
  // regular-session rows with malformed OHLCV. Benign exclusions
  // (pre-market/after-hours, holidays/weekends via the market calendar,
  // out-of-request-range, future rows, deduplicated rows) never count here.
  // Any integrity failure means the fetched range must not be declared
  // data-complete.
  integrityFailedRows: number;
  duplicateRows: number;
};

export type CanonicalFiveMinuteCandle = NormalizedKisCandleRow & {
  closeTime: Date;
  isClosed: boolean;
};

export type KisDomesticBuildResult = {
  candles: CanonicalFiveMinuteCandle[];
  completeBuckets: number;
  incompleteBuckets: number;
  rejectedBuckets: number;
};

export class KisCandleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KisCandleInputError';
  }
}
