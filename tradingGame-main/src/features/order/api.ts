import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';

export type OrderSide = 'buy' | 'sell';

export interface OrderQuoteRequestDto {
  assetId: string;
  side: OrderSide;
  quantity: string;
}

export interface OrderQuoteDto {
  assetId: string;
  side: OrderSide;
  quantity: string;
  fillPriceLocal: string;
  fillCurrency: 'KRW' | 'USD';
  feeAmountLocal: string;
  netAmountLocal: string;
  walletBalanceAfter: string;
  expiresAt: string;
}

export interface CreateOrderRequestDto {
  assetId: string;
  side: OrderSide;
  quantity: string;
}

export interface CreateOrderDto {
  orderId: string;
  assetId: string;
  side: OrderSide;
  quantity: string;
  fillPriceLocal: string;
  fillCurrency: 'KRW' | 'USD';
  feeAmountLocal: string;
  netAmountLocal: string;
  executedAt: string;
  walletsAfter: {
    KRW: string;
    USD: string;
  };
}

export async function quoteOrder(payload: OrderQuoteRequestDto) {
  const response = await apiClient.post<ApiSuccessResponse<OrderQuoteDto>>(
    '/orders/quote',
    payload,
  );

  return response.data.data;
}

export async function createOrder(payload: CreateOrderRequestDto) {
  const response = await apiClient.post<ApiSuccessResponse<CreateOrderDto>>(
    '/orders',
    payload,
  );

  return response.data.data;
}