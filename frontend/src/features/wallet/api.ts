import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  BpsString,
  IsoDateTimeString,
  MoneyString,
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

export type WalletTransactionType =
  | 'initial_grant' | 'exchange_source' | 'exchange_target'
  | 'order_buy' | 'order_sell' | 'fee' | 'adjustment' | 'settlement' | 'ad_reward';
/** `exchange` groups two canonical wallet legs; it is never a stored txType. */
export type WalletTransactionFilter = WalletTransactionType | 'exchange';

export interface WalletTransactionFiltersDto {
  currency: WalletCurrency | null;
  direction: WalletTransactionDirection | null;
  txType: WalletTransactionFilter | null;
}

export interface WalletTransactionDto {
  id: string;
  currencyCode: WalletCurrency;
  direction: WalletTransactionDirection;
  /** Canonical DB value. Unknown historical/future values remain visible. */
  txType: string;
  referenceType: string;
  referenceId: string | null;
  amount: MoneyString;
  balanceAfter: MoneyString;
  occurredAt: IsoDateTimeString;
  createdAt: IsoDateTimeString;
  asset: {
    id: string;
    name: string;
    symbol: string;
    assetType: 'domestic_stock' | 'us_stock' | 'crypto';
  } | null;
  trade: { quantity: string } | null;
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
