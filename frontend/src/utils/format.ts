// Display-only number formatting. Never use these on values before sending
// them back to the API — they are lossy (rounded) by design. Formatters are for
// rendering to the screen only, never for order/price/settlement calculations.

export type FormatCurrencyCode = 'KRW' | 'USD' | (string & {});

const KRW_UNIT = '원';
const USD_SYMBOL = '$';
const PURE_NUMERIC_ASSET_SYMBOL = /^\d+$/u;
const KST_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function toFiniteNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function withThousandsSeparator(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Final display cleanup for a known decimal value. It never parses through a
 * float, so long decimal strings keep every meaningful digit. Integer digits,
 * leading zeros and separators are preserved; only fractional padding is
 * removed. Non-decimal strings are returned unchanged.
 */
export function formatDisplayDecimal(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'number' && !Number.isFinite(value)) return '-';

  const text = String(value).trim();
  const match = /^([+-]?)(\d[\d,]*)(?:\.(\d*))?$/u.exec(text);
  if (!match) return text;

  const [, rawSign, integerPart, rawFraction = ''] = match;
  const fraction = rawFraction.replace(/0+$/u, '');
  const isZero = !/[1-9]/u.test(`${integerPart}${fraction}`);
  const sign = isZero ? '' : rawSign;
  return `${sign}${integerPart}${fraction ? `.${fraction}` : ''}`;
}

