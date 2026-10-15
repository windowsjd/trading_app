import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Every KOSCOM request attempt is attributed to exactly one category so the
 * daily/monthly budget (design v2.1 §7) can be measured and, later, enforced
 * per priority. Categories describe WHY the call was made, not the endpoint:
 * the same intraday 1-minute endpoint is `minute` for the central tick,
 * `gap_repair` for the post-close repair and `user_request` when a chart
 * request triggers it.
 */
export const KOSCOM_CALL_CATEGORIES = [
  'price',
  'orderbook',
  'lists',
  'daily',
  'loc',
  'recover_close',
  'minute',
  'gap_repair',
  'user_request',
  'long_4h',
  'weekly',
  'backfill',
  'other',
] as const;

export type KoscomCallCategory = (typeof KOSCOM_CALL_CATEGORIES)[number];

/**
 * Budget priority (design v2.1 §3/§7.6): P1 price/lists, P2 post-close
 * evidence, P3 intraday minute work, P4 everything deferrable. The unused
 * order book is P4 so it is the first thing a governor cuts.
 */
export const KOSCOM_CALL_PRIORITY: Record<KoscomCallCategory, 1 | 2 | 3 | 4> = {
  price: 1,
  lists: 1,
  daily: 2,
  loc: 2,
  recover_close: 2,
  minute: 3,
  gap_repair: 3,
  user_request: 3,
  long_4h: 4,
  weekly: 4,
  backfill: 4,
  orderbook: 4,
  other: 4,
};

const callContext = new AsyncLocalStorage<KoscomCallCategory>();

/** Attributes every KOSCOM call made inside `work` to `category`. */
export function runWithKoscomCallCategory<T>(
  category: KoscomCallCategory,
  work: () => T,
): T {
  return callContext.run(category, work);
}

export function currentKoscomCallCategory(): KoscomCallCategory | undefined {
  return callContext.getStore();
}

/**
 * Endpoint-based attribution for calls made outside any explicit context.
 * Explicit contexts (recover_close, loc, gap_repair, user_request, backfill)
 * always win over this guess.
 */
export function inferKoscomCallCategory(
  path: string,
  query: Readonly<Record<string, string>>,
): KoscomCallCategory {
  if (/\/price$/u.test(path)) return 'price';
  if (/\/orderbook$/u.test(path)) return 'orderbook';
  if (/\/lists$/u.test(path)) return 'lists';
  if (/\/intraday$/u.test(path))
    return query.inddCycleTpCd === '600' ? 'long_4h' : 'minute';
  if (/\/history$/u.test(path))
    return query.trnsmCycleTpCd === 'W' ? 'weekly' : 'daily';
  return 'other';
}
