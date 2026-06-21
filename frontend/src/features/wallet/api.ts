import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  IsoDateTimeString,
  MoneyString,
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

// TODO: Migrate FX quote payloads to the v2 sourceAmount contract in the FX task.
export interface FxQuoteRequestDto {
  fromCurrency: WalletCurrency;
  toCurrency: WalletCurrency;
  amount: string;
}

export interface FxQuoteDto {
  fromCurrency: WalletCurrency;
  toCurrency: WalletCurrency;
  sourceAmount: string;
  rate: string;
  feeAmount: string;
  netTargetAmount: string;
  expiresAt: string;
}

// TODO: Migrate FX execute to /fx/execute with idempotency in the FX task.
export interface FxExecuteRequestDto {
  fromCurrency: WalletCurrency;
  toCurrency: WalletCurrency;
  amount: string;
}

export interface FxExecuteDto {
  fromCurrency: WalletCurrency;
  toCurrency: WalletCurrency;
  sourceAmount: string;
  rate: string;
  feeAmount: string;
  netTargetAmount: string;
  executedAt: string;
  walletsAfter: {
    KRW: string;
    USD: string;
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
    '/fx/exchanges',
    payload,
  );

  return response.data.data;
}
