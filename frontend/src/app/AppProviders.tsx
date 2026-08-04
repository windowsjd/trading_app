import React, { PropsWithChildren, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TradingAccountProvider } from '../features/tradingAccount/TradingAccountContext';

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
      {/* The selected trading account is app-wide state: it decides which
          account EVERY financial screen is about (작업 9 §B-1). */}
      <TradingAccountProvider>{children}</TradingAccountProvider>
    </QueryClientProvider>
  );
}