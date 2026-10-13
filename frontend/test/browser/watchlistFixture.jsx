import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider, useAppearance } from '../../src/theme/appearance';
import MarketScreen from '../../src/screens/market/MarketScreen';
import MarketSearchScreen from '../../src/screens/market/MarketSearchScreen';
import WatchlistScreen from '../../src/screens/market/WatchlistScreen';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
client.setQueryData(['me'], { id: 'viewer', status: 'active', role: 'user' });
function ThemeReady() {
  window.watchlistAppearance = useAppearance();
  return null;
}
function Fixture() {
  const initial = new URLSearchParams(location.search).get('screen') ?? 'Market';
  const [screen, setScreen] = useState(initial);
  const navigation = {
    setParams() {},
    navigate(name, params) {
      window.lastNavigation = [name, params];
      if (name !== 'AssetDetail') setScreen(name);
    },
  };
  const Screen = {
    Market: MarketScreen,
    MarketSearch: MarketSearchScreen,
    Watchlist: WatchlistScreen,
  }[screen];
  return <Screen navigation={navigation} route={{ params: { assetType: 'domestic_stock' } }} />;
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}>
    <AppearanceProvider>
      <ThemeReady />
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: innerWidth, height: innerHeight },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        }}
      >
        <Fixture />
      </SafeAreaProvider>
    </AppearanceProvider>
  </QueryClientProvider>,
);
