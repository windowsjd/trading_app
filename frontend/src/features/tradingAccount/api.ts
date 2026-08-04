import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  MoneyString,
  OffsetPagination,
  PercentString,
  SectionState,
} from '../../models/dto/common';
import type {
  FxExecuteDto,
  FxExecuteRequestDto,
  FxQuoteDto,
  FxQuoteRequestDto,
  WalletBalanceDto,
  WalletTransactionDto,
} from '../wallet/api';
import type { PositionItemDto } from '../position/api';
import type {
  CancelOrderDto,
  CreateOrderDto,
  CreateOrderRequestDto,
  OrderQuoteDto,
  OrderQuoteRequestDto,
} from '../order/api';
import { assertAccountScope } from './accountScope';

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

export interface OpenGeneralAccountDto {
  /** true only for the call that actually opened it; a replay answers false. */
  created: boolean;
  account: TradingAccountDto;
  wallets: WalletBalanceDto[];
}

/**
 * Opens the user's general account — the ONE place the app creates one
 * (작업 11 §3.3).
 *
 * A POST, always, and only from an explicit user action. Opening an account
 * grants starting capital and writes wallets and a ledger row; a screen that
 * did this on mount would hand out capital to anyone who scrolled past it, and
 * a GET that creates money is indistinguishable from a bug the first time it is
 * retried. The server is idempotent (one general account per user, `created`
 * tells the first open from a replay), so a double tap costs nothing.
 */
export async function openGeneralAccount() {
  const response = await apiClient.post<
    ApiSuccessResponse<OpenGeneralAccountDto>
  >('/trading-accounts/general');

  return response.data.data;
}

export async function getTradingAccount(accountId: string) {
  const response = await apiClient.get<ApiSuccessResponse<TradingAccountDto>>(
    accountPath(accountId),
  );

  // The detail payload identifies itself with `id`, not `tradingAccountId`, so
  // it is cross-checked here rather than through the shared helper.
  return assertAccountScope(
    'GET /trading-accounts/:accountId',
    accountId,
    { ...response.data.data, tradingAccountId: response.data.data.id },
  ) as TradingAccountDto;
}

export async function getTradingAccountPortfolio(accountId: string) {
  const response = await apiClient.get<
    ApiSuccessResponse<TradingAccountPortfolioDto>
  >(accountPath(accountId, '/portfolio'));

  return assertAccountScope(
    'GET /trading-accounts/:accountId/portfolio',
    accountId,
    response.data.data,
  );
}

export async function getTradingAccountEquity(
  accountId: string,
  range: TradingAccountEquityRange,
) {
  const response = await apiClient.get<
    ApiSuccessResponse<TradingAccountEquityDto>
  >(accountPath(accountId, '/portfolio/equity'), { params: { range } });

  return assertAccountScope(
    'GET /trading-accounts/:accountId/portfolio/equity',
    accountId,
    response.data.data,
  );
}

export async function getTradingAccountWallets(accountId: string) {
  const response = await apiClient.get<
    ApiSuccessResponse<TradingAccountWalletsDto>
  >(accountPath(accountId, '/wallets'));

  return assertAccountScope(
    'GET /trading-accounts/:accountId/wallets',
    accountId,
    response.data.data,
  );
}

export interface TradingAccountWalletTransactionsDto {
  tradingAccountId: string;
  filters?: Record<string, unknown>;
  items: WalletTransactionDto[];
  pagination: OffsetPagination;
}

export interface TradingAccountWalletTransactionsParams {
  currency?: string;
  direction?: string;
  txType?: string;
  limit?: number;
  offset?: number;
}

export async function getTradingAccountWalletTransactions(
  accountId: string,
  params: TradingAccountWalletTransactionsParams = {},
) {
  const response = await apiClient.get<
    ApiSuccessResponse<TradingAccountWalletTransactionsDto>
  >(accountPath(accountId, '/wallet-transactions'), {
    params: {
      ...(params.currency ? { currency: params.currency } : {}),
      ...(params.direction ? { direction: params.direction } : {}),
      ...(params.txType ? { txType: params.txType } : {}),
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
    },
  });

  return assertAccountScope(
    'GET /trading-accounts/:accountId/wallet-transactions',
    accountId,
    response.data.data,
  );
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

  return assertAccountScope(
    'GET /trading-accounts/:accountId/positions',
    accountId,
    response.data.data,
  );
}

/**
 * The one position this screen is about, from an account-scoped read.
 *
 * Kept next to the request rather than reusing the legacy
 * `getPositionForAsset` so there is no shape in which a legacy
 * (current-participant) positions response can be fed to an account-scoped
 * screen (작업 10 §A-3).
 */
export function findAccountPosition(
  positions: TradingAccountPositionsDto | null | undefined,
  assetId: string,
): PositionItemDto | null {
  return (
    positions?.positions.find((position) => position.assetId === assetId) ?? null
  );
}

