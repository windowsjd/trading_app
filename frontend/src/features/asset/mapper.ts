const TRADABLE_MARKET_STATUSES = new Set(['open', 'always_open']);

export function isTradableMarketStatus(status?: string | null) {
  const normalized = status?.toLowerCase();
  return normalized ? TRADABLE_MARKET_STATUSES.has(normalized) : false;
}
