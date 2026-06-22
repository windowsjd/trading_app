import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  IsoDateTimeString,
  MoneyString,
  PercentString,
  SectionState,
} from '../../models/dto/common';
import type { AssetPriceErrorDto, AssetType, CurrencyCode } from '../market/api';

export type AssetCandleRange = '1d' | '7d' | '30d' | 'season';
export type AssetCandleInterval = '5m' | '1h' | '1d' | (string & {});

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
  priceSource?: string | null;
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
  interval?: AssetCandleInterval;
  candles: AssetCandleDto[];
}

export interface GetAssetCandlesParams {
  range: AssetCandleRange;
  interval?: AssetCandleInterval;
  limit?: number;
}

export const ASSET_CHART_RANGES: Array<{
  label: '1D' | '1W' | '1M' | '시즌';
  range: AssetCandleRange;
}> = [
  { label: '1D', range: '1d' },
  { label: '1W', range: '7d' },
  { label: '1M', range: '30d' },
  { label: '시즌', range: 'season' },
];

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
