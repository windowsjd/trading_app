import { CurrencyCode, Prisma } from '../generated/prisma/client';

export const fxDecimalScales = {
  monetaryScale: 8,
  rateScale: 8,
  feeRateScale: 6,
  returnRateScale: 8,
} as const;

export const monetaryScale = fxDecimalScales.monetaryScale;
export const rateScale = fxDecimalScales.rateScale;
export const feeRateScale = fxDecimalScales.feeRateScale;
export const returnRateScale = fxDecimalScales.returnRateScale;

type DecimalInput = string | Prisma.Decimal;

export function parseDecimalString(value: unknown): Prisma.Decimal {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Invalid decimal string');
  }

  try {
    const decimal = new Prisma.Decimal(value.trim());

    if (!decimal.isFinite()) {
      throw new Error('Decimal must be finite');
    }

    return decimal;
  } catch (error) {
    if (error instanceof Error && error.message === 'Decimal must be finite') {
      throw error;
    }

    throw new Error('Invalid decimal string');
  }
}

export function isValidDecimalString(value: unknown): boolean {
  try {
    parseDecimalString(value);

    return true;
  } catch {
    return false;
  }
}

export function parsePositiveDecimalString(value: unknown): Prisma.Decimal {
  const decimal = parseDecimalString(value);

  if (decimal.lte(0)) {
    throw new Error('Decimal must be greater than 0');
  }

  return decimal;
}

export function isPositiveDecimalString(value: unknown): boolean {
  try {
    parsePositiveDecimalString(value);

    return true;
  } catch {
    return false;
  }
}

export function roundDecimalHalfUp(
  value: DecimalInput,
  scale: number,
): Prisma.Decimal {
  const decimal = toDecimal(value);

  return decimal.toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP);
}

export function formatDecimalScale(value: DecimalInput, scale: number): string {
  return roundDecimalHalfUp(value, scale).toFixed(scale);
}

export function formatMoneyScale8(value: DecimalInput): string {
  return formatDecimalScale(value, monetaryScale);
}

export function formatRateScale8(value: DecimalInput): string {
  return formatDecimalScale(value, rateScale);
}

export function formatFeeRateScale6(value: DecimalInput): string {
  return formatDecimalScale(value, feeRateScale);
}

export type CalculateGrossTargetAmountInput = {
  fromCurrency: CurrencyCode;
  toCurrency: CurrencyCode;
  sourceAmount: DecimalInput;
  appliedRate: DecimalInput;
};

export type CalculateFeeAmountInput = {
  grossTargetAmount: DecimalInput;
  feeRate: DecimalInput;
};

export type CalculateNetTargetAmountInput = {
  grossTargetAmount: DecimalInput;
  feeAmount: DecimalInput;
};

export function calculateGrossTargetAmount({
  fromCurrency,
  toCurrency,
  sourceAmount,
  appliedRate,
}: CalculateGrossTargetAmountInput): string {
  assertValidFxCurrencyPair(fromCurrency, toCurrency);

  const source = parsePositiveDecimalInput(sourceAmount, 'sourceAmount');
  const rate = parsePositiveDecimalInput(appliedRate, 'appliedRate');
  const grossTargetAmount =
    fromCurrency === CurrencyCode.KRW ? source.div(rate) : source.mul(rate);

  return formatMoneyScale8(grossTargetAmount);
}

export function calculateFeeAmount({
  grossTargetAmount,
  feeRate,
}: CalculateFeeAmountInput): string {
  const gross = parsePositiveDecimalInput(grossTargetAmount, 'grossTargetAmount');
  const rate = parseDecimalInput(feeRate, 'feeRate');

  if (rate.lt(0)) {
    throw new Error('feeRate must not be negative');
  }

  return formatMoneyScale8(gross.mul(rate));
}

export function calculateNetTargetAmount({
  grossTargetAmount,
  feeAmount,
}: CalculateNetTargetAmountInput): string {
  const gross = parsePositiveDecimalInput(grossTargetAmount, 'grossTargetAmount');
  const fee = parseDecimalInput(feeAmount, 'feeAmount');

  if (fee.lt(0) || fee.gt(gross)) {
    throw new Error('feeAmount must be between 0 and grossTargetAmount');
  }

  return formatMoneyScale8(gross.sub(fee));
}

function parseDecimalInput(value: DecimalInput, fieldName: string): Prisma.Decimal {
  if (typeof value === 'string') {
    return parseDecimalString(value);
  }

  if (value instanceof Prisma.Decimal && value.isFinite()) {
    return value;
  }

  throw new Error(`${fieldName} must be a finite decimal string`);
}

function parsePositiveDecimalInput(
  value: DecimalInput,
  fieldName: string,
): Prisma.Decimal {
  const decimal = parseDecimalInput(value, fieldName);

  if (decimal.lte(0)) {
    throw new Error(`${fieldName} must be greater than 0`);
  }

  return decimal;
}

function toDecimal(value: DecimalInput): Prisma.Decimal {
  return parseDecimalInput(value, 'value');
}

function assertValidFxCurrencyPair(
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
) {
  const isKrwToUsd =
    fromCurrency === CurrencyCode.KRW && toCurrency === CurrencyCode.USD;
  const isUsdToKrw =
    fromCurrency === CurrencyCode.USD && toCurrency === CurrencyCode.KRW;

  if (!isKrwToUsd && !isUsdToKrw) {
    throw new Error('Invalid currency pair');
  }
}
