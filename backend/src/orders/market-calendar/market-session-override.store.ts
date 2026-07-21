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

/**
 * Runtime lifecycle of the override snapshot, for readiness reporting:
 * - 'passthrough': the loader never registered (unit tests, tooling
 *   processes). The static calendar is authoritative; nothing to report.
 * - 'not_loaded': required mode, the first load has not completed yet and no
 *   attempt has failed. Stock calendars are fail-closed.
 * - 'unavailable': required mode, the first load failed and none has
 *   succeeded since (cold-start failure). Stock calendars are fail-closed.
 * - 'ready': a load succeeded and the most recent refresh also succeeded.
 * - 'last_known_good': a load succeeded but the most recent refresh failed;
 *   the last successful snapshot keeps serving (degraded, not fail-closed).
 */
export type MarketSessionOverrideRuntimeState =
  | 'passthrough'
  | 'not_loaded'
  | 'unavailable'
  | 'ready'
  | 'last_known_good';

type StoreState = {
  mode: 'passthrough' | 'required';
  loaded: boolean;
  entries: Map<string, MarketSessionOverrideEntry>;
  loadedAt: Date | null;
  lastRefreshFailedAt: Date | null;
};

const state: StoreState = {
  mode: 'passthrough',
  loaded: false,
  entries: new Map(),
  loadedAt: null,
  lastRefreshFailedAt: null,
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
  state.lastRefreshFailedAt = null;
}

/**
 * Records a failed load/refresh attempt so readiness can distinguish a
 * cold-start failure ('unavailable') and a stale-but-serving snapshot
 * ('last_known_good') without touching the DB. Cleared by the next
 * successful applyMarketSessionOverrideSnapshot.
 */
export function recordMarketSessionOverrideRefreshFailure(
  failedAt: Date,
): void {
  state.lastRefreshFailedAt = failedAt;
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

/**
 * Synchronous runtime status for readiness reporting. Never queries the DB —
 * it only reads what the loader has already recorded here.
 */
export function getMarketSessionOverrideRuntimeStatus(): {
  mode: 'passthrough' | 'required';
  state: MarketSessionOverrideRuntimeState;
  loaded: boolean;
  loadedAt: Date | null;
  lastRefreshFailedAt: Date | null;
  activeOverrideCount: number;
} {
  const runtimeState: MarketSessionOverrideRuntimeState =
    state.mode === 'passthrough'
      ? 'passthrough'
      : state.loaded
        ? state.lastRefreshFailedAt
          ? 'last_known_good'
          : 'ready'
        : state.lastRefreshFailedAt
          ? 'unavailable'
          : 'not_loaded';
  return {
    mode: state.mode,
    state: runtimeState,
    loaded: state.loaded,
    loadedAt: state.loadedAt,
    lastRefreshFailedAt: state.lastRefreshFailedAt,
    activeOverrideCount: state.entries.size,
  };
}

/** Restores the default passthrough state; call in test afterEach hooks. */
export function resetMarketSessionOverrideStoreForTest(): void {
  state.mode = 'passthrough';
  state.loaded = false;
  state.entries = new Map();
  state.loadedAt = null;
  state.lastRefreshFailedAt = null;
}
