/**
 * Binance `PRICE_FILTER.tickSize` → display decimals.
 *
 * Pure string math on purpose: `Number('0.00001000')` is exact here, but
 * `String(Number(...))` can flip into exponent notation ("1e-7") and larger
 * tick sizes lose their trailing-zero shape, so the decimal digits are counted
 * from the raw response string instead of a float round-trip.
 *
 * tickSize `0.01000000` → 2, `0.00010000` → 4, `0.00001000` → 5, `1.00000000` → 0.
 */

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/u;

export type BinancePriceFilter = {
  filterType?: unknown;
  tickSize?: unknown;
};

export type BinanceExchangeInfoSymbolFilters = {
  symbol?: unknown;
  filters?: unknown;
};

/**
 * Display decimals for a tickSize string, or null when the value is missing,
 * malformed (empty, negative, exponent notation, non-numeric) or zero.
 */
export function parseTickSizeDisplayDecimals(tickSize: unknown): number | null {
  if (typeof tickSize !== 'string') return null;

  const trimmed = tickSize.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) return null;

  const [integerPart, fractionPart = ''] = trimmed.split('.');
  // A tickSize of 0 carries no precision information.
  if (/^0*$/u.test(integerPart) && /^0*$/u.test(fractionPart)) return null;

  const significantFraction = fractionPart.replace(/0+$/u, '');
  return significantFraction.length;
}

/** Reads `PRICE_FILTER.tickSize` out of one exchangeInfo symbol entry. */
export function readPriceFilterTickSize(
  symbolInfo: BinanceExchangeInfoSymbolFilters | null | undefined,
): string | null {
  if (!symbolInfo || !Array.isArray(symbolInfo.filters)) return null;

  for (const filter of symbolInfo.filters) {
    if (!filter || typeof filter !== 'object') continue;
    const record = filter as BinancePriceFilter;
    if (record.filterType !== 'PRICE_FILTER') continue;
    return typeof record.tickSize === 'string' ? record.tickSize : null;
  }

  return null;
}

export type BinanceSymbolPricePrecision = {
  symbol: string;
  priceTickSize: string;
  displayPriceDecimals: number;
};

/**
 * Extracts `{symbol → tickSize/decimals}` from a `GET /api/v3/exchangeInfo`
 * response. Malformed entries are dropped instead of throwing so one bad symbol
 * never discards the whole refresh.
 */
export function readBinanceSymbolPricePrecision(
  response: unknown,
): BinanceSymbolPricePrecision[] {
  if (!response || typeof response !== 'object') return [];
  const symbols = (response as { symbols?: unknown }).symbols;
  if (!Array.isArray(symbols)) return [];

  const precisions: BinanceSymbolPricePrecision[] = [];
  for (const entry of symbols) {
    if (!entry || typeof entry !== 'object') continue;
    const info = entry as BinanceExchangeInfoSymbolFilters;
    if (typeof info.symbol !== 'string' || !info.symbol.trim()) continue;

    const tickSize = readPriceFilterTickSize(info);
    const displayPriceDecimals = parseTickSizeDisplayDecimals(tickSize);
    if (tickSize === null || displayPriceDecimals === null) continue;

    precisions.push({
      symbol: info.symbol.trim().toUpperCase(),
      priceTickSize: tickSize,
      displayPriceDecimals,
    });
  }

  return precisions;
}
