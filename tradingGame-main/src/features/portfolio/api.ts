import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';

export type PortfolioAssetClass = 'domestic_stock' | 'us_stock' | 'crypto';
export type PortfolioRange = '1d' | '7d' | 'season';

export interface PortfolioOverviewDto {
  summary: {
    totalAssetKrw: string;
    returnRate: string;
    krwBalance: string;
    usdBalance: string;
    usdBalanceKrw: string;
  };
  allocation: {
    cashKrwValue: string;
    domesticStockValueKrw: string;
    usStockValueKrw: string;
    cryptoValueKrw: string;
  };
}

export interface PortfolioPositionItemDto {
  assetId: string;
  symbol: string;
  name: string;
  quantity: string;
  marketValueKrw: string;
  unrealizedPnlKrw: string;
  returnRate: string;
}

export interface PortfolioPositionsDto {
  items: PortfolioPositionItemDto[];
}

export interface PortfolioEquityDto {
  range: PortfolioRange;
  points: Array<{
    time: string;
    totalAssetKrw: string;
  }>;
}

export async function getPortfolioOverview() {
  const response = await apiClient.get<ApiSuccessResponse<PortfolioOverviewDto>>(
    '/portfolio',
  );

  return response.data.data;
}

export async function getPortfolioPositions(assetClass: PortfolioAssetClass) {
  const response = await apiClient.get<ApiSuccessResponse<PortfolioPositionsDto>>(
    `/portfolio/positions?assetClass=${assetClass}`,
  );

  return response.data.data;
}

export async function getPortfolioEquity(range: PortfolioRange) {
  const response = await apiClient.get<ApiSuccessResponse<PortfolioEquityDto>>(
    `/portfolio/equity?range=${range}`,
  );

  return response.data.data;
}