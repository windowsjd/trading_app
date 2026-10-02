import { MARKET_REMAINDER_CANCEL_REASON } from './market-execution-evidence.adapter';
import {
  CurrencyCode,
  OrderSide,
  OrderStatus,
  OrderType,
  Prisma,
} from '../generated/prisma/client';
import { formatDecimalScale, monetaryScale } from '../fx/fx-decimal-policy';

export const orderQuantityScale = 6;

/**
 * Shared order → API payload presenter used by the market flow
 * (OrdersService) and the limit-buy services, so both emit one shape.
 * Reservation fields are optional inputs: market call sites that never
 * select them keep working and simply present null.
 */
export type OrderResponseRecord = {
  id: string;
  quoteId?: string | null;
  side: OrderSide;
  orderType: OrderType;
  status: OrderStatus;
  quantity: Prisma.Decimal;
  executedQuantity?: Prisma.Decimal | null;
  canceledQuantity?: Prisma.Decimal | null;
  requestedAmount?: Prisma.Decimal | null;
  unspentAmount?: Prisma.Decimal | null;
  limitPrice: Prisma.Decimal | null;
  executedPrice: Prisma.Decimal | null;
  currencyCode: CurrencyCode;
  grossAmount: Prisma.Decimal | null;
  feeAmount: Prisma.Decimal | null;
  netAmount: Prisma.Decimal | null;
  assetPriceSnapshotId: string | null;
  fxRateSnapshotId: string | null;
  reservedAmount?: Prisma.Decimal | null;
  reservedQuantity?: Prisma.Decimal | null;
  reservationReleasedAt?: Date | null;
  cancelReason?: string | null;
  submittedAt: Date;
  executedAt: Date | null;
  canceledAt: Date | null;
  rejectedAt: Date | null;
  rejectReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  asset: {
    id: string;
    symbol: string;
    name: string;
    market: string;
    currencyCode: CurrencyCode;
  };
};

export type OrderResponsePayload = ReturnType<typeof formatOrderResponse>;

export function formatOrderResponse(order: OrderResponseRecord) {
  return {
    orderId: order.id,
    quoteId: order.quoteId ?? null,
    asset: order.asset,
    side: order.side,
    orderType: order.orderType,
    status: order.status,
    quantity: formatDecimalScale(order.quantity, orderQuantityScale),
    ...presentMarketExecution(order),
    limitPrice: formatNullableDecimal(order.limitPrice),
    executedPrice: formatNullableDecimal(order.executedPrice),
    currencyCode: order.currencyCode,
    grossAmount: formatNullableDecimal(order.grossAmount),
    feeAmount: formatNullableDecimal(order.feeAmount),
    netAmount: formatNullableDecimal(order.netAmount),
    assetPriceSnapshotId: order.assetPriceSnapshotId,
    fxRateSnapshotId: order.fxRateSnapshotId,
    reservedAmount: formatNullableDecimal(order.reservedAmount ?? null),
    reservedQuantity: formatNullableDecimal(order.reservedQuantity ?? null),
    reservationReleasedAt: formatNullableDate(
      order.reservationReleasedAt ?? null,
    ),
    cancelReason: order.cancelReason ?? null,
    submittedAt: order.submittedAt.toISOString(),
    executedAt: formatNullableDate(order.executedAt),
    canceledAt: formatNullableDate(order.canceledAt),
    rejectedAt: formatNullableDate(order.rejectedAt),
    rejectReason: order.rejectReason,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

function formatNullableDecimal(value: Prisma.Decimal | null): string | null {
  return value ? formatDecimalScale(value, monetaryScale) : null;
}

function formatNullableDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export const MARKET_EXECUTION_SELECT = {
  executedQuantity: true,
  canceledQuantity: true,
  requestedAmount: true,
  unspentAmount: true,
} as const;

type MarketExecutionRecord = Pick<
  OrderResponseRecord,
  | 'quantity'
  | 'executedQuantity'
  | 'canceledQuantity'
  | 'requestedAmount'
  | 'unspentAmount'
  | 'cancelReason'
  | 'canceledAt'
>;

/** Old rows deliberately omit the additive result; no historical backfill. */
export function presentMarketExecution(order: MarketExecutionRecord) {
  if (order.executedQuantity == null) return {};
  return {
    marketExecution: {
      status:
        order.cancelReason === MARKET_REMAINDER_CANCEL_REASON
          ? ('partial' as const)
          : ('full' as const),
      requestedQuantity:
        order.requestedAmount == null
          ? formatDecimalScale(order.quantity, orderQuantityScale)
          : null,
      executedQuantity: formatDecimalScale(
        order.executedQuantity,
        orderQuantityScale,
      ),
      canceledQuantity:
        order.canceledQuantity == null
          ? null
          : formatDecimalScale(order.canceledQuantity, orderQuantityScale),
      requestedAmount: formatNullableDecimal(order.requestedAmount ?? null),
      unspentAmount: formatNullableDecimal(order.unspentAmount ?? null),
      remainderCancelReason: order.cancelReason ?? null,
      remainderCanceledAt: formatNullableDate(order.canceledAt),
    },
  };
}
