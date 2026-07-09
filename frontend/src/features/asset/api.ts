import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  IsoDateTimeString,
  MoneyString,
  PercentString,
  SectionState,
  SourceMetadata,
} from '../../models/dto/common';
import type { AssetPriceErrorDto, AssetType, CurrencyCode } from '../market/api';

import type {
  AssetCandleInterval,
  AssetCandleRange,
} from './chartTimeframes';

// Timeframe policy lives in ./chartTimeframes (pure, unit-testable module);
// re-exported here so existing imports keep working.
export {
  ASSET_CHART_TIMEFRAMES,
  DEFAULT_ASSET_CHART_TIMEFRAME,
} from './chartTimeframes';
export type {
  AssetCandleInterval,
  AssetCandleRange,
  AssetChartTimeframe,
} from './chartTimeframes';

export interface AssetDetailPriceDto {
  state: SectionState;
  currentPrice: MoneyString | null;
  priceCurrency: CurrencyCode;
  priceKrwState?: SectionState;
  priceKrw?: MoneyString | null;
  changeRate?: PercentString | null;
  priceCapturedAt?: IsoDateTimeString | null;
  priceEffectiveAt?: IsoDateTimeString | null;
  assetPriceSnapshotId?: string | null;
  priceSource?: SourceMetadata;
}

export interface AssetDetailAssetDto {
  id: string;
  assetType: AssetType;
  symbol: string;
  name: string;
  market: string;
  priceCurrency: CurrencyCode;
  settlementCurrency: CurrencyCode;
  isActive: boolean;
  marketStatus: string;
  tradable: boolean;
  tradeBlockedReason?: string | null;
  metadata?: Record<string, unknown> | null;
  tradingNote?: string | Record<string, unknown> | unknown[] | null;
  price?: AssetDetailPriceDto | null;
}

export interface AssetDetailDto {
  state?: SectionState;
  asset: AssetDetailAssetDto;
  priceErrors?: AssetPriceErrorDto[];
}

export interface AssetCandleDto {
  time: IsoDateTimeString;
  open: MoneyString;
  high: MoneyString;
  low: MoneyString;
  close: MoneyString;
  volume: string;
}

export interface AssetCandlesSourceDto {
  provider?: 'kis' | 'binance';
  requestedCount?: number;
  returnedCount?: number;
  // Binance only: true when the requested window exceeded one klines call and
  // older candles were cut off.
  truncated?: boolean;
}

export interface AssetCandlesDto {
  range: AssetCandleRange;
  interval: AssetCandleInterval;
  candles: AssetCandleDto[];
  // Present in the API response; typed as optional for dev diagnostics only.
  source?: AssetCandlesSourceDto;
}

export interface GetAssetCandlesParams {
  range: AssetCandleRange;
  interval?: AssetCandleInterval;
  limit?: number;
}

export async function getAssetDetail(assetId: string) {
  const response = await apiClient.get<ApiSuccessResponse<AssetDetailDto>>(
    `/assets/${assetId}`,
  );

  return response.data.data;
}

export async function getAssetPrice(assetId: string) {
  const response = await apiClient.get<ApiSuccessResponse<AssetDetailPriceDto>>(
    `/assets/${assetId}/price`,
  );

  return response.data.data;
}

export async function getAssetCandles(
  assetId: string,
  params: AssetCandleRange | GetAssetCandlesParams,
) {
  const requestParams =
    typeof params === 'string' ? { range: params } : params;
  const searchParams = new URLSearchParams();

  searchParams.set('range', requestParams.range);
  if (requestParams.interval) {
    searchParams.set('interval', requestParams.interval);
  }
  if (requestParams.limit) {
    searchParams.set('limit', String(requestParams.limit));
  }

  const response = await apiClient.get<ApiSuccessResponse<AssetCandlesDto>>(
    `/assets/${assetId}/candles?${searchParams.toString()}`,
  );

  return response.data.data;
}
