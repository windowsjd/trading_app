import type {
  MoneyString,
  OffsetPagination,
  PercentString,
  SectionState,
} from '../../models/dto/common';

export type PortfolioAssetType = 'domestic_stock' | 'us_stock' | 'crypto';
export type PortfolioRange = '1d' | '7d' | 'season';
export type PortfolioOverviewState = 'available' | 'not_joined' | 'unavailable';

export interface PortfolioSeasonDto {
  id?: string;
  name?: string;
  status?: string;
  startAt?: string;
  endAt?: string;
}

export interface PortfolioParticipantDto {
  id?: string;
  userId?: string;
  seasonId?: string;
  joinedAt?: string | null;
}

export interface PortfolioSummaryDto {
  totalAssetKrw: MoneyString;
  returnRate: PercentString;
  krwCash: MoneyString;
  usdCashKrw: MoneyString;
  assetValueKrw: MoneyString;
  realizedPnlKrw: MoneyString;
  unrealizedPnlKrw: MoneyString;
}

export interface PortfolioAllocationDto {
  state: SectionState | PortfolioOverviewState;
  cashKrwValue: MoneyString;
  domesticStockValueKrw: MoneyString;
  usStockValueKrw: MoneyString;
  cryptoValueKrw: MoneyString;
  reason?: string;
  message?: string;
}

export interface PortfolioSectionErrorDto {
  section: string;
  code: string;
  message: string;
}

export interface PortfolioOverviewDto {
  state: PortfolioOverviewState;
  season: PortfolioSeasonDto | null;
  participant: PortfolioParticipantDto | null;
  summary: PortfolioSummaryDto | null;
  allocation: PortfolioAllocationDto;
  sectionErrors: PortfolioSectionErrorDto[];
  reason?: string;
  message?: string;
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
  pagination: OffsetPagination;
}

export interface GetPortfolioPositionsParams {
  assetType: PortfolioAssetType;
  limit?: number;
  offset?: number;
}

export interface PortfolioEquityDto {
  range: PortfolioRange;
  points: Array<{
    time: string;
    totalAssetKrw: string;
  }>;
}



