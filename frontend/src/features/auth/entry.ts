import { QUERY_KEYS } from '../../constants/queryKeys.ts';

/**
 * Where an authenticated user lands — decided by the accounts they OWN, not by
 * whether a season happens to be running (작업 11 §3).
 *
 * The app used to ask `getCurrentSeason()` at every entry point (splash, login,
 * signup) and route on the answer. That conflates two unrelated questions:
 *
 *   - "is there a season to join?" — a property of the SERVER, and
 *   - "does this user have an account to use?" — a property of the USER.
 *
 * A user holding a general account, with every season settled, is fully able to
 * use the app: they have a wallet, holdings, a return rate, and history. Routing
 * them to the season screen because no season is open sends a working user to a
 * page about something they are not doing. The reverse is just as wrong — an
 * active season says nothing about whether THIS user joined it.
 *
 * So entry asks the account list. `getCurrentSeason()` keeps its real jobs
 * (may I join, what is the public season, which season does the leaderboard
 * default to) and loses the one it was never able to answer.
 *
 * Deliberately a pure function over the list: no navigator, no client, no
 * network. The screens do the I/O and hand the result here.
 */

export type AuthedEntryRoute = 'home' | 'account_setup';

/** The only field the decision needs. Keeps this testable without the DTO. */
export type EntryAccount = { id: string };

export function resolveAuthedEntryRoute(
  accounts: readonly EntryAccount[] | null | undefined,
): AuthedEntryRoute {
  return (accounts?.length ?? 0) > 0 ? 'home' : 'account_setup';
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
 * A failure here is deliberately NOT swallowed into `account_setup`: "we could
 * not read your accounts" and "you have none" are different facts, and the
 * second one strands a user with accounts on a signup screen. Callers handle
 * the throw.
 */
export async function loadEntryRoute<T extends { accounts?: readonly EntryAccount[] }>(
  client: EntryQueryClient,
  userId: string,
  loadAccounts: () => Promise<T>,
): Promise<AuthedEntryRoute> {
  const data = await client.fetchQuery({
    queryKey: QUERY_KEYS.tradingAccount.list(userId),
    queryFn: loadAccounts,
    staleTime: 30_000,
  });

  return resolveAuthedEntryRoute(data?.accounts);
}
