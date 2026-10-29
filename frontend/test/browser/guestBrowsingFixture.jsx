import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaInsetsContext, SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from '../../src/app/navigation/RootNavigator';
import { rootNavigationRef as navigationRef } from '../../src/app/navigation/navigationRef';
import { AppearanceProvider } from '../../src/theme/appearance';
import { TradingAccountProvider } from '../../src/features/tradingAccount/TradingAccountContext';
import { isGuestBrowsing } from '../../src/features/auth/guestBrowsing';

// The production app tree from the Login screen on: providers, root stack,
// guest tabs, headers and sheets. Only transport and the splash are fixtures.
const params = new URLSearchParams(location.search);
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
window.fixture = { navigationRef, client, isGuestBrowsing };
const top = Number(params.get('topInset') ?? 0), bottom = Number(params.get('bottomInset') ?? 0);
createRoot(document.getElementById('root')).render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top, right: 0, bottom, left: 0 } }}>
    <SafeAreaInsetsContext.Provider value={{ top, right: 0, bottom, left: 0 }}>
      <QueryClientProvider client={client}>
        <AppearanceProvider>
          <TradingAccountProvider><RootNavigator /></TradingAccountProvider>
        </AppearanceProvider>
      </QueryClientProvider>
    </SafeAreaInsetsContext.Provider>
  </SafeAreaProvider>,
);
