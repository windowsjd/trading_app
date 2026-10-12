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
 * the COMPLETE set of submitted orders (every page) and the complete set of
 * live Conditional BUY watches. Anything that leaves a set is a candidate and
 * is resolved by its own detail read; it is announced only if that detail is
 * an execution. Orders already executed when first seen are history and never
 * candidates, so app start does not replay past fills.
 *
 * DEDUPLICATION. One announcement per (account, order), whichever path
 * (pending order, watch, form) finds it first; refetches, reconnects and
 * replays see the same id and stay silent.
 */
export type FillOrigin = 'order' | 'conditional';

type AccountState = {
  pending: Set<string>;
  watches: Set<string>;
  origins: Map<string, FillOrigin>;
  attempts: Map<string, number>;
};

/** Transient read failures retry on later reads, never without bound. */
export const FILL_RESOLVE_MAX_ATTEMPTS = 3;

export function createFillTracker() {
  const accounts = new Map<string, AccountState>();
  const settled = new Set<string>();
  const account = (accountId: string) => {
    let state = accounts.get(accountId);
    if (!state) {
      state = { pending: new Set(), watches: new Set(), origins: new Map(), attempts: new Map() };
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
    /** An order this session knows is open (created here or linked to a watch). */
    trackOrder(accountId: string, orderId: string, origin: FillOrigin = 'order') {
      const state = account(accountId);
      state.pending.add(orderId);
      if (origin !== 'order' || !state.origins.has(orderId)) state.origins.set(orderId, origin);
    },
    trackWatch(accountId: string, watchId: string) {
      account(accountId).watches.add(watchId);
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
    /** Counts a failed resolve; false once the bound is reached (drop it). */
    retry(accountId: string, key: string) {
      const state = account(accountId);
      const attempts = (state.attempts.get(key) ?? 0) + 1;
      state.attempts.set(key, attempts);
      return attempts < FILL_RESOLVE_MAX_ATTEMPTS;
    },
    /** True exactly once per (account, order): the caller may announce it. */
    settle(accountId: string, orderId: string) {
      const key = `${accountId}:${orderId}`;
      if (settled.has(key)) return false;
      settled.add(key);
      const state = accounts.get(accountId);
      state?.pending.delete(orderId);
      state?.attempts.delete(orderId);
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
};

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
    options.origin === 'conditional' ? '조건주문' : null,
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
