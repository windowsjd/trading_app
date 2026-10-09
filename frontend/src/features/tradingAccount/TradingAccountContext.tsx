import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { getMe } from '../me/api';
import {
  getTradingAccounts,
  type TradingAccountDto,
  type TradingAccountsDto,
} from './api';
import {
  selectTradingAccountId,
  sortAccountsForDisplay,
  type AccountSelectionReason,
} from './accountSelection';
import {
  getTradingAccountCapabilities,
  nextCapabilityBoundary,
  type TradingAccountCapabilities,
} from './capabilities';
import {
  clearSelectedAccountId,
  readSelectedAccountId,
  writeSelectedAccountId,
} from './selectionStorage';

/**
 * THE single source of truth for "which trading account is this screen about"
 * (작업 9 §B-1 · §B-2).
 *
 * One small context on top of the react-query cache the app already uses. No
 * new global state library, no store, no reducer: the owned-account list is
 * server state and lives in react-query like every other server read, and the
 * only genuinely client-side fact — the chosen id — is one `useState` plus one
 * AsyncStorage entry.
 *
 * WHAT THIS CONTEXT DELIBERATELY DOES NOT DO
 * ------------------------------------------
 * It never merges, copies, or aggregates data across accounts. Switching is a
 * change of subject, not a combination: a season account and a general account
 * have separate wallets, positions, orders, funding, and return-rate meanings,
 * and any screen that added them together would be inventing a number that
 * exists nowhere in the ledger.
 *
 * It also never creates anything. Selecting an account issues reads only —
 * entering general mode is an explicit POST the user makes elsewhere, and a GET
 * must not conjure an account, a wallet, or a funding grant as a side effect of
 * someone opening a screen.
 */

export type TradingAccountContextValue = {
  accounts: TradingAccountDto[];
  beginnerModeEnabled: boolean;
  selectedAccountId: string | null;
  selectedAccount: TradingAccountDto | null;
  capabilities: TradingAccountCapabilities | null;
  selectionReason: AccountSelectionReason;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isEmpty: boolean;
  selectAccount: (accountId: string) => void;
  /**
   * Refetches the owned-account list and RESOLVES WITH IT, so a flow that just
   * created an account (season join, general open) can find the new account in
   * the same list the provider now renders from — no second read, no window in
   * which the two disagree.
   */
  refetchAccounts: () => Promise<{ data?: TradingAccountsDto }>;
  /**
   * Called when a request for the selected account came back "not mine":
   * refetch the owned list and let the selection policy land somewhere valid.
   */
  handleSelectedAccountMissing: () => Promise<void>;
};

const TradingAccountContext = createContext<TradingAccountContextValue | null>(
  null,
);

