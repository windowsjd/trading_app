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
  limitPrice: Prisma.Decimal | null;
  executedPrice: Prisma.Decimal | null;
  currencyCode: CurrencyCode;
  grossAmount: Prisma.Decimal | null;
  feeAmount: Prisma.Decimal | null;
  netAmount: Prisma.Decimal | null;
  assetPriceSnapshotId: string | null;
  fxRateSnapshotId: string | null;
  reservedAmount?: Prisma.Decimal | null;
  reservationReleasedAt?: Date | null;
  cancelReason?: string | null;
  triggerEventId?: string | null;
  triggerEventAt?: Date | null;
  matchedAt?: Date | null;
  matchingSource?: string | null;
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
    limitPrice: formatNullableDecimal(order.limitPrice),
    executedPrice: formatNullableDecimal(order.executedPrice),
    currencyCode: order.currencyCode,
    grossAmount: formatNullableDecimal(order.grossAmount),
    feeAmount: formatNullableDecimal(order.feeAmount),
    netAmount: formatNullableDecimal(order.netAmount),
    assetPriceSnapshotId: order.assetPriceSnapshotId,
    fxRateSnapshotId: order.fxRateSnapshotId,
    reservedAmount: formatNullableDecimal(order.reservedAmount ?? null),
    reservationReleasedAt: formatNullableDate(
      order.reservationReleasedAt ?? null,
    ),
    cancelReason: order.cancelReason ?? null,
    triggerEventId: order.triggerEventId ?? null,
    triggerEventAt: formatNullableDate(order.triggerEventAt ?? null),
    matchedAt: formatNullableDate(order.matchedAt ?? null),
    matchingSource: order.matchingSource ?? null,
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
