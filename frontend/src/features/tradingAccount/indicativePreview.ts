import Decimal from 'decimal.js';
import {
  isTickerStaleAt,
  parseTickerTimestamp,
} from '../asset/assetTickerPolicy.ts';
import type { DisplayPrice } from '../asset/displayPricePolicy';
import type { FxRateDto } from '../wallet/api';
import { formatAssetPrice, formatKrwDecimal } from '../../utils/format.ts';

// Match Prisma.Decimal's precision and ROUND_HALF_UP; never use these display
// calculations in an execute payload. Amounts remain decimal strings.
const D = Decimal.clone({ precision: 20, rounding: Decimal.ROUND_HALF_UP });
const money = (value: Decimal) => value.toDecimalPlaces(8).toFixed(8);

/** Keep long amounts decimal strings through the existing display formatters. */
export function formatPreviewMoney(value: string, currency: string) {
  return currency === 'KRW'
    ? `${formatKrwDecimal(value)}원`
    : formatAssetPrice(value, currency, 2);
}

export function isPositiveInput(value: string, decimals: number): boolean {
  const text = value.trim();
  return (
    text.length <= 100 &&
    new RegExp(`^(?:\\d+|\\d*\\.\\d{1,${decimals}})$`, 'u').test(text) &&
    new D(text).isPositive() &&
    !new D(text).isZero()
  );
}

function validFee(value?: string | null): value is string {
  return !!value && /^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/u.test(value);
}

export function isPreviewPriceAvailable(price: DisplayPrice, now: number) {
  if (!price.priceLocal || !isPositiveInput(price.priceLocal, 8)) return false;
  // Reuse the detail screen's display freshness, including its existing REST
  // baseline. An undated or old baseline is never called current/realtime.
  if (
    parseTickerTimestamp(price.priceCapturedAt ?? price.priceEffectiveAt) ===
    null
  )
    return false;
  return !isTickerStaleAt(
    {
      type: 'asset_ticker',
      assetId: '',
      priceLocal: price.priceLocal,
      priceKrw: null,
      priceCapturedAt: price.priceCapturedAt,
      priceEffectiveAt: price.priceEffectiveAt,
      freshnessAgeSeconds: price.freshnessAgeSeconds,
    },
    now,
  );
}

export function orderPreview(input: {
  quantity: string;
  price: string | null | undefined;
  feeRate: string | null | undefined;
}) {
  if (
    !isPositiveInput(input.quantity, 6) ||
    !input.price ||
    !isPositiveInput(input.price, 8) ||
    !validFee(input.feeRate)
  )
    return null;
  // Market buy and limit reservation share this exact rounding chain.
  const gross = new D(input.quantity).mul(input.price).toDecimalPlaces(8);
  const fee = gross.mul(input.feeRate).toDecimalPlaces(8);
  return {
    price: input.price,
    grossAmount: money(gross),
    feeAmount: money(fee),
    totalAmount: money(gross.add(fee)),
  };
}

export function isPreviewFxAvailable(
  rate: FxRateDto | null | undefined,
  now: number,
) {
  const validUntil = parseTickerTimestamp(rate?.validUntil);
  return (
    rate?.state === 'available' &&
    rate.baseCurrency === 'USD' &&
    rate.quoteCurrency === 'KRW' &&
    isPositiveInput(rate.rate, 8) &&
    validUntil !== null &&
    now <= validUntil
  );
}

export function fxPreview(input: {
  amount: string;
  fromCurrency: 'KRW' | 'USD';
  rate: FxRateDto | null | undefined;
  feeRate: string | null | undefined;
  now: number;
}) {
  if (
    !isPositiveInput(input.amount, 8) ||
    !validFee(input.feeRate) ||
    !isPreviewFxAvailable(input.rate, input.now)
  )
    return null;
  const amount = new D(input.amount);
  const gross =
    input.fromCurrency === 'KRW'
      ? amount.div(input.rate.rate)
      : amount.mul(input.rate.rate);
  // FX rounds only the final fields, unlike the order rounding chain.
  const fee = gross.mul(input.feeRate);
  return {
    grossTargetAmount: money(gross),
    feeAmount: money(fee),
    netTargetAmount: money(gross.sub(fee)),
    feeCurrency:
      input.fromCurrency === 'KRW' ? ('USD' as const) : ('KRW' as const),
  };
}
