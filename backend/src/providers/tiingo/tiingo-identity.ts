/**
 * Tiingo security identity (2026-10-17). Tiingo's own metadata
 * (`GET /tiingo/daily/<ticker>`) must place the ticker on the exchange the
 * Asset row is listed on before any Tiingo value may stand for that Asset as
 * financial evidence (the US LOC close, the official smoke). The fixed US
 * universe is NASDAQ (NAS) and NYSE (NYS) only; any other listing is refused.
 */
export function tiingoExchangeMatchesAssetMarket(
  exchangeCode: string | null,
  assetMarket: string,
): boolean {
  const exchange = exchangeCode?.trim().toUpperCase() ?? '';
  const market = assetMarket.trim().toUpperCase();
  if (market === 'NAS' || market === 'NASDAQ') return exchange === 'NASDAQ';
  if (market === 'NYS' || market === 'NYSE') return exchange === 'NYSE';
  return false;
}
