import { HttpException, HttpStatus } from '@nestjs/common';
import {
  AssetType,
  OrderSide,
  OrderType,
  Prisma,
} from '../generated/prisma/client';
import { monetaryScale, roundDecimalHalfUp } from '../fx/fx-decimal-policy';

export const orderInputQuantityScale = 6;

/**
 * What an order may be sized by:
 * - crypto Spot BUY: an amount only (the spend, fees excluded);
 * - crypto Spot SELL: an amount (the expected proceeds before fees, sold as
 *   the quantity the quote derives from it, 2026-11-10) or a quantity — one,
 *   never both. A position-bound exit (a protection child) sells its own
 *   quantity only;
 * - stocks, both sides: a quantity only.
 */
export function assertOrderInputPolicy(
  input: {
    assetType: AssetType;
    side: OrderSide;
    orderType: OrderType;
    quantity: Prisma.Decimal | null;
    amount: Prisma.Decimal | null;
  },
  options?: { positionBoundExit: boolean },
): void {
  const crypto = input.assetType === AssetType.crypto;
  const amountBuy = crypto && input.side === OrderSide.buy;
  const eitherSell =
    crypto && input.side === OrderSide.sell && !options?.positionBoundExit;
  if (
    amountBuy
      ? !input.amount || input.quantity !== null
      : eitherSell
        ? !input.amount === !input.quantity
        : !!input.amount || !input.quantity
  ) {
    reject(
      'INVALID_ORDER_INPUT',
      amountBuy
        ? 'Crypto BUY requires amount without quantity.'
        : eitherSell
          ? 'Crypto SELL requires an amount or a quantity, never both.'
          : 'This order requires quantity without amount.',
    );
  }
  if (
    (input.assetType === AssetType.domestic_stock ||
      input.assetType === AssetType.us_stock) &&
    input.orderType === OrderType.limit &&
    !(options?.positionBoundExit && input.side === OrderSide.sell) &&
    input.quantity &&
    !input.quantity.isInteger()
  ) {
    reject(
      'FRACTIONAL_LIMIT_ORDER_NOT_SUPPORTED',
      'Fractional stock quantities are supported only for market orders.',
    );
  }
}

/** Gross principal intent, excluding fees: a BUY's spend or a crypto SELL's
 * expected proceeds. The quantity floors to 6 decimals, so the notional at
 * `price` never exceeds the amount (a BUY never overspends, a SELL never
 * sells more than asked). Local precision covers two Decimal(24,8) values
 * without changing the shared Prisma Decimal arithmetic/fee policy elsewhere
 * in the application. */
export function quantityFromAmount(
  amount: Prisma.Decimal,
  price: Prisma.Decimal,
): Prisma.Decimal {
  const D = Prisma.Decimal.clone({ precision: 50 });
  const quantity = new Prisma.Decimal(
    new D(amount.toString())
      .div(price.toString())
      .toDecimalPlaces(orderInputQuantityScale, Prisma.Decimal.ROUND_DOWN)
      .toFixed(orderInputQuantityScale),
  );
  if (
    !quantity.isFinite() ||
    quantity.lte(0) ||
    quantity.gt('9999999999999999.99999999') ||
    roundDecimalHalfUp(quantity.mul(price), monetaryScale).lte(0) ||
    roundDecimalHalfUp(quantity.mul(price), monetaryScale).gt(amount)
  ) {
    reject(
      'INVALID_AMOUNT',
      'amount cannot produce a positive quantity and notional within the supported precision.',
    );
  }
  return quantity;
}

function reject(code: string, message: string): never {
  throw new HttpException(
    { success: false, error: { code, message } },
    HttpStatus.BAD_REQUEST,
  );
}
