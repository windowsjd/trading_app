import { formatDisplayDecimal, getAssetNameDisplay } from '../../utils/format.ts';

/**
 * Real-fill detection for the top banner (order UI 2nd phase). Pure state, so
 * the rules run under `node --test`; the React watcher only feeds it reads.
 *
 * SOURCE OF TRUTH. A notice is built only from an order the server reports as
 * `executed` with an `executedAt`. A quote, a submitted limit/LOC order, a
 * registered or triggered watch, a cancel or an unknown result never is.
 *
 * WHY A SET DIFF. The order list is `submittedAt DESC`, so a page of recent
 * orders misses an old limit order that fills today. Instead the watcher reads
 * the COMPLETE set of submitted orders (every page) and the complete sets of
 * live Conditional BUY watches and live SELL intents (condition, stop-loss,
 * take-profit). Anything that leaves a set is a candidate and
 * is resolved by its own detail read; it is announced only if that detail is
 * an execution. Orders already executed when first seen are history and never
 * candidates, so app start does not replay past fills.
 *
 * DEDUPLICATION. One announcement per (account, order), whichever path
 * (pending order, watch, form) finds it first; refetches, reconnects and
 * replays see the same id and stay silent. A target is read by one request
 * at a time.
 *
 * UNRESOLVED READS. A detail read that fails transiently proves nothing (not a
 * fill, not a cancel), so the target is kept, not forgotten after a few tries:
 * it is re-read with backoff (15 s doubling to 5 min) while the app is in the
 * foreground, and once more right away when the app comes back. The memory
 * and request cost stay bounded: at most 30 targets per account, each given
 * up 24 h after its first failure (the order history still has the result).
 */
export type FillOrigin = 'order' | 'conditional' | 'stop_loss' | 'take_profit';

/** `watch` = Conditional BUY watch, `sell_watch` = SELL condition / stop-loss / take-profit. */
export type FillTarget = { kind: 'order' | 'watch' | 'sell_watch'; id: string; origin: FillOrigin };
type Unresolved = FillTarget & { failures: number; since: number; retryAt: number };

type AccountState = {
  pending: Set<string>;
  watches: Set<string>;
  sellWatches: Set<string>;
  /** Only for orders still open in this session; dropped once resolved. */
  origins: Map<string, FillOrigin>;
  /** Keyed like `reading`: order id, or `watch:<id>`; insertion order = oldest first. */
  unresolved: Map<string, Unresolved>;
  reading: Set<string>;
};

export const FILL_RETRY_BASE_MS = 15_000;
export const FILL_RETRY_MAX_MS = 5 * 60_000;
export const FILL_UNRESOLVED_MAX_AGE_MS = 24 * 60 * 60_000;
export const FILL_UNRESOLVED_MAX = 30;
/**
 * Announced (account, order) keys kept for deduplication. An executed order
 * never re-enters an open set, so only recent ones can be seen again; the
 * oldest beyond this bound are forgotten instead of growing for the whole
 * session.
 */
export const FILL_SETTLED_MAX = 500;

/** Backoff after the n-th consecutive failure (n ≥ 1). */
export function fillRetryDelay(failures: number) {
  return Math.min(FILL_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), FILL_RETRY_MAX_MS);
}

/**
 * A failed detail read worth repeating: no response, a timeout, a server or
 * rate-limit error. A definite refusal (the order is not this account's, not
 * found, malformed) will not change by asking again.
 */
export function isTransientFillReadFailure(info: { hasResponse: boolean; status: number | null }) {
  return !info.hasResponse || info.status === null || ![400, 403, 404, 410, 422].includes(info.status);
}

const targetKey = (kind: FillTarget['kind'], id: string) =>
  kind === 'order' ? id : kind === 'watch' ? `watch:${id}` : `sell:${id}`;

