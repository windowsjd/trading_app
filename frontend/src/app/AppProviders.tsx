import React, { PropsWithChildren, useEffect, useState } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';

import { TradingAccountProvider } from '../features/tradingAccount/TradingAccountContext';
import { endSession } from '../features/auth/session';
import { setSessionExpiredHandler } from '../services/api/sessionExpiry';
import { resetToLoginFromRef } from './navigation/navigationRef';

/**
 * Turns "the refresh token is dead" into a real logout (작업 10 §A-8).
 *
 * Without this, an expired session cleared the tokens and left every mounted
 * screen rendering the cache it already had — a full portfolio and live-looking
 * balances for a session the server had stopped honouring. Now the cache goes
 * with the token, and the user lands on login rather than on a screen whose
 * numbers they can no longer act on.
 *
 * The userId is deliberately not passed to `endSession` here: the `me` entry is
 * about to be cleared anyway, and the per-user stored SELECTION is a harmless
 * pointer that should survive so the same user returns to the same account
 * after logging back in. An explicit logout does clear it.
 */
function SessionExpiryBridge({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();

  useEffect(() => {
    setSessionExpiredHandler(() => {
      void endSession(queryClient);
      resetToLoginFromRef();
    });

    return () => setSessionExpiredHandler(null);
  }, [queryClient]);

  return <>{children}</>;
}

export default function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            staleTime: 5 * 1000,
            refetchOnReconnect: true,
            refetchOnWindowFocus: false,
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SessionExpiryBridge>
        {/* The selected trading account is app-wide state: it decides which
            account EVERY financial screen is about (작업 9 §B-1). */}
        <TradingAccountProvider>{children}</TradingAccountProvider>
      </SessionExpiryBridge>
    </QueryClientProvider>
  );
}
