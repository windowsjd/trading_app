import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  BpsString,
  IsoDateTimeString,
  MoneyString,
  OffsetPagination,
  RateString,
  SectionState,
  SourceMetadata,
} from '../../models/dto/common';

export type WalletCurrency = 'KRW' | 'USD';
export type WalletState = SectionState;

export interface WalletBalanceDto {
  currencyCode: WalletCurrency;
  /** Total owned cash (unchanged by limit-order reservations). */
  balanceAmount: MoneyString;
  /** Cash locked by submitted limit-buy orders (additive, server-computed). */
  reservedAmount?: MoneyString;
  /** balanceAmount - reservedAmount; spendable for new orders/FX. */
  availableAmount?: MoneyString;
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
  rateSource: SourceMetadata;
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
  rateSource: SourceMetadata;
}

export type WalletTransactionDirection = 'credit' | 'debit';

type BackendWalletTransactionDto = {
  id: string;
  currencyCode: WalletCurrency;
  direction: string;
  txType: string;
  referenceType: string;
  referenceId: string | null;
  amount: MoneyString;
  balanceAfter: MoneyString;
  occurredAt: IsoDateTimeString;
  createdAt: IsoDateTimeString;
};

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
  state: WalletState;
  season: WalletSeasonDto | null;
  participant: WalletParticipantDto | null;
  filters?: {
    currency: WalletCurrency | null;
    direction: WalletTransactionDirection | null;
    txType: string | null;
  };
  items: WalletTransactionDto[];
  pagination: OffsetPagination;
  reason?: string;
  message?: string;
}

export interface GetWalletTransactionsParams {
  currency?: WalletCurrency;
  limit?: number;
  offset?: number;
  direction?: WalletTransactionDirection;
  txType?: string;
}

type BackendWalletTransactionsResponseDto = {
  state: WalletState;
  season: WalletSeasonDto | null;
  participant: WalletParticipantDto | null;
  filters?: {
    currency: WalletCurrency | null;
    direction: WalletTransactionDirection | null;
    txType: string | null;
  };
  transactions: BackendWalletTransactionDto[];
  pagination: OffsetPagination;
  reason?: string;
  message?: string;
};

function normalizeWalletTransaction(
  item: BackendWalletTransactionDto | WalletTransactionDto,
): WalletTransactionDto {
  return {
    transactionId: 'transactionId' in item ? item.transactionId : item.id,
    walletId: 'walletId' in item ? item.walletId : undefined,
    currencyCode: item.currencyCode,
    direction: item.direction === 'credit' ? 'credit' : 'debit',
    txType: item.txType,
    referenceType: item.referenceType ?? null,
    referenceId: item.referenceId ?? null,
    amount: item.amount,
    balanceAfter: item.balanceAfter,
    occurredAt: item.occurredAt,
    createdAt: item.createdAt,
  };
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
  data: BackendWalletTransactionsResponseDto,
  limit: number,
  offset: number,
): WalletTransactionsDto {
  const items = data.transactions.map(normalizeWalletTransaction);

  return {
    state: data.state,
    season: data.season,
    participant: data.participant,
    filters: data.filters,
    items,
    pagination:
      data.pagination ?? buildFallbackPagination(limit, offset, items.length),
    reason: data.reason,
    message: data.message,
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

  if (params.currency) {
    searchParams.set('currency', params.currency);
  }
  if (params.direction) {
    searchParams.set('direction', params.direction);
  }
  if (params.txType) {
    searchParams.set('txType', params.txType);
  }
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));

  const response = await apiClient.get<
    ApiSuccessResponse<BackendWalletTransactionsResponseDto>
  >(`/wallets/transactions?${searchParams.toString()}`);

  return normalizeWalletTransactions(response.data.data, limit, offset);
}
