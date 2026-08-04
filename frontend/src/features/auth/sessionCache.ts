import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import type { AuthUserDto } from './api.ts';

/**
 * The CACHE half of the session boundary (작업 10 §A-7 · §A-8).
 *
 * Kept separate from `session.ts` because the two halves fail differently and
 * are worth reasoning about separately: token/AsyncStorage teardown is I/O that
 * can be retried, while the cache teardown is the thing that decides whether
 * the next person to use this device can read the previous user's balances.
 * Splitting them also lets this half be tested without React Native's storage.
 *
 * WHY A FULL CLEAR AND NOT A KEY LIST
 * -----------------------------------
 * Before this, logout removed exactly `['tradingAccount']` and `['me']`.
 * Everything else the user had loaded — `['wallet']`, `['positions']`,
 * `['portfolio']`, `['order']`, `['home','dashboard']`, `['record']`,
 * `['ranking']` — survived into the next session, so the next user's first
 * frame could paint the previous user's numbers.
 *
 * An enumerated allowlist would have fixed those seven keys and silently
 * stopped being complete the next time a feature added an eighth. `clear()`
 * cannot be defeated that way, and it drops the mutation cache in the same
 * call. The cost is re-fetching shared market data on the next login, which is
 * one request on an action that happens rarely.
 *
 * REMOVE, NEVER INVALIDATE
 * ------------------------
 * An invalidated entry is still READABLE from the cache while its refetch is in
 * flight — precisely the window in which the next user's first render happens.
 */

export type SessionQueryClient = {
  clear: () => void;
  setQueryData: (queryKey: readonly unknown[], data: unknown) => unknown;
  invalidateQueries: (filters: {
    queryKey: readonly unknown[];
  }) => Promise<unknown> | unknown;
};

/** Everything this device remembers about the outgoing session. */
export function clearSessionCache(queryClient: SessionQueryClient) {
  queryClient.clear();
}

/**
 * Installs the incoming session, in this order:
 *
 *  1. clear — the previous user's data is gone before anything new is written,
 *     even when one person hands the device to another mid-session;
 *  2. seed `me` from the login response — the account provider gates its
 *     account-list query on `enabled: !!userId`, so without this it sits on the
 *     pre-login 401 and the switcher stays empty until the app restarts;
 *  3. invalidate the account list so it is fetched for the NEW user.
 *
 * The previous user's stored selection needs no deletion here: the storage key
 * is `selectedTradingAccountId:<userId>`, so this user cannot read it.
 */
export async function seedSessionCache(
  queryClient: SessionQueryClient,
  user: AuthUserDto,
) {
  queryClient.clear();
  queryClient.setQueryData(QUERY_KEYS.me, user);
  await queryClient.invalidateQueries({
    queryKey: QUERY_KEYS.tradingAccount.list,
  });
}
