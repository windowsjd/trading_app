import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  MoneyString,
  OffsetPagination,
  PercentString,
  SectionState,
} from '../../models/dto/common';
import type { WalletBalanceDto } from '../wallet/api';
import type { PositionItemDto } from '../position/api';

/**
 * Account-scoped API surface (작업 9).
 *
 * Every financial read below names its `accountId` in the PATH. That is the
 * whole point of the surface: the server stores no "currently selected
 * account" anywhere — no JWT claim, no session, no User column — so a request
 * that does not name an account cannot be about one. Account selection is
 * frontend state, and ownership is re-verified server-side on every call.
 *
 * These are the EXISTING backend routes (작업 4·5·6·7). Nothing here invents an
 * endpoint, and the legacy `/portfolio`, `/wallets`, `/positions`, `/orders`
 * surfaces are left exactly as they are.
 */

export type TradingAccountMode = 'season' | 'general';
export type TradingAccountStatus = 'active' | 'suspended' | 'closed';
export type ReturnRateMethod = 'time_weighted' | 'initial_capital';

export interface TradingAccountSeasonDto {
  seasonId: string;
  seasonName: string;
  seasonStatus: 'upcoming' | 'active' | 'ended' | 'settled';
  startAt: string;
  endAt: string;
  seasonParticipantId: string;
  participantStatus:
    | 'registered'
    | 'active'
    | 'excluded'
    | 'finished'
    | 'rewarded';
  joinedAt: string;
}

export interface TradingAccountDto {
  id: string;
  mode: TradingAccountMode;
  status: TradingAccountStatus;
  initialCapitalKrw: MoneyString;
  openedAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  season: TradingAccountSeasonDto | null;
}

export interface TradingAccountsDto {
  accounts: TradingAccountDto[];
}

/**
 * `returnRateMethod` is REQUIRED reading, not decoration: a general account's
 * `returnRate` is a time-weighted return that already excludes ad-funded
 * inflows, and a season account's is a plain initial-capital return. Labelling
 * one with the other's meaning misstates the number.
 */
export interface TradingAccountPortfolioSummaryDto {
  totalAssetKrw: MoneyString;
  returnRate: PercentString;
  returnRateMethod: ReturnRateMethod;
  krwCash: MoneyString;
  usdCashKrw: MoneyString;
  assetValueKrw: MoneyString;
  realizedPnlKrw: MoneyString;
  unrealizedPnlKrw: MoneyString;
  valuedAt?: string;
  /** general only; `null` on a season account — never 0, which would read as "none received". */
  initialFundingKrw: MoneyString | null;
  cumulativeExternalFundingKrw: MoneyString | null;
  cumulativeAdRewardKrw: MoneyString | null;
  investmentPnlKrw: MoneyString | null;
}

export interface TradingAccountAllocationDto {
  state: SectionState;
  cashKrwValue: MoneyString;
  domesticStockValueKrw: MoneyString;
  usStockValueKrw: MoneyString;
  cryptoValueKrw: MoneyString;
  reason?: string;
  message?: string;
}

export interface TradingAccountSectionErrorDto {
  section: string;
  code: string;
  message: string;
}

export interface TradingAccountPortfolioDto {
  tradingAccountId: string;
  mode: TradingAccountMode;
  status: TradingAccountStatus;
  state: 'available' | 'unavailable';
  summary: TradingAccountPortfolioSummaryDto | null;
  allocation: TradingAccountAllocationDto;
  sectionErrors: TradingAccountSectionErrorDto[];
  reason?: string;
  message?: string;
}

export type TradingAccountEquityRange = '1d' | '7d' | '30d' | 'all';

export interface TradingAccountEquityPointDto {
  time: string;
  totalAssetKrw: MoneyString;
  returnRate: PercentString;
  returnRateMethod: ReturnRateMethod;
  cumulativeExternalFundingKrw: MoneyString | null;
  investmentPnlKrw: MoneyString | null;
  snapshotReason?: string;
  externalFundingAmountKrw?: MoneyString | null;
}

export interface TradingAccountEquityDto {
  tradingAccountId: string;
  range: TradingAccountEquityRange;
  returnRateMethod: ReturnRateMethod;
  points: TradingAccountEquityPointDto[];
}

export interface TradingAccountWalletsDto {
  tradingAccountId: string;
  wallets: WalletBalanceDto[];
  summary: {
    totalWallets: number;
    hasKrwWallet: boolean;
    hasUsdWallet: boolean;
  };
}

