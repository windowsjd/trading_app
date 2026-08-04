import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useRootNavigation } from '../../app/navigation/navigationHooks';
import {
  resetToAccountSetup,
  resetToHome,
} from '../../app/navigation/seasonRouting';
import { getTradingAccounts } from '../tradingAccount/api';
import { loadEntryRoute } from './entry';

/**
 * The ONE way into the app after authentication (작업 11 §3).
 *
 * Splash, login, and signup all had their own copy of "ask for the current
 * season, then route on it". They now share this: read the user's accounts, and
 * go where those accounts say. The decision itself lives in `entry.ts` as a
 * pure function; this hook is only the I/O and the navigator.
 *
 * The read lands in `tradingAccount.list(userId)` — the same entry
 * `TradingAccountProvider` mounts on — so the provider finds it warm and the
 * app makes ONE account-list request on entry, not two.
 */
export function useEnterApp() {
  const rootNavigation = useRootNavigation();
  const queryClient = useQueryClient();

  return useCallback(
    async (userId: string) => {
      const route = await loadEntryRoute(
        queryClient,
        userId,
        getTradingAccounts,
      );

      if (route === 'home') {
        resetToHome(rootNavigation);
        return;
      }

      // No accounts at all. Not an error and not an empty portfolio: the user
      // has nothing to open yet and is offered the two real ways to start.
      resetToAccountSetup(rootNavigation);
    },
    [queryClient, rootNavigation],
  );
}
