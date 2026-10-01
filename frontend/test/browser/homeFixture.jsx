import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppearanceProvider, useAppearance } from '../../src/theme/appearance';
import { TradingAccountProvider, useTradingAccount } from '../../src/features/tradingAccount/TradingAccountContext';
import Home from '../../src/screens/home/HomeScreen';
import { navigation, transport } from './homeMocks';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
function Screen() {
  const accounts = useTradingAccount();
  const appearance = useAppearance();
  window.fixture = { client, accounts, appearance, transport, navigation };
  return <Home navigation={navigation} />;
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}>
    <AppearanceProvider>
      <TradingAccountProvider><Screen /></TradingAccountProvider>
    </AppearanceProvider>
  </QueryClientProvider>,
);