export function createFillTracker() {
  const accounts = new Map<string, AccountState>();
  const settled = new Set<string>();
  const account = (accountId: string) => {
    let state = accounts.get(accountId);
    if (!state) {
      state = { pending: new Set(), watches: new Set(), sellWatches: new Set(), origins: new Map(), unresolved: new Map(), reading: new Set() };
      accounts.set(accountId, state);
    }
    return state;
  };
  const diff = (known: Set<string>, ids: Iterable<string>) => {
    const current = new Set(ids);
    const gone = [...known].filter((id) => !current.has(id));
    return { current, gone };
  };
  return {
    /** A complete, successful read of submitted orders; returns ids that left it. */
    observePending(accountId: string, ids: Iterable<string>) {
      const state = account(accountId);
      const { current, gone } = diff(state.pending, ids);
      state.pending = current;
      return gone;
    },
    /** A complete, successful read of live watches; returns ids that left it. */
    observeWatches(accountId: string, ids: Iterable<string>) {
      const state = account(accountId);
      const { current, gone } = diff(state.watches, ids);
      state.watches = current;
      return gone;
    },
    /** A complete, successful read of live SELL intents; returns ids that left it. */
    observeSellWatches(accountId: string, ids: Iterable<string>) {
      const state = account(accountId);
      const { current, gone } = diff(state.sellWatches, ids);
      state.sellWatches = current;
      return gone;
    },
    /** An order this session knows is open (created here or linked to a watch). */
    trackOrder(accountId: string, orderId: string, origin: FillOrigin = 'order') {
      const state = account(accountId);
      state.pending.add(orderId);
      if (origin !== 'order' || !state.origins.has(orderId)) state.origins.set(orderId, origin);
    },
    trackWatch(accountId: string, watchId: string) {
      account(accountId).watches.add(watchId);
    },
    trackSellWatch(accountId: string, watchId: string) {
      account(accountId).sellWatches.add(watchId);
    },
    /** An order resolved without a fill (canceled/rejected): nothing left to keep. */
    forgetOrder(accountId: string, orderId: string) {
      const state = accounts.get(accountId);
      state?.pending.delete(orderId);
      state?.origins.delete(orderId);
    },
    originOf(accountId: string, orderId: string): FillOrigin {
      return accounts.get(accountId)?.origins.get(orderId) ?? 'order';
    },
    hasOpenOrders(accountId: string) {
      return (accounts.get(accountId)?.pending.size ?? 0) > 0;
    },
    hasOpenWatches(accountId: string) {
      return (accounts.get(accountId)?.watches.size ?? 0) > 0;
    },
    hasOpenSellWatches(accountId: string) {
      return (accounts.get(accountId)?.sellWatches.size ?? 0) > 0;
    },
    /** Claims the one detail read of a target; false while another is running. */
    beginRead(accountId: string, kind: FillTarget['kind'], id: string) {
      const state = account(accountId);
      const key = targetKey(kind, id);
      if (state.reading.has(key)) return false;
      state.reading.add(key);
      return true;
    },
    endRead(accountId: string, kind: FillTarget['kind'], id: string) {
      accounts.get(accountId)?.reading.delete(targetKey(kind, id));
    },
    /** The read answered (whatever the outcome): nothing left to retry. */
    resolved(accountId: string, kind: FillTarget['kind'], id: string) {
      accounts.get(accountId)?.unresolved.delete(targetKey(kind, id));
    },
    /** A transient read failure: keep the target and back off. */
    defer(accountId: string, target: FillTarget, now: number) {
      const state = account(accountId);
      const key = targetKey(target.kind, target.id);
      const previous = state.unresolved.get(key);
      const since = previous?.since ?? now;
      if (now - since >= FILL_UNRESOLVED_MAX_AGE_MS) {
        state.unresolved.delete(key);
        return;
      }
      const failures = (previous?.failures ?? 0) + 1;
      state.unresolved.set(key, { ...target, failures, since, retryAt: now + fillRetryDelay(failures) });
      // The oldest target gives way; its result stays in the order history.
      while (state.unresolved.size > FILL_UNRESOLVED_MAX) state.unresolved.delete(state.unresolved.keys().next().value);
    },
    /** Unresolved targets due now and not being read; expired ones are dropped. */
    due(accountId: string, now: number): FillTarget[] {
      const state = accounts.get(accountId);
      if (!state) return [];
      const targets: FillTarget[] = [];
      for (const [key, entry] of state.unresolved) {
        if (now - entry.since >= FILL_UNRESOLVED_MAX_AGE_MS) state.unresolved.delete(key);
        else if (entry.retryAt <= now && !state.reading.has(key))
          targets.push({ kind: entry.kind, id: entry.id, origin: entry.origin });
      }
      return targets;
    },
    /** When the next unresolved target is due, or null when none waits. */
    nextRetryAt(accountId: string): number | null {
      const state = accounts.get(accountId);
      let next: number | null = null;
      for (const [key, entry] of state?.unresolved ?? []) {
        if (state?.reading.has(key)) continue;
        next = next === null ? entry.retryAt : Math.min(next, entry.retryAt);
      }
      return next;
    },
    /** Back in the foreground: every unresolved target is checked once now. */
    wake(now: number) {
      for (const state of accounts.values())
        for (const entry of state.unresolved.values()) entry.retryAt = Math.min(entry.retryAt, now);
    },
    /** True exactly once per (account, order): the caller may announce it. */
    settle(accountId: string, orderId: string) {
      const key = `${accountId}:${orderId}`;
      if (settled.has(key)) return false;
      settled.add(key);
      // Insertion order = oldest first; recent announcements stay deduplicated.
      while (settled.size > FILL_SETTLED_MAX) settled.delete(settled.values().next().value as string);
      const state = accounts.get(accountId);
      state?.pending.delete(orderId);
      state?.unresolved.delete(orderId);
      state?.origins.delete(orderId);
      return true;
    },
  };
}

