import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavigationContext } from '@react-navigation/native';
import { AppearanceProvider, useAppearance } from '../../src/theme/appearance';
import { TradingAccountProvider, useTradingAccount } from '../../src/features/tradingAccount/TradingAccountContext';
import Home from '../../src/screens/home/HomeScreen';
import Portfolio from '../../src/screens/home/PortfolioScreen';
import { navigation, transport } from './homeMocks';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
function Screen() {
  const accounts = useTradingAccount();
  const appearance = useAppearance();
  window.fixture = { client, accounts, appearance, transport, navigation };
  return new URLSearchParams(location.search).get('screen') === 'portfolio'
    ? <Portfolio navigation={navigation} /> : <Home navigation={navigation} />;
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}>
    <AppearanceProvider>
      <NavigationContext.Provider value={navigation}><TradingAccountProvider><Screen /></TradingAccountProvider></NavigationContext.Provider>
    </AppearanceProvider>
  </QueryClientProvider>,
);
