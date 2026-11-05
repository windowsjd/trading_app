import { formatDisplayDecimal, getAssetNameDisplay } from '../../utils/format.ts';
import { enqueueFillNotice, type FillNotice } from './fillTracker.ts';

/**
 * 대기주문 발동·체결 알림 (2026-11-05): the server's confirmed events for one
 * account (GET /trading-accounts/:id/pending-order-events, backend
 * docs/pending-order-events-contract.md) as the app's top banner. Pure, so the
 * rules run under `node --test`.
 *
 * - A FILL is an order the server recorded as executed (Spot) or a Futures
 *   execution. Only a fill says 체결.
 * - A TRIGGER is a condition the server recorded as met while its own fill is
 *   not known. It says 조건 충족, never 체결: the order behind it may still
 *   wait, fail or be canceled, and 거래 내역 has what happened.
 * - CURSOR. The app keeps the server's `serverTime` per account. Without one
 *   (first sign-in on this device, a cleared or unreadable store, a cursor the
 *   server refused) it asks for the cursor only, so nothing old is replayed;
 *   with one it gets what happened since (closed or in the background), up to
 *   the server's window.
 * - DEDUPLICATION. The server looks back a little before the cursor for late
 *   commits, so a key can come twice; the keys last shown are kept with the
 *   cursor. A Spot fill's notice is keyed by its order id, so this feed and the
 *   in-session fill tracker announce it once between them.
 */
export type PendingEventOrigin =
  | 'limit'
  | 'loc'
  | 'condition'
  | 'stop_loss'
  | 'take_profit'
  | 'protection'
  | 'futures_limit'
  | 'futures_condition'
  | 'futures_stop_loss'
  | 'futures_take_profit'
  | 'futures_protection';

export type PendingOrderEventDto = {
  key: string;
  type: 'fill' | 'trigger';
  market: 'spot' | 'futures';
  origin: PendingEventOrigin;
  side: 'buy' | 'sell' | null;
  direction: 'long' | 'short' | null;
  asset: { id: string; symbol: string; name: string; market: string };
  quantity: string | null;
  price: string | null;
  currencyCode: string;
  executionType: 'market' | 'limit' | null;
  at: string;
  visibleAt: string;
};

export type PendingOrderEventsDto = {
  tradingAccountId: string;
  serverTime: string;
  events: PendingOrderEventDto[];
  total: number;
};

export type PendingEventCursor = { cursor: string; seen: string[] };

/** Foreground only; nothing is read in the background. */
export const PENDING_EVENT_POLL_MS = 30_000;
/** Keys kept with the cursor: far more than one look-back window can hold. */
export const PENDING_EVENT_SEEN_MAX = 200;

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u;
const SPOT_FILL_PREFIX = 'fill:spot_order:';

/** A stored cursor; anything malformed is none (a fresh start replays nothing). */
export function parsePendingEventCursor(raw: string | null | undefined): PendingEventCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { cursor?: unknown; seen?: unknown } | null;
    const cursor = value?.cursor;
    if (typeof cursor !== 'string' || !ISO.test(cursor) || Number.isNaN(Date.parse(cursor))) return null;
    const seen = Array.isArray(value?.seen) ? value.seen.filter((key): key is string => typeof key === 'string') : [];
    return { cursor, seen: seen.slice(-PENDING_EVENT_SEEN_MAX) };
  } catch {
    return null;
  }
}

/**
 * One read's outcome: the events to announce (new keys, oldest first), how
 * many older ones the server did not send, and the cursor to keep.
 */
export function advancePendingEvents(previous: PendingEventCursor | null, page: PendingOrderEventsDto) {
  // No cursor: this read only set one.
  if (!previous) return { announce: [] as PendingOrderEventDto[], skipped: 0, next: { cursor: page.serverTime, seen: [] as string[] } };
  const seen = new Set(previous.seen);
  const announce = page.events.filter((event) => {
    if (seen.has(event.key)) return false;
    seen.add(event.key);
    return true;
  });
  return {
    announce,
    skipped: Math.max(0, page.total - page.events.length),
    next: { cursor: page.serverTime, seen: [...previous.seen, ...announce.map((event) => event.key)].slice(-PENDING_EVENT_SEEN_MAX) },
  };
}

