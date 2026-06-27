import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  BpsString,
  IsoDateTimeString,
  MoneyString,
  OffsetPagination,
  RateString,
  SectionState,
} from '../../models/dto/common';

export type WalletCurrency = 'KRW' | 'USD';
export type WalletState = SectionState;

export interface WalletBalanceDto {
  currencyCode: WalletCurrency;
  balanceAmount: MoneyString;
  updatedAt?: IsoDateTimeString;
  // Legacy fallback fields until all wallet consumers are on v2.
  currency?: WalletCurrency;
  balance?: MoneyString;
}

export interface WalletSeasonDto {
  id?: string;
  name?: string;
  status?: string;
  startAt?: IsoDateTimeString;
  endAt?: IsoDateTimeString;
}

export interface WalletParticipantDto {
  id?: string;
  seasonId?: string;
  joinedAt?: IsoDateTimeString | null;
}

export interface WalletSummaryDto {
  totalKrw?: MoneyString;
  krwCash?: MoneyString;
  usdCash?: MoneyString;
  usdCashKrw?: MoneyString;
}

export interface WalletsDto {
  state: WalletState;
  season?: WalletSeasonDto | null;
  participant?: WalletParticipantDto | null;
  wallets: WalletBalanceDto[];
  summary?: WalletSummaryDto | null;
  blockedReason?: string | null;
  error?: {
    code?: string;
    message?: string;
  } | null;
  message?: string | null;
}

export interface FxRateDto {
  state: SectionState;
  pair?: string;
  baseCurrency: WalletCurrency;
  quoteCurrency: WalletCurrency;
  rate: RateString;
  sourceType?: string;
  sourceName?: string;
  effectiveAt?: IsoDateTimeString;
  capturedAt?: IsoDateTimeString;
  freshnessAgeSeconds?: number;
  providerPriority?: number;
  fallbackUsed?: boolean;
}

export interface FxQuoteRequestDto {
  fromCurrency: WalletCurrency;
  toCurrency: WalletCurrency;
  sourceAmount: MoneyString;
}

export interface FxQuoteDto {
  quoteId: string;
  fromCurrency: WalletCurrency;
  toCurrency: WalletCurrency;
  sourceAmount: MoneyString;
  appliedRate: RateString;
  grossTargetAmount: MoneyString;
  feeRate: RateString;
  feeAmount: MoneyString;
  feeCurrency: WalletCurrency;
  netTargetAmount: MoneyString;
  expiresAt: IsoDateTimeString;
  maxChangeBps: BpsString | number;
  rateCapturedAt: IsoDateTimeString;
  rateEffectiveAt: IsoDateTimeString;
  rateSource: string | null;
}

export interface FxExecuteRequestDto {
  quoteId: string;
  fromCurrency: WalletCurrency;
  toCurrency: WalletCurrency;
  sourceAmount: MoneyString;
  idempotencyKey: string;
}

export interface FxExecuteDto {
  exchangeId: string;
  executedAt: IsoDateTimeString;
  fromCurrency: WalletCurrency;
  toCurrency: WalletCurrency;
  sourceAmount: MoneyString;
  grossTargetAmount: MoneyString;
  feeRate: RateString;
  feeAmount: MoneyString;
  feeCurrency: WalletCurrency;
  appliedRate: RateString;
  quoteId: string;
  quotedRate: RateString;
  executeRate: RateString;
  rateChangeBps: BpsString | number;
  idempotencyKey: string;
  netTargetAmount: MoneyString;
  sourceWalletBalanceAfter: MoneyString;
  targetWalletBalanceAfter: MoneyString;
  wallets?: Partial<Record<WalletCurrency, MoneyString>> | WalletBalanceDto[] | null;
  rateSource: string | null;
}

export type WalletTransactionDirection = 'credit' | 'debit';

export interface WalletTransactionDto {
  transactionId: string;
  walletId?: string;
  currencyCode: WalletCurrency;
  direction: WalletTransactionDirection;
  txType: string;
  referenceType?: string | null;
  referenceId?: string | null;
  amount: MoneyString;
  balanceAfter: MoneyString;
  occurredAt: IsoDateTimeString;
  createdAt?: IsoDateTimeString;
}

export interface WalletTransactionsDto {
  items: WalletTransactionDto[];
  pagination: OffsetPagination;
}

export interface GetWalletTransactionsParams {
  currencyCode?: WalletCurrency;
  txType?: string;
  direction?: WalletTransactionDirection;
  limit?: number;
  offset?: number;
}

function buildFallbackPagination(
  limit: number,
  offset: number,
  returned: number,
): OffsetPagination {
  return {
    limit,
    offset,
    total: offset + returned,
    returned,
    nextOffset: returned >= limit ? offset + returned : null,
  };
}

function normalizeWalletTransactions(
  data: WalletTransactionsDto & {
    transactions?: WalletTransactionDto[];
  },
  limit: number,
  offset: number,
): WalletTransactionsDto {
  const items = data.items ?? data.transactions ?? [];

  return {
    items,
    pagination:
      data.pagination ?? buildFallbackPagination(limit, offset, items.length),
  };
}

export async function getWallets() {
  const response = await apiClient.get<ApiSuccessResponse<WalletsDto>>(
    '/wallets',
  );

  return response.data.data;
}

export async function getCurrentFxRate(
  baseCurrency: WalletCurrency = 'USD',
  quoteCurrency: WalletCurrency = 'KRW',
  refresh = false,
) {
  const response = await apiClient.get<ApiSuccessResponse<FxRateDto>>(
    '/fx/rates/current',
    {
      params: {
        baseCurrency,
        quoteCurrency,
        refresh,
      },
    },
  );

  return response.data.data;
}

export async function quoteFx(payload: FxQuoteRequestDto) {
  const response = await apiClient.post<ApiSuccessResponse<FxQuoteDto>>(
    '/fx/quote',
    payload,
  );

  return response.data.data;
}

export async function executeFx(payload: FxExecuteRequestDto) {
  const response = await apiClient.post<ApiSuccessResponse<FxExecuteDto>>(
    '/fx/execute',
    payload,
  );

  return response.data.data;
}

export async function getWalletTransactions(
  params: GetWalletTransactionsParams = {},
) {
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;
  const searchParams = new URLSearchParams();

  if (params.currencyCode) {
    searchParams.set('currencyCode', params.currencyCode);
  }
  if (params.txType) searchParams.set('txType', params.txType);
  if (params.direction) searchParams.set('direction', params.direction);
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));

  const response = await apiClient.get<
    ApiSuccessResponse<
      WalletTransactionsDto & {
        transactions?: WalletTransactionDto[];
      }
    >
  >(`/wallets/transactions?${searchParams.toString()}`);

  return normalizeWalletTransactions(response.data.data, limit, offset);
}