/** KRW/원 magnitude: rounded to an integer, thousands-separated. No unit. */
export function formatKrw(value: string | number | null | undefined): string {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return '-';

  const rounded = Math.round(parsed);
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${withThousandsSeparator(String(Math.abs(rounded)))}`;
}

/** USD magnitude: rounded to 2 places, trimmed, thousands-separated. No symbol. */
export function formatUsd(value: string | number | null | undefined): string {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return '-';

  const sign = parsed < 0 ? '-' : '';
  const [integerPart, decimalPart] = Math.abs(parsed).toFixed(2).split('.');
  return formatDisplayDecimal(
    `${sign}${withThousandsSeparator(integerPart)}.${decimalPart}`,
  );
}

const MAX_DISPLAY_PRICE_DECIMALS = 8;

/**
 * Rounds a decimal STRING to `decimals` places without going through a float.
 * `Number('0.245600001')` and friends round fine, but numbers big enough to hit
 * exponent notation ("1e+21") or long crypto strings can render wrong, so the
 * rounding is done on the digits. Returns null for anything non-decimal
 * (exponent strings included) so the caller can fall back.
 */
function toFixedDecimalString(value: string, decimals: number): string | null {
  const trimmed = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/u.exec(trimmed);
  if (!match) return null;

  const [, rawSign, integerDigits, fractionDigits = ''] = match;
  const digits = `${integerDigits}${fractionDigits}`;
  const pointIndex = integerDigits.length;
  const keep = pointIndex + decimals;

  let kept = digits.slice(0, keep).padEnd(keep, '0');
  const nextDigit = digits.charCodeAt(keep);
  // Half-up on the magnitude, matching toFixed's usual reading.
  if (nextDigit >= 53 /* '5' */) {
    let index = kept.length - 1;
    let carry = 1;
    const chars = kept.split('');
    while (index >= 0 && carry === 1) {
      const next = chars[index].charCodeAt(0) - 48 + 1;
      if (next === 10) {
        chars[index] = '0';
      } else {
        chars[index] = String(next);
        carry = 0;
      }
      index -= 1;
    }
    kept = (carry === 1 ? '1' : '') + chars.join('');
  }

  const integerLength = kept.length - decimals;
  const integerPart = (kept.slice(0, integerLength) || '0').replace(
    /^0+(?=\d)/u,
    '',
  );
  const fractionPart = kept.slice(integerLength);
  const isZero = !/[1-9]/u.test(kept);
  const sign = rawSign === '-' && !isZero ? '-' : '';

  return formatDisplayDecimal(
    `${sign}${withThousandsSeparator(integerPart)}${
      decimals > 0 ? `.${fractionPart}` : ''
    }`,
  );
}

function normalizeDisplayPriceDecimals(
  displayPriceDecimals?: number | null,
): number | null {
  if (typeof displayPriceDecimals !== 'number') return null;
  if (!Number.isInteger(displayPriceDecimals)) return null;
  if (displayPriceDecimals < 0) return null;
  return Math.min(displayPriceDecimals, MAX_DISPLAY_PRICE_DECIMALS);
}

/**
 * Asset UNIT price display (a market row's price, the detail header price, the
 * order screen's current price). Unlike `formatMoney` — which stays the policy
 * for wallet balances, order totals and fees — this honors the provider's
 * declared precision so a 0.24560 coin is not rendered as $0.25.
 *
 *   - KRW assets  → 원 units, unchanged.
 *   - USD assets with `displayPriceDecimals` (Binance tickSize) → round to that
 *     precision, then remove fractional zero padding.
 *   - USD assets without it → the existing 2-decimal policy.
 *
 * Missing/invalid values render as '-'; callers use the '시세 준비 중'
 * placeholder for a price slot with nothing to show.
 */
export function formatAssetPrice(
  value: string | number | null | undefined,
  currencyCode?: FormatCurrencyCode | null,
  displayPriceDecimals?: number | null,
): string {
  const code = normalizeCurrencyCode(currencyCode);
  if (code === 'KRW') return formatMoney(value, code);

  const decimals = normalizeDisplayPriceDecimals(displayPriceDecimals);
  if (decimals === null) return formatMoney(value, currencyCode);
  if (toFiniteNumber(value) === null) return '-';

  // API money values arrive as decimal STRINGS and are rounded digit-by-digit.
  // A number input is rounded once by toFixed (no double rounding) and then
  // only gets its separators here.
  const formatted =
    typeof value === 'number'
      ? toFixedDecimalString(value.toFixed(decimals), decimals)
      : (toFixedDecimalString(String(value), decimals) ??
        // Exponent notation or another shape the string path rejects: the
        // numeric fallback still beats showing a raw exponent to the user.
        toFixedDecimalString(Number(value).toFixed(decimals), decimals));
  if (formatted === null) return formatMoney(value, currencyCode);

  return code === 'USD' ? `${USD_SYMBOL}${formatted}` : formatted;
}

/**
 * Normalizes a raw currency code (trims + upper-cases) and narrows it to a code
 * the app officially formats. "usd", "USD ", "Usd" → "USD"; "krw", "KRW " → "KRW".
 * Anything else (including null/undefined) → null.
 */
export function normalizeCurrencyCode(
  currencyCode?: FormatCurrencyCode | null,
): 'KRW' | 'USD' | null {
  const normalized = currencyCode?.trim().toUpperCase();
  if (normalized === 'KRW' || normalized === 'USD') return normalized;
  return null;
}

const warnedUnknownCurrencies = new Set<string>();

function warnUnknownCurrency(currencyCode?: FormatCurrencyCode | null): void {
  // Only KRW/USD are officially supported. Rather than silently rendering an
  // unknown currency as KRW (which hides bugs), we fall back to a plain number
  // rounded to 2 decimals and surface the cause to developers in dev builds.
  const isDev = (globalThis as { __DEV__?: boolean }).__DEV__ === true;
  if (!isDev) return;

  const key = String(currencyCode ?? '');
  if (warnedUnknownCurrencies.has(key)) return;
  warnedUnknownCurrencies.add(key);
  console.warn(
    `[format] Unsupported currencyCode "${key}"; falling back to plain 2-decimal rounding. Only KRW/USD are supported.`,
  );
}

/**
 * Currency-aware magnitude (no unit/symbol), chosen by currency code:
 *   - KRW → "1,235"    (integer)
 *   - USD → "1,234.57" (rounded to 2 decimals, then trimmed)
 *   - unknown/unsupported → "1,234.57" (plain 2-decimal rounding fallback)
 * Never silently treats an unknown currency as KRW. Use this when the currency
 * is shown separately (e.g. a "USD 1,234.5" row); use `formatMoney` when the
 * amount should carry its own unit.
 */
export function formatCurrency(
  value: string | number | null | undefined,
  currencyCode?: FormatCurrencyCode | null,
): string {
  const code = normalizeCurrencyCode(currencyCode);
  if (code === 'USD') return formatUsd(value);
  if (code === 'KRW') return formatKrw(value);

  if (toFiniteNumber(value) === null) return '-';
  warnUnknownCurrency(currencyCode);
  return formatUsd(value);
}

/**
 * Currency-aware money display that carries its own unit:
 *   - KRW → "1,235원"   (integer, 원 suffix)
 *   - USD → "$1,234.57" ($ prefix, rounded to 2 decimals then trimmed)
 *   - unknown/unsupported → "1,234.57" (2-decimal rounding, no symbol)
 * Missing/invalid values render as "-". Never mixes "$" and "USD" for one amount.
 * Prefer this over appending a raw code (" USD"/" KRW") next to a bare number.
 */
export function formatMoney(
  value: string | number | null | undefined,
  currencyCode?: FormatCurrencyCode | null,
): string {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return '-';

  const code = normalizeCurrencyCode(currencyCode);
  if (code === 'USD') return `${USD_SYMBOL}${formatUsd(parsed)}`;
  if (code === 'KRW') return `${formatKrw(parsed)}${KRW_UNIT}`;

  warnUnknownCurrency(currencyCode);
  return formatUsd(parsed);
}

export const MARKET_CLOSED_PRICE_TEXT = '휴장시간';
export const PRICE_PREPARING_TEXT = '시세 준비 중';

export type PriceUnavailableAsset = {
  assetType?: string | null;
  marketStatus?: string | null;
};

/**
 * Placeholder for a price slot that has nothing displayable.
 *   - Stock + marketStatus 'closed' (confirmed non-trading time: before open,
 *     after close, weekend, holiday, delayed-open wait) → '휴장시간'.
 *   - Everything else → '시세 준비 중': marketStatus 'unknown' (including
 *     missing calendar coverage — never claim "closed" without a confirmed
 *     calendar), 'open' with the provider not ready, and crypto (whose
 *     24h market never closes).
 */
export function getUnavailablePriceText(asset: PriceUnavailableAsset): string {
  return asset.assetType !== 'crypto' && asset.marketStatus === 'closed'
    ? MARKET_CLOSED_PRICE_TEXT
    : PRICE_PREPARING_TEXT;
}

export type AssetPriceTextInput = PriceUnavailableAsset & {
  /** Provider-declared unit-price decimals; null keeps the previous policy. */
  displayPriceDecimals?: number | null;
  price?: {
    state?: string | null;
    currentPrice?: string | null;
    priceCurrency?: FormatCurrencyCode | null;
  } | null;
};

/**
 * Price cell text for an asset row/card: the formatted price whenever one is
 * displayable (including a carry-forward snapshot while the market is
 * closed), otherwise the market-aware placeholder above. Uses the asset's
 * declared unit-price precision so the list and the detail screen agree.
 */
export function getAssetPriceText(item: AssetPriceTextInput): string {
  if (item.price?.state !== 'available' || !item.price.currentPrice) {
    return getUnavailablePriceText(item);
  }
  return formatAssetPrice(
    item.price.currentPrice,
    item.price.priceCurrency,
    item.displayPriceDecimals,
  );
}

/** Percent/return-rate display: rounded then trimmed (default 2), no '%'. */
export function formatPercent(
  value: string | number | null | undefined,
  digits = 2,
): string {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return '-';
  return formatDisplayDecimal(parsed.toFixed(digits));
}

/**
 * Display-only timestamp formatter. The device timezone is deliberately
 * ignored: every valid instant is rendered in Asia/Seoul as
 * `YYYY-MM-DD HH:mm`, without seconds or an offset. Date-only domain fields
 * must not be passed here.
 */
export function formatKstDateTime(
  value: string | Date | null | undefined,
): string {
  if (value === null || value === undefined || value === '') return '-';

  if (typeof value === 'string') {
    const normalized = value.trim();
    // A date-only value is not an instant, and a timezone-less datetime would
    // be interpreted in the device timezone. Reject both at this boundary so
    // the formatter never invents a time or varies by device settings.
    if (
      !/^\d{4}-\d{2}-\d{2}T/u.test(normalized) ||
      !/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(normalized)
    ) {
      return '-';
    }
  }

  const date = value instanceof Date ? value : new Date(value.trim());
  if (!Number.isFinite(date.getTime())) return '-';

  const parts = KST_DATE_TIME_FORMATTER.formatToParts(date);
  const getPart = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const hour = getPart('hour');
  const minute = getPart('minute');

  if (!year || !month || !day || !hour || !minute) return '-';
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

/**
 * Asset-symbol display policy. Pure numeric symbols are searchable/provider
 * identifiers (for example KRX 000270), but are not user-facing labels.
 * Alphanumeric symbols such as 1INCHUSDT remain visible.
 */
export function getAssetSymbolDisplay(
  symbol?: string | null,
): string | null {
  const normalized = symbol?.trim() || null;
  if (!normalized || PURE_NUMERIC_ASSET_SYMBOL.test(normalized)) return null;
  return normalized;
}

export type AssetNameDisplay = {
  primary: string;
  secondary: string | null;
};

/**
 * Name-first display for an asset: company/coin name as primary, symbol as
 * secondary. Falls back to symbol as primary when the name is missing.
 */
export function getAssetNameDisplay(
  asset?: { name?: string | null; symbol?: string | null } | null,
): AssetNameDisplay {
  const rawName = asset?.name?.trim() || null;
  const rawSymbol = asset?.symbol?.trim() || null;
  const symbol = getAssetSymbolDisplay(rawSymbol);
  // Some fallback payloads may repeat the symbol in `name`. Do not let a
  // hidden numeric symbol re-enter the UI through that duplicate field.
  const name = rawName === rawSymbol && rawSymbol && !symbol ? null : rawName;

  if (name && symbol && name !== symbol) return { primary: name, secondary: symbol };
  if (name) return { primary: name, secondary: null };
  if (symbol) return { primary: symbol, secondary: null };
  return { primary: '-', secondary: null };
}

/** Symbol/market secondary line with empty parts and separators removed. */
export function getAssetSymbolMarketDisplay(
  asset?: { symbol?: string | null; market?: string | null } | null,
): string | null {
  const symbol = getAssetSymbolDisplay(asset?.symbol);
  const market = asset?.market?.trim() || null;
  const display = [symbol, market].filter((value): value is string => !!value);
  return display.length > 0 ? display.join(' · ') : null;
}