export function TradingAccountProvider({ children }: PropsWithChildren) {
  const [capabilityRevision, setCapabilityRevision] = useState(0);
  const queryClient = useQueryClient();
  // Session clear removes the observed /me Query object, then login seeds a
  // new one. QueryObserver does not notify its consumer on cache removal.
  // Follow that identity change so this long-lived provider reattaches, even
  // when no other state update happens between clear and seed. Data updates
  // still use useQuery; no session data or credentials are retained here.
  const readMeQueryIdentity = useCallback(
    () => queryClient.getQueryCache().find({ queryKey: QUERY_KEYS.me, exact: true }), [queryClient],
  );
  useSyncExternalStore(
    useCallback((notify) => queryClient.getQueryCache().subscribe(event => {
      if ((event.type === 'added' || event.type === 'removed') &&
          event.query.queryKey.length === 1 && event.query.queryKey[0] === 'me') notify();
    }), [queryClient]),
    readMeQueryIdentity,
    readMeQueryIdentity,
  );
  const [storedAccountId, setStoredAccountId] = useState<string | null>(null);
  const [storedLoadedForUserId, setStoredLoadedForUserId] = useState<
    string | null
  >(null);
  const [explicitAccountId, setExplicitAccountId] = useState<string | null>(
    null,
  );

  const meQuery = useQuery({
    queryKey: QUERY_KEYS.me,
    queryFn: getMe,
    staleTime: 60_000,
  });
  const userId = meQuery.data?.id ?? null;

  const accountsQuery = useQuery({
    // Keyed by user (작업 11 §3.1): two users on one device never read one
    // another's owned-account list, independently of clear-on-logout timing.
    queryKey: QUERY_KEYS.tradingAccount.list(userId ?? 'anonymous'),
    queryFn: getTradingAccounts,
    enabled: !!userId,
    staleTime: 30_000,
  });

  const accounts = useMemo(
    () => sortAccountsForDisplay((accountsQuery.data?.accounts ?? []).filter(
      account => account.mode !== 'beginner' || accountsQuery.data?.beginnerModeEnabled === true,
    )),
    [accountsQuery.data],
  );

  // The persisted choice is loaded once per user. When the user changes, the
  // in-memory selection is dropped FIRST so no render can hand the new user the
  // previous user's accountId (작업 9 §B-2).
  useEffect(() => {
    let cancelled = false;

    if (!userId) {
      setStoredAccountId(null);
      setExplicitAccountId(null);
      setStoredLoadedForUserId(null);
      return;
    }

    if (storedLoadedForUserId === userId) {
      return;
    }

    setExplicitAccountId(null);
    setStoredAccountId(null);

    void readSelectedAccountId(userId).then((value) => {
      if (cancelled) return;
      setStoredAccountId(value);
      setStoredLoadedForUserId(userId);
    });

    return () => {
      cancelled = true;
    };
  }, [userId, storedLoadedForUserId]);

  const selection = useMemo(
    () =>
      selectTradingAccountId(accounts, explicitAccountId ?? storedAccountId),
    [accounts, explicitAccountId, storedAccountId],
  );

  const selectedAccount = useMemo(
    () =>
      accounts.find((account) => account.id === selection.accountId) ?? null,
    [accounts, selection.accountId],
  );
  // The account list can be warm before AsyncStorage resolves on session
  // restore. Treat that preference read as loading so consumers never render
  // the policy fallback account for a frame before the user's choice arrives.
  const selectionIsLoading =
    !!userId && storedLoadedForUserId !== userId;

  const selectAccount = useCallback(
    (accountId: string) => {
      // Switching subjects: cancel the OUTGOING account's in-flight queries so
      // a slow response cannot resolve after the switch and repaint the new
      // account's screen with the old account's numbers (작업 9 §B-4).
      const previousId = selection.accountId;
      if (previousId && previousId !== accountId) {
        void queryClient.cancelQueries({
          queryKey: ['tradingAccount'],
          predicate: (query) => query.queryKey.includes(previousId),
        });
      }

      setExplicitAccountId(accountId);
      if (userId) {
        void writeSelectedAccountId(userId, accountId);
      }
    },
    [queryClient, selection.accountId, userId],
  );

  const handleSelectedAccountMissing = useCallback(async () => {
    if (userId) {
      await clearSelectedAccountId(userId);
    }
    setExplicitAccountId(null);
    setStoredAccountId(null);
    await accountsQuery.refetch();
  }, [accountsQuery, userId]);

  useEffect(() => {
    const now = Date.now();
    const boundary = nextCapabilityBoundary(selectedAccount, now);
    if (boundary === null) return;
    const timer = setTimeout(
      () => setCapabilityRevision((revision) => revision + 1),
      Math.min(boundary - now, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [selectedAccount, capabilityRevision]);

  const capabilityNow = Date.now();
  const value = useMemo<TradingAccountContextValue>(
    () => ({
      accounts,
      beginnerModeEnabled: accountsQuery.data?.beginnerModeEnabled === true,
      selectedAccountId: selection.accountId,
      selectedAccount,
      capabilities: getTradingAccountCapabilities(
        selectedAccount,
        capabilityNow,
      ),
      selectionReason: selection.reason,
      isLoading:
        meQuery.isLoading || accountsQuery.isLoading || selectionIsLoading,
      isError: accountsQuery.isError,
      error: accountsQuery.error,
      isEmpty:
        !accountsQuery.isLoading &&
        !selectionIsLoading &&
        accounts.length === 0,
      selectAccount,
      refetchAccounts: accountsQuery.refetch,
      handleSelectedAccountMissing,
    }),
    [
      accounts,
      capabilityNow,
      accountsQuery.data?.beginnerModeEnabled,
      selection.accountId,
      selection.reason,
      selectedAccount,
      meQuery.isLoading,
      accountsQuery.isLoading,
      selectionIsLoading,
      accountsQuery.isError,
      accountsQuery.error,
      accountsQuery.refetch,
      selectAccount,
      handleSelectedAccountMissing,
    ],
  );

  return (
    <TradingAccountContext.Provider value={value}>
      {children}
    </TradingAccountContext.Provider>
  );
}

export function useTradingAccount(): TradingAccountContextValue {
  const value = useContext(TradingAccountContext);

  if (!value) {
    throw new Error(
      'useTradingAccount must be used inside a TradingAccountProvider.',
    );
  }

  return value;
}

/**
 * Everything that must be forgotten when the session ends (작업 9 §B-2).
 *
 * The account list and every account-scoped financial entry are REMOVED, not
 * merely invalidated: an invalidated entry is still readable from the cache
 * while its refetch is in flight, so the next user's first frame could render
 * the previous user's balances. Removal has no such window.
 */
export async function clearTradingAccountSession(
  queryClient: {
    removeQueries: (filters: { queryKey: readonly unknown[] }) => void;
  },
  userId?: string | null,
) {
  queryClient.removeQueries({ queryKey: QUERY_KEYS.tradingAccount.all });
  queryClient.removeQueries({ queryKey: QUERY_KEYS.me });

  if (userId) {
    await clearSelectedAccountId(userId);
  }
}
