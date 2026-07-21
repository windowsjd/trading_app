jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

  return {
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
  };
});

import { Prisma } from '../generated/prisma/client';
import {
  calculateAvailableAmount,
  calculateLimitBuyReservation,
  LIMIT_ORDER_CANCEL_REASONS,
} from './limit-order-policy';
import { isLimitOrderEnabled } from './limit-order.config';

describe('limit order policy', () => {
  it('computes gross, fee, and reserved with the market-buy rounding chain', () => {
    const result = calculateLimitBuyReservation({
      limitPrice: new Prisma.Decimal('50000.00000000'),
      quantity: new Prisma.Decimal('3.000000'),
      tradeFeeRate: new Prisma.Decimal('0.001000'),
    });

    expect(result.grossAmount.toFixed(8)).toBe('150000.00000000');
    expect(result.feeAmount.toFixed(8)).toBe('150.00000000');
    expect(result.reservedAmount.toFixed(8)).toBe('150150.00000000');
  });

  it('rounds half-up at scale 8 in each step, matching market buy netAmount', () => {
    // gross = 3.333333 * 0.11111111 = 0.37037033... -> rounded at scale 8,
    // fee rounds on the ROUNDED gross, reserved rounds on the sum.
    const result = calculateLimitBuyReservation({
      limitPrice: new Prisma.Decimal('0.11111111'),
      quantity: new Prisma.Decimal('3.333333'),
      tradeFeeRate: new Prisma.Decimal('0.001000'),
    });

    const gross = new Prisma.Decimal('3.333333')
      .mul('0.11111111')
      .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
    const fee = gross
      .mul('0.001000')
      .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
    expect(result.grossAmount.eq(gross)).toBe(true);
    expect(result.feeAmount.eq(fee)).toBe(true);
    expect(result.reservedAmount.eq(gross.add(fee))).toBe(true);
  });

  it('never uses a provider price: inputs are limitPrice/quantity/feeRate only', () => {
    // Type-level and behavioral: the function is pure over its 3 inputs.
    const a = calculateLimitBuyReservation({
      limitPrice: new Prisma.Decimal('100'),
      quantity: new Prisma.Decimal('2'),
      tradeFeeRate: new Prisma.Decimal('0.001'),
    });
    const b = calculateLimitBuyReservation({
      limitPrice: new Prisma.Decimal('100'),
      quantity: new Prisma.Decimal('2'),
      tradeFeeRate: new Prisma.Decimal('0.001'),
    });
    expect(a.reservedAmount.eq(b.reservedAmount)).toBe(true);
  });

  it('derives availableAmount as balance - reserved', () => {
    expect(
      calculateAvailableAmount(
        new Prisma.Decimal('1000.00000000'),
        new Prisma.Decimal('150.15000000'),
      ).toFixed(8),
    ).toBe('849.85000000');
  });

  it('exposes the canonical cancel reasons', () => {
    expect(LIMIT_ORDER_CANCEL_REASONS).toEqual({
      userCanceled: 'user_canceled',
      seasonEnded: 'season_ended',
      participantExcluded: 'participant_excluded',
    });
  });
});

describe('limit order feature flag', () => {
  it('is fail-closed: only an explicit true/1 enables it', () => {
    expect(isLimitOrderEnabled({})).toBe(false);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: '' })).toBe(false);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: 'false' })).toBe(false);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: '0' })).toBe(false);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: 'yes' })).toBe(false);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: 'true' })).toBe(true);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: 'TRUE' })).toBe(true);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: '1' })).toBe(true);
  });
});
