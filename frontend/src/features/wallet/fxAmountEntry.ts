import Decimal from 'decimal.js';
import {
  fxPreview,
  fxSourceForTarget,
  isPositiveInput,
} from '../tradingAccount/indicativePreview.ts';
import type { FxRateDto } from './api';

export type FxCurrency = 'KRW' | 'USD';

/**
 * The amount field the user typed last, verbatim. The other field is always
 * computed from it during render, so neither field ever writes the other back.
 */
export type FxAmountEntry = { currency: FxCurrency; text: string };

export const FX_AMOUNT_REQUIRED = '금액을 입력해주세요.';
export const FX_AMOUNT_INVALID =
  '0보다 큰 금액을 소수점 이하 8자리까지 입력해주세요.';

// Ratio and balance math on up to 16 integer + 8 decimal digits, exactly.
const W = Decimal.clone({ precision: 40 });

/** A decimal string the way an input shows it: no grouping, no trailing zeros. */
export function plainAmount(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/u, '') : value;
}

export function otherFxCurrency(currency: FxCurrency): FxCurrency {
  return currency === 'KRW' ? 'USD' : 'KRW';
}

/**
 * What the two fields mean in this direction. Typed in the paying wallet's
 * currency, the text is the amount to pay (`source`); typed in the other
 * currency it is the amount to receive (`target`), converted into the amount
 * to pay at the current rate and fee. Either way the request stays the
 * server's source-based quote → execute; nothing here is executed.
 */
export function resolveFxAmounts(input: {
  fromCurrency: FxCurrency;
  entry: FxAmountEntry;
  rate: FxRateDto | null | undefined;
  feeRate: string | null | undefined;
  now: number;
}) {
  const { fromCurrency, entry, rate, feeRate, now } = input;
  const text = entry.text.trim();
  const basis = entry.currency === fromCurrency ? 'source' : 'target';
  const invalidReason = !text
    ? FX_AMOUNT_REQUIRED
    : !isPositiveInput(text, 8)
      ? FX_AMOUNT_INVALID
      : null;
  const needed =
    invalidReason || basis === 'source'
      ? null
      : fxSourceForTarget({ target: text, fromCurrency, rate, feeRate, now });
  const sourceAmount = invalidReason
    ? null
    : basis === 'source'
      ? text
      : needed && plainAmount(needed);
  const preview = sourceAmount
    ? fxPreview({ amount: sourceAmount, fromCurrency, rate, feeRate, now })
    : null;
  const computed =
    basis === 'source'
      ? preview
        ? plainAmount(preview.netTargetAmount)
        : ''
      : (sourceAmount ?? '');
  return {
    basis,
    invalidReason,
    /** The request's `sourceAmount`, when it can be known. */
    sourceAmount,
    preview,
    /** What each input shows: the typed one as typed, the other computed. */
    fields: {
      KRW: entry.currency === 'KRW' ? entry.text : computed,
      USD: entry.currency === 'USD' ? entry.text : computed,
    } as Record<FxCurrency, string>,
  } as const;
}

function decimalOrNull(value: string | null): Decimal | null {
  if (value === null) return null;
  try {
    const decimal = new W(value);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

/** `ratio` (0..1) of the paying wallet's spendable amount, floored to 8 places. */
export function fxSourceAtRatio(
  available: string | null,
  ratio: number,
): string | null {
  const total = decimalOrNull(available);
  if (!total || total.lt(0) || !Number.isFinite(ratio) || ratio < 0 || ratio > 1)
    return null;
  return plainAmount(
    total.mul(ratio).toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed(8),
  );
}

/** The share of the spendable amount that an amount to pay uses (0..1). */
export function fxSourceShare(
  sourceAmount: string | null,
  available: string | null,
): number {
  const total = decimalOrNull(available);
  const amount = decimalOrNull(sourceAmount);
  if (!total || !amount || total.lte(0) || amount.lte(0)) return 0;
  return Math.min(1, amount.div(total).toNumber());
}

/**
 * A spendable balance at the currency's display precision (whole won, cents),
 * rounded DOWN: the figure shown must never be more than can be exchanged.
 */
export function spendableDisplayAmount(
  available: string | null,
  currency: FxCurrency,
): string | null {
  const total = decimalOrNull(available);
  if (!total || total.lt(0)) return null;
  return total
    .toDecimalPlaces(currency === 'KRW' ? 0 : 2, Decimal.ROUND_DOWN)
    .toFixed(currency === 'KRW' ? 0 : 2);
}
