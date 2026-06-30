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

export type AssetCandleRange = '1d' | '7d' | '30d' | 'season';
export type AssetCandleInterval =
  | '1m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '4h'
  | '1d'
  | '1w';
export type AssetChartTimeframe = {
  label: AssetCandleInterval;
  interval: AssetCandleInterval;
  range: AssetCandleRange;
  limit: number;
};

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

export interface AssetCandlesDto {
  range: AssetCandleRange;
  interval: AssetCandleInterval;
  candles: AssetCandleDto[];
}

export interface GetAssetCandlesParams {
  range: AssetCandleRange;
  interval?: AssetCandleInterval;
  limit?: number;
}

export const ASSET_CHART_TIMEFRAMES: AssetChartTimeframe[] = [
  { label: '1m', interval: '1m', range: '1d', limit: 100 },
  { label: '5m', interval: '5m', range: '1d', limit: 100 },
  { label: '15m', interval: '15m', range: '1d', limit: 100 },
  { label: '30m', interval: '30m', range: '7d', limit: 100 },
  { label: '1h', interval: '1h', range: '7d', limit: 100 },
  { label: '4h', interval: '4h', range: '30d', limit: 100 },
  { label: '1d', interval: '1d', range: 'season', limit: 100 },
  { label: '1w', interval: '1w', range: 'season', limit: 100 },
];
export const DEFAULT_ASSET_CHART_TIMEFRAME = ASSET_CHART_TIMEFRAMES[1];

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