export type FillTracker = ReturnType<typeof createFillTracker>;

export type FillNotice = {
  /** `${accountId}:${orderId}` — the dedupe key. */
  id: string;
  accountId: string;
  orderId: string;
  title: string;
  detail: string | null;
  /** Further notices folded into this one when the queue is full. */
  overflow?: number;
  /** 내역 보기 target inside 거래 내역; the Spot list when absent. */
  history?: { market: 'futures'; futuresView: 'liquidations' };
};

/** A foreground liquidation push as a banner (its own copy, its own key). */
export function buildLiquidationNotice(event: {
  accountId: string;
  liquidationId: string;
  title: string;
  detail: string | null;
}): FillNotice {
  const orderId = `liquidation:${event.liquidationId}`;
  return {
    id: `${event.accountId}:${orderId}`,
    accountId: event.accountId,
    orderId,
    title: event.title,
    detail: event.detail,
    history: { market: 'futures', futuresView: 'liquidations' },
  };
}

/** The order fields a notice may use; all read from the server's order. */
export type FilledOrderFacts = {
  orderId?: string | null;
  id?: string | null;
  status?: string | null;
  side?: string | null;
  executedAt?: string | null;
  quantity?: string | null;
  asset?: { name?: string | null; symbol?: string | null } | null;
  marketExecution?: { status?: string | null; executedQuantity?: string | null } | null;
  limitOnClose?: unknown;
};

const ORIGIN_LABEL: Record<Exclude<FillOrigin, 'order'>, string> = {
  conditional: '조건주문',
  stop_loss: '손절',
  take_profit: '익절',
};

export function buildFillNotice(
  accountId: string,
  order: FilledOrderFacts,
  options: { origin?: FillOrigin; accountLabel?: string | null } = {},
): FillNotice | null {
  const orderId = order.orderId ?? order.id;
  if (!orderId || order.status !== 'executed' || !order.executedAt) return null;
  if (order.side !== 'buy' && order.side !== 'sell') return null;
  const name = getAssetNameDisplay(order.asset).primary;
  const side = order.side === 'buy' ? '매수' : '매도';
  const loc = order.limitOnClose != null;
  const partial = order.marketExecution?.status === 'partial';
  const quantity = order.marketExecution?.executedQuantity ?? order.quantity;
  const detail = [
    options.accountLabel || null,
    options.origin && options.origin !== 'order' ? ORIGIN_LABEL[options.origin] : null,
    quantity ? `체결 수량 ${formatDisplayDecimal(quantity)}` : null,
  ].filter((part): part is string => !!part);
  return {
    id: `${accountId}:${orderId}`,
    accountId,
    orderId,
    title: `${name} ${loc ? 'LOC ' : ''}${side} ${partial ? '일부 체결' : '체결 완료'}`,
    detail: detail.length ? detail.join(' · ') : null,
  };
}

/** Banners show one at a time; at most `max` wait, the rest fold into the last. */
export function enqueueFillNotice(queue: readonly FillNotice[], notice: FillNotice, max = 3): FillNotice[] {
  if (queue.some((item) => item.id === notice.id)) return [...queue];
  if (queue.length < max) return [...queue, notice];
  const last = queue[queue.length - 1];
  return [...queue.slice(0, -1), { ...last, overflow: (last.overflow ?? 0) + 1 + (notice.overflow ?? 0) }];
}

/**
 * Accounts whose fills are watched: every owned account that can still hold an
 * open spot order. A Season account outside its active Season has none (the
 * Season lifecycle cancels them).
 */
export function isFillWatchAccount(account: {
  status: string;
  mode: string;
  season?: { seasonStatus?: string | null } | null;
}) {
  if (account.status === 'closed') return false;
  if (account.mode === 'season') return account.season?.seasonStatus === 'active';
  return true;
}
