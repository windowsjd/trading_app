import type { MarketExecutionDto } from './api';
import { formatDisplayDecimal } from '../../utils/format.ts';

/** Never infer a partial fill from client intent, amounts, or float subtraction. */
export function getMarketExecutionDisplay(
  result: MarketExecutionDto | null | undefined,
  currencyCode: string,
) {
  const partial = result?.status === 'partial';
  const amountOrder = result?.requestedAmount != null;
  const canceledQuantity = formatDisplayDecimal(result?.canceledQuantity);
  const unspentAmount = formatExecutionMoney(
    result?.unspentAmount,
    currencyCode,
  );
  return {
    isPartialExecution: partial,
    isAmountExecution: amountOrder,
    requestedQuantity: formatDisplayDecimal(result?.requestedQuantity),
    canceledQuantity,
    requestedAmount: formatExecutionMoney(
      result?.requestedAmount,
      currencyCode,
    ),
    unspentAmount,
    remainderMessage: !partial
      ? null
      : result.remainderCancelReason === 'insufficient_market_liquidity'
        ? amountOrder
          ? `시장 유동성 부족으로 사용되지 않은 주문 금액 ${unspentAmount}은 자동 취소되었습니다.`
          : `시장 유동성 부족으로 미체결 수량 ${canceledQuantity}은 자동 취소되었습니다.`
        : '미체결 잔량은 자동 취소되었습니다.',
  };
}

/** Actual execution decimals, including VWAP and sub-cent unused principal. */
export function formatExecutionMoney(
  value: string | null | undefined,
  currencyCode: string,
) {
  if (value == null) return '-';
  const decimal = formatDisplayDecimal(value);
  const [whole, fraction] = decimal.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const price = fraction ? `${grouped}.${fraction}` : grouped;
  return currencyCode === 'KRW'
    ? `${price}원`
    : currencyCode === 'USD'
      ? `$${price}`
      : price;
}
