import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider } from '../../src/theme/appearance';
import Market from '../../src/screens/market/MarketScreen';
import Search from '../../src/screens/market/MarketSearchScreen';
import { state, navigation } from './watchlistMocks';

const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
window.watchlistFixture = { state };
const screen = new URLSearchParams(location.search).get('screen') ?? 'market';
const Component = screen === 'search' ? Search : Market;
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider>
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } }}>
      <Component route={{ params: {} }} navigation={navigation} />
    </SafeAreaProvider>
  </AppearanceProvider></QueryClientProvider>,
);
