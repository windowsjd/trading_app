import type { Prisma } from '../../../generated/prisma/client';
import type { KisCandleAssetInput, KisRawCandleRow } from './kis-candle.types';

// KIS 국내주식기간별시세(일/주/월/년): FHKST03010100. One call returns at most
// 100 rows, newest first, inside [FID_INPUT_DATE_1, FID_INPUT_DATE_2].
export const KIS_DOMESTIC_PERIOD_PATH =
  '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice';
export const KIS_DOMESTIC_PERIOD_TR_ID = 'FHKST03010100';
// KIS 해외주식 기간별시세: HHDFS76240000. One call returns at most 100 rows,
// newest first, walking backwards from BYMD.
export const KIS_OVERSEAS_PERIOD_PATH =
  '/uapi/overseas-price/v1/quotations/dailyprice';
export const KIS_OVERSEAS_PERIOD_TR_ID = 'HHDFS76240000';

export const KIS_DOMESTIC_PERIOD_SOURCE = 'kis_domestic_period';
export const KIS_OVERSEAS_PERIOD_SOURCE = 'kis_overseas_period';

// Adjusted-price policy (fixed, documented in the backend README):
// domestic FID_ORG_ADJ_PRC='0' means 수정주가 (adjusted), overseas MODP='1'
// means 수정주가 반영 (adjusted). Both feeds always request adjusted prices so
// re-syncing a date range after a corporate action converges to the
// provider's revised values via idempotent upsert.
export const KIS_DOMESTIC_PERIOD_ADJUSTED_PRICE_FLAG = '0';
export const KIS_OVERSEAS_PERIOD_ADJUSTED_PRICE_FLAG = '1';

export type KisPeriodInterval = '1d' | '1w';

// FID_PERIOD_DIV_CODE: D=일, W=주 (M/Y unused here).
export const KIS_DOMESTIC_PERIOD_DIV_CODE: Record<KisPeriodInterval, string> = {
  '1d': 'D',
  '1w': 'W',
};

// GUBN: 0=일, 1=주 (2=월 unused here).
export const KIS_OVERSEAS_PERIOD_GUBN: Record<KisPeriodInterval, string> = {
  '1d': '0',
  '1w': '1',
};

export type KisPeriodPageInput = {
  asset: KisCandleAssetInput;
  interval: KisPeriodInterval;
  // Local trading-calendar dates as compact YYYYMMDD text (Asia/Seoul for
  // domestic, America/New_York for overseas). The page walks backwards from
  // endDate and never needs rows older than fromDate.
  fromDate: string;
  endDate: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type KisPeriodPageState =
  | 'ok'
  | 'canceled'
  | 'max_duration'
  | 'malformed_response';

export type KisPeriodPageResult = {
  state: KisPeriodPageState;
  rows: KisRawCandleRow[];
  // Row count as returned by the provider including blank padding entries.
  providerReturnedRows: number;
  // FHKST03010100 pads output2 with all-empty rows; they are structural
  // padding, not data corruption, and are excluded from rows/rejected counts.
  blankRows: number;
  // Oldest valid YYYYMMDD date seen on this page (drives the backward cursor).
  oldestDate: string | null;
  latestDate: string | null;
  // Continuation metadata preserved from the response headers when available.
  trCont: string | null;
};

export type CanonicalPeriodCandle = {
  openTime: Date;
  closeTime: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: Prisma.Decimal;
  amount: Prisma.Decimal | null;
  isClosed: boolean;
  sourceUpdatedAt: Date;
};

export type KisPeriodNormalizationResult = {
  candles: CanonicalPeriodCandle[];
  acceptedRows: number;
  rejectedRows: number;
  duplicateRows: number;
};
