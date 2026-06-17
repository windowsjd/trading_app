import { ProviderConfigError } from '../provider.types';

export type KisWatchlistInput = {
  domesticSymbols?: readonly string[];
  usSymbols?: readonly string[];
  maxSize?: number;
};

export type KisWatchlist = {
  domesticSymbols: string[];
  usSymbols: string[];
  allSymbols: string[];
  maxSize: number;
};

const DEFAULT_KIS_WATCHLIST_MAX_SIZE = 41;

export function buildKisWatchlist(input: KisWatchlistInput): KisWatchlist {
  const maxSize = input.maxSize ?? DEFAULT_KIS_WATCHLIST_MAX_SIZE;
  if (!Number.isSafeInteger(maxSize) || maxSize <= 0) {
    throw new ProviderConfigError(
      'kis',
      'INVALID_WATCHLIST_LIMIT',
      'KIS watchlist max size must be a positive integer.',
    );
  }

  const seen = new Set<string>();
  const domesticSymbols = normalizeSymbols(input.domesticSymbols ?? [], seen);
  const usSymbols = normalizeSymbols(input.usSymbols ?? [], seen);
  const allSymbols = [...domesticSymbols, ...usSymbols];

  if (allSymbols.length > maxSize) {
    throw new ProviderConfigError(
      'kis',
      'KIS_WATCHLIST_LIMIT_EXCEEDED',
      `KIS watchlist allows at most ${maxSize} symbols.`,
    );
  }

  return {
    domesticSymbols,
    usSymbols,
    allSymbols,
    maxSize,
  };
}

function normalizeSymbols(
  symbols: readonly string[],
  seen: Set<string>,
): string[] {
  const normalized: string[] = [];

  for (const symbol of symbols) {
    const text = symbol.trim().toUpperCase();
    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    normalized.push(text);
  }

  return normalized;
}
