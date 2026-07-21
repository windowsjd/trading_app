import type { MarketCalendarMarket } from './market-calendar.types';

/**
 * Process-wide snapshot of ACTIVE operator market-session overrides
 * (market_session_overrides rows with is_active=true), consumed synchronously
 * by the market-calendar policy functions. The snapshot is replaced atomically
 * by MarketSessionOverrideLoaderService; policy code never touches the DB.
 *
 * Modes:
 * - 'passthrough' (default; unit tests and processes that never register the
 *   loader): the store is considered ready with zero overrides, so the static
 *   calendar behaves exactly as before.
 * - 'required' (production; the loader marks this before its first load): the
 *   store is NOT ready until one load succeeds. While not ready, effective
 *   calendar coverage reports unavailable (fail-closed) — the app must never
 *   silently serve static-only schedules while DB overrides may exist.
 */
export type MarketSessionOverrideKind = 'regular' | 'closed' | 'custom';

export type MarketSessionOverrideEntry = {
  market: MarketCalendarMarket;
  /** Exchange-local trading date, YYYY-MM-DD. */
  localDate: string;
  overrideType: MarketSessionOverrideKind;
  /** Exchange-local HHmmss; non-null only for 'custom'. */
  openTime: string | null;
  closeTime: string | null;
  reason: string;
};

type StoreState = {
  mode: 'passthrough' | 'required';
  loaded: boolean;
  entries: Map<string, MarketSessionOverrideEntry>;
  loadedAt: Date | null;
};

const state: StoreState = {
  mode: 'passthrough',
  loaded: false,
  entries: new Map(),
  loadedAt: null,
};

function entryKey(market: MarketCalendarMarket, localDate: string): string {
  return `${market}:${localDate}`;
}

/**
 * Switches the store to fail-closed mode until the first successful load.
 * Called once by the loader before its initial load attempt.
 */
export function markMarketSessionOverrideStoreRequired(): void {
  state.mode = 'required';
}

/** Atomically replaces the active-override snapshot. */
export function applyMarketSessionOverrideSnapshot(
  entries: readonly MarketSessionOverrideEntry[],
  loadedAt: Date,
): void {
  const next = new Map<string, MarketSessionOverrideEntry>();
  for (const entry of entries) {
    next.set(entryKey(entry.market, entry.localDate), entry);
  }
  state.entries = next;
  state.loaded = true;
  state.loadedAt = loadedAt;
}

/**
 * Whether calendar consumers may trust the override layer. In passthrough
 * mode this is always true (no overrides); in required mode it is true only
 * after the first successful load. A later refresh failure keeps the
 * last-known-good snapshot, so readiness is retained.
 */
export function isMarketSessionOverrideStoreReady(): boolean {
  return state.mode === 'passthrough' || state.loaded;
}

/**
 * Returns the active override for an exchange-local date, or null when none
 * exists. A 'regular' entry is returned as a real entry — callers can
 * distinguish "no override" (null) from "REGULAR override cancelling a static
 * exception" (entry with overrideType 'regular').
 */
export function findActiveMarketSessionOverride(
  market: MarketCalendarMarket,
  localDate: string, // YYYY-MM-DD
): MarketSessionOverrideEntry | null {
  return state.entries.get(entryKey(market, localDate)) ?? null;
}

export function getMarketSessionOverrideStoreStatus(): {
  mode: 'passthrough' | 'required';
  loaded: boolean;
  loadedAt: Date | null;
  activeOverrideCount: number;
} {
  return {
    mode: state.mode,
    loaded: state.loaded,
    loadedAt: state.loadedAt,
    activeOverrideCount: state.entries.size,
  };
}

/** Restores the default passthrough state; call in test afterEach hooks. */
export function resetMarketSessionOverrideStoreForTest(): void {
  state.mode = 'passthrough';
  state.loaded = false;
  state.entries = new Map();
  state.loadedAt = null;
}
