import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';

export interface HomeSummaryDto {
  totalAssetKrw: string;
  returnRate: string;
  krwBalance: string;
  usdBalance: string;
}

export interface HomeRankingDto {
  rank: number;
  tier: string;
}

export interface HomeAllocationDto {
  cashKrwValue: string;
  domesticStockValueKrw: string;
  usStockValueKrw: string;
  cryptoValueKrw: string;
}

export interface HomeTopPositionDto {
  assetId: string;
  symbol: string;
  name: string;
  marketValueKrw: string;
  returnRate: string;
}

export interface HomeEquityPointDto {
  time: string;
  totalAssetKrw: string;
}

export interface HomeDashboardDto {
  summary: HomeSummaryDto;
  ranking: HomeRankingDto;
  allocation: HomeAllocationDto;
  topPositions: HomeTopPositionDto[];
  equityChart: HomeEquityPointDto[];
}

export async function getHomeDashboard() {
  const response = await apiClient.get<ApiSuccessResponse<HomeDashboardDto>>(
    '/home',
  );

  return response.data.data;
}