const SPOT_LABEL: Partial<Record<PendingEventOrigin, string>> = {
  condition: '조건주문',
  stop_loss: '손절',
  take_profit: '익절',
  protection: '기존 손절/익절',
};
const FUTURES_CLOSE: Partial<Record<PendingEventOrigin, string>> = {
  futures_stop_loss: '손절',
  futures_take_profit: '익절',
  futures_protection: '손절/익절',
};
const FUTURES_ENTRY_LABEL: Partial<Record<PendingEventOrigin, string>> = {
  futures_limit: '선물 지정가',
  futures_condition: '선물 조건주문',
};

const direction = (value: PendingOrderEventDto['direction']) => (value === 'long' ? '롱' : value === 'short' ? '숏' : null);
const side = (value: PendingOrderEventDto['side']) => (value === 'buy' ? '매수' : value === 'sell' ? '매도' : null);

/** One event as a banner; null for a shape this app does not know. */
export function buildPendingEventNotice(accountId: string, event: PendingOrderEventDto, accountLabel: string | null = null): FillNotice | null {
  if (!event.key || (event.type !== 'fill' && event.type !== 'trigger')) return null;
  const name = getAssetNameDisplay(event.asset).primary;
  const futures = event.market === 'futures';
  // A Spot fill is its order's notice (the in-session tracker uses the same key).
  const orderId = event.type === 'fill' && event.key.startsWith(SPOT_FILL_PREFIX) ? event.key.slice(SPOT_FILL_PREFIX.length) : event.key;
  const history = futures ? { history: { market: 'futures' as const, futuresView: 'executions' as const } } : {};
  const parts = (...values: Array<string | null | undefined>) => {
    const kept = values.filter((value): value is string => !!value);
    return kept.length ? kept.join(' · ') : null;
  };
  if (event.type === 'fill') {
    const quantity = event.quantity ? `체결 수량 ${formatDisplayDecimal(event.quantity)}` : null;
    if (futures) {
      const way = direction(event.direction);
      if (!way) return null;
      const close = FUTURES_CLOSE[event.origin];
      return { id: `${accountId}:${orderId}`, accountId, orderId, ...history,
        title: `${name} ${way} ${close ?? '진입'} 체결 완료`,
        detail: parts(accountLabel, close ? null : FUTURES_ENTRY_LABEL[event.origin], quantity) };
    }
    const action = side(event.side);
    if (!action) return null;
    return { id: `${accountId}:${orderId}`, accountId, orderId,
      title: `${name} ${event.origin === 'loc' ? 'LOC ' : ''}${action} 체결 완료`,
      detail: parts(accountLabel, SPOT_LABEL[event.origin], quantity) };
  }
  const watched = event.price ? `감시가격 ${formatDisplayDecimal(event.price)} 도달` : null;
  const kind = futures
    ? `${direction(event.direction) ?? ''} ${FUTURES_CLOSE[event.origin] ?? '조건주문'}`.trim()
    : event.origin === 'condition' ? `조건주문 ${side(event.side) ?? ''}`.trim() : SPOT_LABEL[event.origin] ?? '조건주문';
  return { id: `${accountId}:${orderId}`, accountId, orderId, trigger: true, ...history,
    title: `${name} ${kind} 조건 충족`,
    // What followed (a fill, a wait on the book, a failure) is the history's to say.
    detail: parts(accountLabel, watched, '처리 결과는 거래 내역에서 확인할 수 있어요') };
}

/** Queues a read's notices in order; older events the server left out fold into the last one. */
export function enqueuePendingEventNotices(queue: readonly FillNotice[], notices: readonly FillNotice[], skipped: number): FillNotice[] {
  const next = notices.reduce<FillNotice[]>((current, notice) => enqueueFillNotice(current, notice), [...queue]);
  if (!skipped || !notices.length || !next.length) return next;
  const last = next[next.length - 1];
  return [...next.slice(0, -1), { ...last, overflow: (last.overflow ?? 0) + skipped, overflowMixed: true }];
}
