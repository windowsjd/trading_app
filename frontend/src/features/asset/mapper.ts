const TRADABLE_MARKET_STATUSES = new Set(['open', 'always_open']);
const TRADING_NOTE_PRIORITY_KEYS = [
  'message',
  'reason',
  'detail',
  'tradeBlockedReason',
];

function formatPrimitiveValue(value: unknown) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }

  if (typeof value === 'boolean') {
    return String(value);
  }

  return null;
}

export function isTradableMarketStatus(status?: string | null) {
  const normalized = status?.toLowerCase();
  return normalized ? TRADABLE_MARKET_STATUSES.has(normalized) : false;
}

export function formatTradingNote(note: unknown): string | null {
  const primitiveValue = formatPrimitiveValue(note);
  if (primitiveValue) return primitiveValue;

  if (Array.isArray(note)) {
    const values = note
      .map((item) => formatTradingNote(item))
      .filter((value): value is string => !!value);

    return values.length ? values.join(' · ') : null;
  }

  if (!note || typeof note !== 'object') return null;

  const record = note as Record<string, unknown>;
  const prioritizedValues = TRADING_NOTE_PRIORITY_KEYS
    .map((key) => formatTradingNote(record[key]))
    .filter((value): value is string => !!value);

  if (prioritizedValues.length) {
    return prioritizedValues.join(' · ');
  }

  const primitiveValues = Object.values(record)
    .map(formatPrimitiveValue)
    .filter((value): value is string => !!value);

  return primitiveValues.length ? primitiveValues.join(' · ') : null;
}
