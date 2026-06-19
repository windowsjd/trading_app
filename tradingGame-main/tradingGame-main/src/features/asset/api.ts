import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';

export interface AssetDetailDto {
  asset: {
    id: string;
    symbol: string;
    name: string;
    assetClass: 'domestic_stock' | 'us_stock' | 'crypto';
    market: string;
    marketStatus: 'open' | 'closed' | 'halted';
  };
  price: {
    priceLocal: string;
    priceCurrency: 'KRW' | 'USD';
    priceKrw: string;
    changeRate: string;
    isStale: boolean;
    capturedAt: string;
  };
  position: null | {
    quantity: string;
    avgEntryPriceLocal: string;
    marketValueKrw: string;
    unrealizedPnlKrw: string;
  };
}

export interface AssetCandlesDto {
  interval: string;
  candles: Array<{
    time: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }>;
}

export async function getAssetDetail(assetId: string) {
  const response = await apiClient.get<ApiSuccessResponse<AssetDetailDto>>(
    `/assets/${assetId}`,
  );

  return response.data.data;
}

export async function getAssetCandles(assetId: string, interval: string) {
  const response = await apiClient.get<ApiSuccessResponse<AssetCandlesDto>>(
    `/assets/${assetId}/candles?interval=${interval}`,
  );

  return response.data.data;
}