export interface TradingAccountPositionsDto {
  state: SectionState;
  tradingAccountId: string;
  filters?: Record<string, unknown>;
  pagination: OffsetPagination;
  positions: PositionItemDto[];
  summary?: Record<string, unknown> | null;
  valuationErrors?: TradingAccountSectionErrorDto[];
}

export interface TradingAccountOrdersDto {
  state: SectionState;
  tradingAccountId: string;
  filters?: Record<string, unknown>;
  pagination: OffsetPagination;
  orders: Array<Record<string, unknown>>;
}

export interface AdRewardEligibilityDto {
  eligible: boolean;
  reason: string | null;
  message?: string | null;
  rewardAmountKrw?: MoneyString | null;
  dailyClaimCount?: number;
  dailyClaimLimit?: number;
}

function accountPath(accountId: string, suffix = '') {
  return `/trading-accounts/${encodeURIComponent(accountId)}${suffix}`;
}

export async function getTradingAccounts() {
  const response =
    await apiClient.get<ApiSuccessResponse<TradingAccountsDto>>(
      '/trading-accounts',
    );

  return response.data.data;
}

export async function getTradingAccount(accountId: string) {
  const response = await apiClient.get<ApiSuccessResponse<TradingAccountDto>>(
    accountPath(accountId),
  );

  return response.data.data;
}

export async function getTradingAccountPortfolio(accountId: string) {
  const response = await apiClient.get<
    ApiSuccessResponse<TradingAccountPortfolioDto>
  >(accountPath(accountId, '/portfolio'));

  return response.data.data;
}

export async function getTradingAccountEquity(
  accountId: string,
  range: TradingAccountEquityRange,
) {
  const response = await apiClient.get<
    ApiSuccessResponse<TradingAccountEquityDto>
  >(accountPath(accountId, '/portfolio/equity'), { params: { range } });

  return response.data.data;
}

export async function getTradingAccountWallets(accountId: string) {
  const response = await apiClient.get<
    ApiSuccessResponse<TradingAccountWalletsDto>
  >(accountPath(accountId, '/wallets'));

  return response.data.data;
}

export interface TradingAccountPositionsParams {
  assetType?: string;
  assetId?: string;
  limit?: number;
  offset?: number;
}

export async function getTradingAccountPositions(
  accountId: string,
  params: TradingAccountPositionsParams = {},
) {
  const response = await apiClient.get<
    ApiSuccessResponse<TradingAccountPositionsDto>
  >(accountPath(accountId, '/positions'), {
    params: {
      ...(params.assetType ? { assetType: params.assetType } : {}),
      ...(params.assetId ? { assetId: params.assetId } : {}),
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
    },
  });

  return response.data.data;
}

export interface TradingAccountOrdersParams {
  status?: string;
  side?: string;
  assetId?: string;
  limit?: number;
  offset?: number;
}

export async function getTradingAccountOrders(
  accountId: string,
  params: TradingAccountOrdersParams = {},
) {
  const response = await apiClient.get<
    ApiSuccessResponse<TradingAccountOrdersDto>
  >(accountPath(accountId, '/orders'), {
    params: {
      ...(params.status ? { status: params.status } : {}),
      ...(params.side ? { side: params.side } : {}),
      ...(params.assetId ? { assetId: params.assetId } : {}),
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
    },
  });

  return response.data.data;
}

export async function getTradingAccountOrder(
  accountId: string,
  orderId: string,
) {
  const response = await apiClient.get<
    ApiSuccessResponse<Record<string, unknown>>
  >(accountPath(accountId, `/orders/${encodeURIComponent(orderId)}`));

  return response.data.data;
}

export async function getAdRewardEligibility(accountId: string) {
  const response = await apiClient.get<
    ApiSuccessResponse<AdRewardEligibilityDto>
  >(accountPath(accountId, '/ad-rewards/eligibility'));

  return response.data.data;
}

export async function getAdRewardClaims(
  accountId: string,
  params: { limit?: number; offset?: number } = {},
) {
  const response = await apiClient.get<
    ApiSuccessResponse<{
      tradingAccountId: string;
      claims: Array<Record<string, unknown>>;
      pagination: OffsetPagination;
    }>
  >(accountPath(accountId, '/ad-rewards/claims'), {
    params: { limit: params.limit ?? 20, offset: params.offset ?? 0 },
  });

  return response.data.data;
}