export function getAccountPositionQuantity(
  positions: TradingAccountPositionsDto | null | undefined,
  assetId: string,
) {
  return findAccountPosition(positions, assetId)?.quantity ?? '0';
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

  return assertAccountScope(
    'GET /trading-accounts/:accountId/orders',
    accountId,
    response.data.data,
  );
}

export interface TradingAccountOrderDetailDto {
  order: Record<string, unknown>;
  execution?: Record<string, unknown> | null;
  tradingAccountId?: string;
}

export async function getTradingAccountOrder(
  accountId: string,
  orderId: string,
) {
  const response = await apiClient.get<
    ApiSuccessResponse<TradingAccountOrderDetailDto>
  >(accountPath(accountId, `/orders/${encodeURIComponent(orderId)}`));

  return assertAccountScope(
    'GET /trading-accounts/:accountId/orders/:orderId',
    accountId,
    response.data.data,
  );
}

export async function getAdRewardEligibility(accountId: string) {
  const response = await apiClient.get<
    ApiSuccessResponse<AdRewardEligibilityDto>
  >(accountPath(accountId, '/ad-rewards/eligibility'));

  return assertAccountScope(
    'GET /trading-accounts/:accountId/ad-rewards/eligibility',
    accountId,
    response.data.data,
  );
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

  return assertAccountScope(
    'GET /trading-accounts/:accountId/ad-rewards/claims',
    accountId,
    response.data.data,
  );
}

/* ------------------------------------------------------------------------ *
 * Account-scoped MUTATIONS (작업 10 §A-11)
 *
 * These are the existing 작업 4·5·6 routes; nothing here invents an endpoint.
 * Each takes the accountId as its FIRST argument rather than reading a
 * selected account from context, so the account a mutation acts on is decided
 * by the caller at the moment the flow started — not by whatever happens to be
 * selected when the request finally goes out. That distinction is the whole
 * protection against a switch mid-flow moving a user's money in the wrong
 * account.
 *
 * The request bodies are identical to the legacy surfaces (same service cores
 * server-side); only the path differs.
 * ------------------------------------------------------------------------ */

export async function quoteTradingAccountOrder(
  accountId: string,
  payload: OrderQuoteRequestDto,
) {
  const response = await apiClient.post<ApiSuccessResponse<OrderQuoteDto>>(
    accountPath(accountId, '/orders/quote'),
    payload,
  );

  return assertAccountScope(
    'POST /trading-accounts/:accountId/orders/quote',
    accountId,
    response.data.data,
  );
}

export async function createTradingAccountOrder(
  accountId: string,
  payload: CreateOrderRequestDto,
) {
  const response = await apiClient.post<ApiSuccessResponse<CreateOrderDto>>(
    accountPath(accountId, '/orders'),
    payload,
  );

  return assertAccountScope(
    'POST /trading-accounts/:accountId/orders',
    accountId,
    response.data.data,
  );
}

/**
 * Cancel releases a reservation, so the backend deliberately allows it on
 * suspended and closed accounts too — blocking it client-side would strand a
 * user's own money behind a screen they can still read.
 */
export async function cancelTradingAccountOrder(
  accountId: string,
  orderId: string,
) {
  const response = await apiClient.post<ApiSuccessResponse<CancelOrderDto>>(
    accountPath(accountId, `/orders/${encodeURIComponent(orderId)}/cancel`),
  );

  return assertAccountScope(
    'POST /trading-accounts/:accountId/orders/:orderId/cancel',
    accountId,
    response.data.data,
  );
}

export async function quoteTradingAccountFx(
  accountId: string,
  payload: FxQuoteRequestDto,
) {
  const response = await apiClient.post<ApiSuccessResponse<FxQuoteDto>>(
    accountPath(accountId, '/fx/quote'),
    payload,
  );

  return assertAccountScope(
    'POST /trading-accounts/:accountId/fx/quote',
    accountId,
    response.data.data,
  );
}

export async function executeTradingAccountFx(
  accountId: string,
  payload: FxExecuteRequestDto,
) {
  const response = await apiClient.post<ApiSuccessResponse<FxExecuteDto>>(
    accountPath(accountId, '/fx/execute'),
    payload,
  );

  return assertAccountScope(
    'POST /trading-accounts/:accountId/fx/execute',
    accountId,
    response.data.data,
  );
}

export interface AdRewardClaimRequestDto {
  idempotencyKey: string;
  provider?: string;
  proof?: string;
}

export async function claimAdReward(
  accountId: string,
  payload: AdRewardClaimRequestDto,
) {
  const response = await apiClient.post<
    ApiSuccessResponse<Record<string, unknown>>
  >(accountPath(accountId, '/ad-rewards/claim'), payload);

  return assertAccountScope(
    'POST /trading-accounts/:accountId/ad-rewards/claim',
    accountId,
    response.data.data,
  );
}
