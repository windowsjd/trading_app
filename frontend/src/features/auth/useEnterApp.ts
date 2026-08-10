import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useRootNavigation } from '../../app/navigation/navigationHooks';
import {
  resetToHome,
  resetToModeSelection,
} from '../../app/navigation/seasonRouting';
import { getTradingAccounts } from '../tradingAccount/api';
import { readSelectedAccountId } from '../tradingAccount/selectionStorage';
import { loadEntryRoute, type AuthedEntryIntent } from './entry';

/**
 * The ONE way into the app after authentication (작업 11 §3 · 작업 13 §2).
 *
 * Splash, login, and signup all had their own copy of "ask for the current
 * season, then route on it". They now share this: read the user's accounts,
 * and go where the entry decision says. The decision itself lives in
 * `entry.ts` as a pure function; this hook is only the I/O and the navigator.
 *
 * The caller names its INTENT because the same authenticated user is routed
 * differently by it: a new login always lands on the mode-selection screen —
 * 일반 투자 vs 시즌 투자 is the user's choice, never an inference from what
 * they happen to own — while a session restore may keep the account they had
 * already chosen.
 *
 * The read lands in `tradingAccount.list(userId)` — the same entry
 * `TradingAccountProvider` mounts on — so the provider finds it warm and the
 * app makes ONE account-list request on entry, not two.
 */
export function useEnterApp() {
  const rootNavigation = useRootNavigation();
  const queryClient = useQueryClient();

  return useCallback(
    async (userId: string, intent: AuthedEntryIntent) => {
      const route = await loadEntryRoute(queryClient, userId, intent, {
        loadAccounts: getTradingAccounts,
        readStoredAccountId: readSelectedAccountId,
      });

      if (route === 'home') {
        resetToHome(rootNavigation);
        return;
      }

      resetToModeSelection(rootNavigation);
    },
    [queryClient, rootNavigation],
  );
}
