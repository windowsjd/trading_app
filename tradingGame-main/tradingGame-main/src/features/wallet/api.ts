import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';

export type WalletCurrency = 'KRW' | 'USD';

export interface WalletBalanceDto {
  currency: WalletCurrency;
  balance: string;
  balanceKrw?: string;
}

export interface WalletsDto {
  wallets: WalletBalanceDto[];
}

export interface FxRateDto {
  pair: string;
  rate: string;
  feeRate: string;
  capturedAt: string;
}

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

export async function getCurrentFxRate(pair: string) {
  const response = await apiClient.get<ApiSuccessResponse<FxRateDto>>(
    `/fx/rates/current?pair=${pair}`,
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