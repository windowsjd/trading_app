jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

  return {
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
  };
});

import { validateEnv } from '../common/env-validation';
import { Prisma } from '../generated/prisma/client';
import {
  calculateAvailableAmount,
  calculateLimitBuyReservation,
  LIMIT_ORDER_CANCEL_REASONS,
  validateQuotedLimitReservationBasis,
} from './limit-order-policy';
import {
  isLimitOrderEnabled,
  LimitOrderConfigError,
  parseLimitOrderEnabled,
} from './limit-order.config';

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

function expectRejected(
  result: ReturnType<typeof validateQuotedLimitReservationBasis>,
  reasonFragment: string,
): void {
  if (result.ok) {
    throw new Error(`Expected rejection containing "${reasonFragment}".`);
  }
  expect(result.reason).toContain(reasonFragment);
}

describe('quoted limit reservation basis validation', () => {
  const limitPrice = new Prisma.Decimal('100');
  const quantity = new Prisma.Decimal('3');
  // 100 x 3 = 300 gross; 300 x 0.001 = 0.3 fee; 300.3 reserved.
  const validBasis = {
    quotedFeeRate: new Prisma.Decimal('0.001'),
    quotedGrossAmount: new Prisma.Decimal('300'),
    quotedFeeAmount: new Prisma.Decimal('0.3'),
    quotedReservedAmount: new Prisma.Decimal('300.3'),
  };

  it('accepts a basis that matches the canonical rounding chain', () => {
    const result = validateQuotedLimitReservationBasis({
      ...validBasis,
      limitPrice,
      quantity,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.basis.quotedReservedAmount.toFixed(8)).toBe('300.30000000');
      expect(result.basis.quotedFeeRate.toFixed(6)).toBe('0.001000');
    }
  });

  it.each([
    ['fee rate', 'quotedFeeRate'],
    ['gross amount', 'quotedGrossAmount'],
    ['fee amount', 'quotedFeeAmount'],
    ['reserved amount', 'quotedReservedAmount'],
  ])('rejects a quote missing its %s', (_label, field) => {
    const result = validateQuotedLimitReservationBasis({
      ...validBasis,
      [field]: null,
      limitPrice,
      quantity,
    });

    expectRejected(result, 'missing the pinned reservation basis');
  });

  it('rejects a negative or out-of-range fee rate', () => {
    expectRejected(
      validateQuotedLimitReservationBasis({
        ...validBasis,
        quotedFeeRate: new Prisma.Decimal('-0.001'),
        limitPrice,
        quantity,
      }),
      'valid range',
    );

    expectRejected(
      validateQuotedLimitReservationBasis({
        ...validBasis,
        quotedFeeRate: new Prisma.Decimal('1.5'),
        limitPrice,
        quantity,
      }),
      'valid range',
    );
  });

  it('rejects negative amounts', () => {
    expectRejected(
      validateQuotedLimitReservationBasis({
        ...validBasis,
        quotedFeeAmount: new Prisma.Decimal('-0.3'),
        limitPrice,
        quantity,
      }),
      'negative',
    );
  });

  it('rejects a zero reservation', () => {
    expectRejected(
      validateQuotedLimitReservationBasis({
        quotedFeeRate: new Prisma.Decimal('0'),
        quotedGrossAmount: new Prisma.Decimal('0'),
        quotedFeeAmount: new Prisma.Decimal('0'),
        quotedReservedAmount: new Prisma.Decimal('0'),
        limitPrice: new Prisma.Decimal('0'),
        quantity,
      }),
      'must be positive',
    );
  });

  it('rejects a stored basis that disagrees with limitPrice x quantity', () => {
    // A tampered/stale row: reserved does not follow from the pinned rate.
    expectRejected(
      validateQuotedLimitReservationBasis({
        ...validBasis,
        quotedReservedAmount: new Prisma.Decimal('1'),
        limitPrice,
        quantity,
      }),
      'canonical rounding chain',
    );

    expectRejected(
      validateQuotedLimitReservationBasis({
        ...validBasis,
        limitPrice: new Prisma.Decimal('101'),
        quantity,
      }),
      'canonical rounding chain',
    );
  });
});

describe('limit order feature flag', () => {
  it('defaults to false only when the variable is absent', () => {
    expect(isLimitOrderEnabled({})).toBe(false);
    expect(parseLimitOrderEnabled(undefined)).toBe(false);
  });

  it('accepts exactly true/false/1/0, trimmed and case-insensitive', () => {
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: 'false' })).toBe(false);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: '0' })).toBe(false);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: 'true' })).toBe(true);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: '1' })).toBe(true);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: 'TRUE' })).toBe(true);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: 'False' })).toBe(false);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: '  true  ' })).toBe(true);
    expect(isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: ' 0 ' })).toBe(false);
  });

  it('rejects every undefined spelling instead of silently disabling', () => {
    // A typo previously read as "off", which hides a flag the operator
    // believed they had set. These must now stop the process at startup.
    for (const raw of ['', ' ', 'tru', 'yes', 'no', 'enabled', 'on', 'off']) {
      expect(() => parseLimitOrderEnabled(raw)).toThrow(LimitOrderConfigError);
      expect(() => isLimitOrderEnabled({ LIMIT_ORDER_ENABLED: raw })).toThrow(
        /LIMIT_ORDER_ENABLED must be one of/,
      );
    }
  });

  it('startup validation rejects an invalid flag and passes a valid one', () => {
    expect(() => validateEnv({ LIMIT_ORDER_ENABLED: 'yes' })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => validateEnv({ LIMIT_ORDER_ENABLED: '' })).toThrow(
      /LIMIT_ORDER_ENABLED/,
    );
    expect(validateEnv({ LIMIT_ORDER_ENABLED: 'true' })).toEqual({
      LIMIT_ORDER_ENABLED: 'true',
    });
    expect(validateEnv({})).toEqual({});
  });
});
