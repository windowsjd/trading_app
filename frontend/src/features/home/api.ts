import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  IsoDateTimeString,
  MoneyString,
  PercentString,
  RateString,
  SectionState,
} from '../../models/dto/common';

export type { SectionState };

export type HomeMode =
  | 'no_current_season'
  | 'upcoming'
  | 'active_not_joined'
  | 'active_joined'
  | 'ended'
  | 'settled_not_joined'
  | 'settled_joined';

export interface HomeSectionErrorDto {
  code?: string;
  message?: string;
  retryable?: boolean;
}

export interface HomeSeasonDto {
  id?: string;
  name?: string;
  status?: string;
  startAt?: IsoDateTimeString;
  endAt?: IsoDateTimeString;
  settledAt?: IsoDateTimeString | null;
}

export interface HomeParticipantDto {
  id?: string;
  userId?: string;
  seasonId?: string;
  joinedAt?: IsoDateTimeString | null;
}

export interface HomeSectionDto {
  state?: SectionState;
  error?: HomeSectionErrorDto | null;
}

export interface HomeSummarySectionDto extends HomeSectionDto {
  totalAssetKrw?: MoneyString;
  returnRate?: PercentString;
  krwCash?: MoneyString;
  usdCashKrw?: MoneyString;
  assetValueKrw?: MoneyString;
  realizedPnlKrw?: MoneyString;
  unrealizedPnlKrw?: MoneyString;
  // Legacy fallback fields for screens that can receive an older shape.
  krwBalance?: MoneyString;
  usdBalance?: MoneyString;
}

export interface HomeWalletSummaryBalanceDto {
  currencyCode?: 'KRW' | 'USD' | string;
  balanceAmount?: MoneyString;
  balanceKrw?: MoneyString;
  updatedAt?: IsoDateTimeString;
}

export interface HomeWalletSummarySectionDto extends HomeSectionDto {
  KRW?: HomeWalletSummaryBalanceDto | MoneyString;
  USD?: HomeWalletSummaryBalanceDto | MoneyString;
  wallets?: HomeWalletSummaryBalanceDto[];
}

export interface HomeRankingSectionDto extends HomeSectionDto {
  provisionalTier?: string | null;
  finalTier?: string | null;
  percentile?: number | string | null;
  rank?: number | string | null;
  // Legacy fallback.
  tier?: string | null;
}

export interface HomeAllocationItemDto {
  assetType?: string;
  label?: string;
  valueKrw?: MoneyString;
  marketValueKrw?: MoneyString;
  weight?: RateString;
}

export interface HomeAllocationSectionDto extends HomeSectionDto {
  items?: HomeAllocationItemDto[];
  allocations?: HomeAllocationItemDto[];
  // Legacy fallback.
  cashKrwValue?: MoneyString;
  domesticStockValueKrw?: MoneyString;
  usStockValueKrw?: MoneyString;
  cryptoValueKrw?: MoneyString;
}

export interface HomeTopPositionDto {
  assetId?: string;
  symbol?: string;
  name?: string;
  assetName?: string;
  assetType?: string;
  marketValueKrw?: MoneyString;
  unrealizedPnlKrw?: MoneyString;
  returnRate?: PercentString;
}

export interface HomeTopPositionsSectionDto extends HomeSectionDto {
  items?: HomeTopPositionDto[];
  positions?: HomeTopPositionDto[];
}

export interface HomeEquityPointDto {
  time?: IsoDateTimeString | string;
  timestamp?: IsoDateTimeString | string;
  label?: string;
  totalAssetKrw?: MoneyString;
  equityKrw?: MoneyString;
}

export interface HomeEquityChartSectionDto extends HomeSectionDto {
  items?: HomeEquityPointDto[];
  points?: HomeEquityPointDto[];
}

export interface HomeDashboardDto {
  mode: HomeMode;
  season?: HomeSeasonDto | null;
  participant?: HomeParticipantDto | null;
  summary?: HomeSummarySectionDto | null;
  walletSummary?: HomeWalletSummarySectionDto | null;
  ranking?: HomeRankingSectionDto | null;
  allocation?: HomeAllocationSectionDto | null;
  topPositions?: HomeTopPositionsSectionDto | HomeTopPositionDto[] | null;
  equityChart?: HomeEquityChartSectionDto | HomeEquityPointDto[] | null;
}

export async function getHomeDashboard() {
  const response = await apiClient.get<ApiSuccessResponse<HomeDashboardDto>>(
    '/home',
  );

  return response.data.data;
}
