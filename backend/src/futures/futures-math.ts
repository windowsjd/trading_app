import { HttpStatus } from '@nestjs/common';
import {
  Prisma,
  type FuturesPosition,
  type FuturesDirection,
} from '../generated/prisma/client';
import { roundDecimalHalfUp, monetaryScale } from '../fx/fx-decimal-policy';
import type { FuturesCommand } from './futures-input';
import { futuresError } from './futures-error';

// Local precision: do not mutate Prisma Decimal's global defaults used by Spot/FX.
const CalculationDecimal = Prisma.Decimal.clone({ precision: 60 });
export const futuresDecimal = (value: Prisma.Decimal | string) =>
  new CalculationDecimal(value.toString());
const money = (value: Prisma.Decimal) =>
  roundDecimalHalfUp(value, monetaryScale);
const marginCeil = (value: Prisma.Decimal) =>
  value.toDecimalPlaces(monetaryScale, Prisma.Decimal.ROUND_CEIL);
const maxMoney = new CalculationDecimal('9999999999999999.99999999');

export function assertFuturesMoney(value: Prisma.Decimal): Prisma.Decimal {
  if (!value.isFinite() || value.abs().gt(maxMoney))
    futuresError(
      'FUTURES_VALUE_OUT_OF_RANGE',
      'Calculated value exceeds the financial Decimal range.',
      HttpStatus.BAD_REQUEST,
    );
  return value;
}

export function futuresPnl(
  direction: FuturesDirection,
  entry: Prisma.Decimal,
  exit: Prisma.Decimal,
  quantity: Prisma.Decimal,
) {
  const delta = futuresDecimal(exit).sub(entry);
  return assertFuturesMoney(
    money(delta.mul(quantity).mul(direction === 'long' ? 1 : -1)),
  );
}

type PositionBasis = Pick<
  FuturesPosition,
  | 'id'
  | 'direction'
  | 'quantity'
  | 'averageEntryPrice'
  | 'entryNotional'
  | 'leverage'
  | 'isolatedMargin'
  | 'realizedPnl'
>;

export function planFuturesExecution(
  command: FuturesCommand,
  current: PositionBasis | null,
  price: Prisma.Decimal,
  feeRate: Prisma.Decimal,
) {
  const quantity = futuresDecimal(command.quantity);
  const rawNotional = quantity.mul(price);
  const notional = assertFuturesMoney(money(rawNotional));
  if (notional.lte(0))
    futuresError(
      'FUTURES_VALUE_TOO_SMALL',
      'Executed notional must be positive at the cash scale.',
      HttpStatus.BAD_REQUEST,
    );
  if (
    !feeRate.isFinite() ||
    feeRate.lt(0) ||
    feeRate.gt(1) ||
    feeRate.decimalPlaces() > 6
  )
    futuresError(
      'FUTURES_FEE_POLICY_INVALID',
      'Account trade fee policy is invalid.',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  const feeAmount = assertFuturesMoney(
    money(futuresDecimal(notional).mul(feeRate)),
  );
  if (command.operation === 'open') {
    if (current)
      futuresError(
        'FUTURES_POSITION_ALREADY_OPEN',
        'Close the existing one-way position before opening another.',
      );
    return {
      quantity,
      averageEntryPrice: futuresDecimal(price),
      entryNotional: rawNotional,
      isolatedMargin: assertFuturesMoney(
        marginCeil(rawNotional.div(command.leverage)),
      ),
      realizedPnl: futuresDecimal('0'),
      cumulativeRealizedPnl: futuresDecimal('0'),
      notional,
      feeAmount,
      status: 'open' as const,
    };
  }
  if (!current || current.id !== command.positionId)
    futuresError(
      'FUTURES_POSITION_NOT_FOUND',
      'The intended open position was not found.',
      HttpStatus.NOT_FOUND,
    );
  if (current.direction !== command.direction)
    futuresError(
      'FUTURES_ONE_WAY_VIOLATION',
      'Direction must match the existing one-way position.',
    );
  if (current.leverage !== command.leverage)
    futuresError(
      'FUTURES_LEVERAGE_MISMATCH',
      'Leverage is fixed for the open position lifetime.',
    );
  const oldQty = futuresDecimal(current.quantity);
  if (command.operation === 'increase') {
    const newQty = assertFuturesMoney(oldQty.add(quantity));
    const averageEntryPrice = assertFuturesMoney(
      money(oldQty.mul(current.averageEntryPrice).add(rawNotional).div(newQty)),
    );
    const entryNotional = futuresDecimal(current.entryNotional).add(
      rawNotional,
    );
    return {
      quantity: newQty,
      averageEntryPrice,
      entryNotional,
      isolatedMargin: assertFuturesMoney(
        CalculationDecimal.max(
          current.isolatedMargin.toString(),
          marginCeil(entryNotional.div(command.leverage)),
        ),
      ),
      realizedPnl: futuresDecimal('0'),
      cumulativeRealizedPnl: futuresDecimal(current.realizedPnl),
      notional,
      feeAmount,
      status: 'open' as const,
    };
  }
  if (
    quantity.gt(oldQty) ||
    (command.operation === 'close' && !quantity.eq(oldQty))
  )
    futuresError(
      'INVALID_FUTURES_REDUCE_QUANTITY',
      'Reduce quantity cannot exceed the position; close must match it exactly.',
    );
  const remaining = oldQty.sub(quantity);
  const realizedPnl = futuresPnl(
    current.direction,
    current.averageEntryPrice,
    price,
    quantity,
  );
  return {
    quantity: remaining,
    averageEntryPrice: futuresDecimal(current.averageEntryPrice),
    entryNotional: remaining.eq(0)
      ? futuresDecimal('0')
      : futuresDecimal(current.entryNotional)
          .mul(remaining)
          .div(oldQty)
          .toDecimalPlaces(16, Prisma.Decimal.ROUND_CEIL),
    isolatedMargin: remaining.eq(0)
      ? futuresDecimal('0')
      : marginCeil(
          futuresDecimal(current.isolatedMargin).mul(remaining).div(oldQty),
        ),
    realizedPnl,
    cumulativeRealizedPnl: assertFuturesMoney(
      money(futuresDecimal(current.realizedPnl).add(realizedPnl)),
    ),
    notional,
    feeAmount,
    status: remaining.eq(0) ? ('closed' as const) : ('open' as const),
  };
}
