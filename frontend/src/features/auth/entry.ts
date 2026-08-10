import { QUERY_KEYS } from '../../constants/queryKeys.ts';

/**
 * Where an authenticated user lands (작업 13 §2).
 *
 * Two different events used to be answered with one rule ("owns anything →
 * home"), and the rule was wrong for one of them:
 *
 *   - A NEW LOGIN is the user standing at the front door. Which account this
 *     session is about — 일반 투자 or 시즌 투자 — is THEIR decision, and the
 *     app must ask, not guess. The old rule skipped the question entirely: a
 *     user holding only a season account was dropped straight into season
 *     Home, and a season participant who wanted 일반 투자 had no doorway to it
 *     at all.
 *
 *   - A SESSION RESTORE is the same person coming back mid-use. Re-asking the
 *     question every time the OS kills the process would be noise; the stored
 *     selection, if it still names an account they own, is the answer they
 *     already gave.
 *
 * So the route is decided by INTENT plus the stored choice:
 *
 *   new login                        → mode_selection, always. A stored id, an
 *                                      active season, a lone account — none of
 *                                      them skip the question.
 *   session restore, stored id valid → home, on the stored account.
 *   session restore otherwise        → mode_selection. Never "active season by
 *                                      default": losing the stored choice is
 *                                      exactly when the user must choose again.
 *
 * There is deliberately NO 'account_setup' route any more: the mode-selection
 * screen itself offers "일반 투자 시작하기" and season join when the user owns
 * nothing, so "no accounts" is just one more shape of the same question.
 *
 * Deliberately a pure function: no navigator, no client, no network. The
 * screens do the I/O and hand the results here.
 */

export type AuthedEntryRoute = 'home' | 'mode_selection';

/** How this session came to be authenticated. */
export type AuthedEntryIntent = 'new_login' | 'session_restore';

/** The only field the decision needs. Keeps this testable without the DTO. */
export type EntryAccount = { id: string };

export function resolveAuthedEntryRoute(
  intent: AuthedEntryIntent,
  accounts: readonly EntryAccount[] | null | undefined,
  storedAccountId: string | null | undefined,
): AuthedEntryRoute {
  if (
    intent === 'session_restore' &&
    !!storedAccountId &&
    (accounts ?? []).some((account) => account.id === storedAccountId)
  ) {
    return 'home';
  }

  return 'mode_selection';
}

/** The minimal react-query surface this needs; keeps tests client-free. */
export type EntryQueryClient = {
  fetchQuery: <T>(options: {
    queryKey: readonly unknown[];
    queryFn: () => Promise<T>;
    staleTime?: number;
  }) => Promise<T>;
};

/**
 * Reads the owned-account list into the SAME cache entry the account provider
 * reads (`tradingAccount.list(userId)`), then decides the route.
 *
 * Sharing the entry is the point: entry and the provider ask the same question
 * one render apart, and a second request would be both wasted and — if the two
 * answers disagreed — a source of a screen that routes on one list while
 * selecting from another (작업 11 §22).
 *
 * The stored selection is consulted ONLY on a session restore. On a new login
 * it is not even read: the route must not depend on it, and a read that could
 * not change the answer would only invite someone to route on it later.
 *
 * A failure here is deliberately NOT swallowed into "owns nothing": "we could
 * not read your accounts" and "you have none" are different facts, and the
 * second one offers a brand-new account to a user who may have several.
 * Callers handle the throw.
 */
export async function loadEntryRoute<
  T extends { accounts?: readonly EntryAccount[] },
>(
  client: EntryQueryClient,
  userId: string,
  intent: AuthedEntryIntent,
  io: {
    loadAccounts: () => Promise<T>;
    readStoredAccountId: (userId: string) => Promise<string | null>;
  },
): Promise<AuthedEntryRoute> {
  const data = await client.fetchQuery({
    queryKey: QUERY_KEYS.tradingAccount.list(userId),
    queryFn: io.loadAccounts,
    staleTime: 30_000,
  });

  const storedAccountId =
    intent === 'session_restore' ? await io.readStoredAccountId(userId) : null;

  return resolveAuthedEntryRoute(intent, data?.accounts, storedAccountId);
}
