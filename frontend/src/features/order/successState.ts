import type { CreateOrderDto, OrderQuoteDto } from './api';

export interface OrderSuccessState {
  data: CreateOrderDto | null;
  quote: OrderQuoteDto | null;
}

export const EMPTY_ORDER_SUCCESS_STATE: OrderSuccessState = {
  data: null,
  quote: null,
};

export function captureOrderSuccess(
  data: CreateOrderDto,
  quote: OrderQuoteDto | null,
): OrderSuccessState {
  return { data, quote };
}

export function clearOrderSuccess(): OrderSuccessState {
  return EMPTY_ORDER_SUCCESS_STATE;
}
