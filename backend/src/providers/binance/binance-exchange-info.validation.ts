/**
 * Pure validation of the fixed Binance universe against a
 * `GET /api/v3/exchangeInfo` response. No network or Prisma here so it is fully
 * unit testable; the seed script performs the HTTP fetch and feeds the parsed
 * JSON in.
 *
 * Every symbol must independently pass ALL of:
 *  - present in the response with an exact `symbol` match,
 *  - `status === 'TRADING'`,
 *  - Spot trading permitted,
 *  - `quoteAsset === 'USDT'`,
 *  - `baseAsset` equals the expected fixed-universe base asset.
 *
 * All failures are collected (never short-circuited) so an operator sees every
 * problem at once, and `ok` is true only when every symbol passes — the seed
 * writes nothing unless `ok` is true.
 */

export type BinanceExchangeInfoSymbol = {
  symbol?: unknown;
  status?: unknown;
  baseAsset?: unknown;
  quoteAsset?: unknown;
  isSpotTradingAllowed?: unknown;
  permissions?: unknown;
  permissionSets?: unknown;
};

export type BinanceExchangeInfoResponse = {
  symbols?: unknown;
};

export type ExpectedBinanceSpotSymbol = {
  symbol: string;
  baseAsset: string;
};

export type BinanceSymbolValidationResult = {
  symbol: string;
  ok: boolean;
  reason?: string;
  detail?: string;
};

export type BinanceUniverseValidationResult = {
  ok: boolean;
  results: BinanceSymbolValidationResult[];
  failures: BinanceSymbolValidationResult[];
};

const TRADING_STATUS = 'TRADING';
const REQUIRED_QUOTE_ASSET = 'USDT';
const SPOT_PERMISSION = 'SPOT';

export function hasSpotPermission(
  symbolInfo: BinanceExchangeInfoSymbol,
): boolean {
  if (symbolInfo.isSpotTradingAllowed === true) {
    return true;
  }

  if (
    Array.isArray(symbolInfo.permissions) &&
    symbolInfo.permissions.includes(SPOT_PERMISSION)
  ) {
    return true;
  }

  // Newer exchangeInfo replaces `permissions` with `permissionSets`
  // (array of string arrays); Spot counts if it appears in any set.
  if (Array.isArray(symbolInfo.permissionSets)) {
    for (const set of symbolInfo.permissionSets) {
      if (Array.isArray(set) && set.includes(SPOT_PERMISSION)) {
        return true;
      }
    }
  }

  return false;
}

function indexSymbols(
  response: BinanceExchangeInfoResponse,
): Map<string, BinanceExchangeInfoSymbol> {
  const bySymbol = new Map<string, BinanceExchangeInfoSymbol>();
  if (!Array.isArray(response.symbols)) {
    return bySymbol;
  }

  for (const entry of response.symbols) {
    if (entry && typeof entry === 'object') {
      const info = entry as BinanceExchangeInfoSymbol;
      if (typeof info.symbol === 'string') {
        bySymbol.set(info.symbol, info);
      }
    }
  }

  return bySymbol;
}

function validateOne(
  expected: ExpectedBinanceSpotSymbol,
  info: BinanceExchangeInfoSymbol | undefined,
): BinanceSymbolValidationResult {
  if (!info) {
    return {
      symbol: expected.symbol,
      ok: false,
      reason: 'SYMBOL_NOT_FOUND',
      detail: 'not present in exchangeInfo symbols',
    };
  }

  if (info.symbol !== expected.symbol) {
    return {
      symbol: expected.symbol,
      ok: false,
      reason: 'SYMBOL_MISMATCH',
      detail: `response symbol ${String(info.symbol)} != requested ${expected.symbol}`,
    };
  }

  if (info.status !== TRADING_STATUS) {
    return {
      symbol: expected.symbol,
      ok: false,
      reason: 'STATUS_NOT_TRADING',
      detail: `status=${String(info.status)}`,
    };
  }

  if (!hasSpotPermission(info)) {
    return {
      symbol: expected.symbol,
      ok: false,
      reason: 'SPOT_NOT_PERMITTED',
      detail: 'isSpotTradingAllowed/permissions do not include SPOT',
    };
  }

  if (info.quoteAsset !== REQUIRED_QUOTE_ASSET) {
    return {
      symbol: expected.symbol,
      ok: false,
      reason: 'QUOTE_ASSET_NOT_USDT',
      detail: `quoteAsset=${String(info.quoteAsset)}`,
    };
  }

  if (info.baseAsset !== expected.baseAsset) {
    return {
      symbol: expected.symbol,
      ok: false,
      reason: 'BASE_ASSET_MISMATCH',
      detail: `baseAsset=${String(info.baseAsset)} expected=${expected.baseAsset}`,
    };
  }

  return { symbol: expected.symbol, ok: true };
}

export function validateBinanceSpotUniverse(
  expected: readonly ExpectedBinanceSpotSymbol[],
  response: BinanceExchangeInfoResponse,
): BinanceUniverseValidationResult {
  const bySymbol = indexSymbols(response);
  const results = expected.map((entry) =>
    validateOne(entry, bySymbol.get(entry.symbol)),
  );
  const failures = results.filter((result) => !result.ok);

  return {
    ok: failures.length === 0,
    results,
    failures,
  };
}
