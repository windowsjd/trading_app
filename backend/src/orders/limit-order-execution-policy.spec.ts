jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return { Prisma: { Decimal }, PrismaClient: class PrismaClient {} };
});

import { Prisma } from '../generated/prisma/client';
import {
  calculateBuyPositionAverageCost,
  calculateLimitFillAmounts,
  calculateLimitSellFillAmounts,
  isFillWithinReservation,
} from './limit-order-execution-policy';

const d = (value: string | number) => new Prisma.Decimal(value);

describe('calculateLimitFillAmounts', () => {
  it('rounds gross → fee → net at the monetary scale (matches market policy)', () => {
    // 2 @ 90 = 180 gross, 0.1% fee = 0.18, net 180.18.
    const amounts = calculateLimitFillAmounts({
      executedPrice: d('90'),
      quantity: d('2'),
      reservationFeeRate: d('0.001'),
    });
    expect(amounts.grossAmount.toFixed(8)).toBe('180.00000000');
    expect(amounts.feeAmount.toFixed(8)).toBe('0.18000000');
    expect(amounts.netAmount.toFixed(8)).toBe('180.18000000');
  });

  it('uses the actual (path A) execution price, not the limit price', () => {
    const amounts = calculateLimitFillAmounts({
      executedPrice: d('90'),
      quantity: d('1'),
      reservationFeeRate: d('0.001'),
    });
    // 90 gross, 0.09 fee, 90.09 net — priced at 90, not a higher limit.
    expect(amounts.netAmount.toFixed(8)).toBe('90.09000000');
  });
});

describe('calculateLimitSellFillAmounts', () => {
  it('credits gross minus the pinned fee at the actual execution price', () => {
    const amounts = calculateLimitSellFillAmounts({
      executedPrice: d('120'),
      quantity: d('2'),
      reservationFeeRate: d('0.001'),
    });
    expect(amounts.grossAmount.toFixed(8)).toBe('240.00000000');
    expect(amounts.feeAmount.toFixed(8)).toBe('0.24000000');
    expect(amounts.netAmount.toFixed(8)).toBe('239.76000000');
  });
});

describe('isFillWithinReservation', () => {
  it('accepts a net at or below the reservation', () => {
    expect(isFillWithinReservation(d('90.09'), d('100.10'))).toBe(true);
    expect(isFillWithinReservation(d('100.10'), d('100.10'))).toBe(true);
  });

  it('rejects a net above the reservation', () => {
    expect(isFillWithinReservation(d('100.11'), d('100.10'))).toBe(false);
  });
});

describe('calculateBuyPositionAverageCost', () => {
  it('new position: average cost is the net paid per unit', () => {
    const result = calculateBuyPositionAverageCost({
      netAmount: d('180.18'),
      quantity: d('2'),
      existing: null,
    });
    expect(result.newQuantity.toFixed(8)).toBe('2.00000000');
    expect(result.newAverageCost.toFixed(8)).toBe('90.09000000');
  });

  it('existing position: cost-weighted blend of old and new', () => {
    // Old: 2 @ avg 100 (cost 200). New: 2 @ net 180.18. New avg = 380.18 / 4.
    const result = calculateBuyPositionAverageCost({
      netAmount: d('180.18'),
      quantity: d('2'),
      existing: { quantity: d('2'), averageCost: d('100') },
    });
    expect(result.newQuantity.toFixed(8)).toBe('4.00000000');
    expect(result.newAverageCost.toFixed(8)).toBe('95.04500000');
  });
});
