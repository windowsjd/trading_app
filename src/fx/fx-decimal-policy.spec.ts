jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    Prisma: {
      Decimal,
    },
  };
});

import { CurrencyCode } from '../generated/prisma/client';
import {
  calculateFeeAmount,
  calculateGrossTargetAmount,
  calculateNetTargetAmount,
  feeRateScale,
  formatDecimalScale,
  formatFeeRateScale6,
  formatMoneyScale8,
  isPositiveDecimalString,
  isValidDecimalString,
  monetaryScale,
  parsePositiveDecimalString,
} from './fx-decimal-policy';

describe('fx decimal policy', () => {
  it('formats monetary scale 8 strings', () => {
    expect(formatMoneyScale8('1000')).toBe('1000.00000000');
    expect(formatMoneyScale8('1000.0')).toBe('1000.00000000');
    expect(formatMoneyScale8('0.1')).toBe('0.10000000');
  });

  it('rounds half-up at scale 8 boundaries', () => {
    expect(formatDecimalScale('1.000000004', monetaryScale)).toBe(
      '1.00000000',
    );
    expect(formatDecimalScale('1.000000005', monetaryScale)).toBe(
      '1.00000001',
    );
  });

  it('formats fee rate at scale 6', () => {
    expect(feeRateScale).toBe(6);
    expect(formatFeeRateScale6('0.001')).toBe('0.001000');
  });

  it('calculates KRW to USD exact division', () => {
    expect(
      calculateGrossTargetAmount({
        fromCurrency: CurrencyCode.KRW,
        toCurrency: CurrencyCode.USD,
        sourceAmount: '135000',
        appliedRate: '1350.00000000',
      }),
    ).toBe('100.00000000');
  });

  it('calculates KRW to USD repeating decimal with half-up scale 8', () => {
    expect(
      calculateGrossTargetAmount({
        fromCurrency: CurrencyCode.KRW,
        toCurrency: CurrencyCode.USD,
        sourceAmount: '1000',
        appliedRate: '3',
      }),
    ).toBe('333.33333333');
  });

  it('calculates USD to KRW multiplication', () => {
    expect(
      calculateGrossTargetAmount({
        fromCurrency: CurrencyCode.USD,
        toCurrency: CurrencyCode.KRW,
        sourceAmount: '100',
        appliedRate: '1350.00000000',
      }),
    ).toBe('135000.00000000');
  });

  it('calculates fee amount and net target amount candidates', () => {
    const grossTargetAmount = '100.00000000';
    const feeAmount = calculateFeeAmount({
      grossTargetAmount,
      feeRate: '0.001000',
    });
    const netTargetAmount = calculateNetTargetAmount({
      grossTargetAmount,
      feeAmount,
    });

    expect(feeAmount).toBe('0.10000000');
    expect(netTargetAmount).toBe('99.90000000');
    expect(netTargetAmount).toBe('99.90000000');
  });

  it('keeps source debit and target credit candidates at stored scales', () => {
    const sourceAmount = formatMoneyScale8('135000');
    const grossTargetAmount = calculateGrossTargetAmount({
      fromCurrency: CurrencyCode.KRW,
      toCurrency: CurrencyCode.USD,
      sourceAmount,
      appliedRate: '1350',
    });
    const feeAmount = calculateFeeAmount({
      grossTargetAmount,
      feeRate: '0.001',
    });
    const netTargetAmount = calculateNetTargetAmount({
      grossTargetAmount,
      feeAmount,
    });

    const sourceWalletDebitCandidate = sourceAmount;
    const targetWalletCreditCandidate = netTargetAmount;

    expect(sourceWalletDebitCandidate).toBe('135000.00000000');
    expect(targetWalletCreditCandidate).toBe(netTargetAmount);
  });

  it('rejects JS number inputs to avoid precision drift', () => {
    expect(() => formatMoneyScale8(0.1 as never)).toThrow(
      'value must be a finite decimal string',
    );
    expect(() =>
      calculateGrossTargetAmount({
        fromCurrency: CurrencyCode.KRW,
        toCurrency: CurrencyCode.USD,
        sourceAmount: 1000 as never,
        appliedRate: '1350',
      }),
    ).toThrow('sourceAmount must be a finite decimal string');
  });

  it('treats invalid decimal strings as validation failures', () => {
    expect(isValidDecimalString('abc')).toBe(false);
    expect(isValidDecimalString('')).toBe(false);
    expect(() => formatMoneyScale8('abc')).toThrow('Invalid decimal string');
  });

  it('treats non-positive amounts as validation failures', () => {
    expect(isPositiveDecimalString('0')).toBe(false);
    expect(isPositiveDecimalString('-1')).toBe(false);
    expect(() => parsePositiveDecimalString('0')).toThrow(
      'Decimal must be greater than 0',
    );
  });
});
