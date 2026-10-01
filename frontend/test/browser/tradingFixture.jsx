// Browser-only fixture: production RN Web screens/components and API wrappers;
// account/auth/transport inputs are isolated from production and never sent out.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider } from '../../src/theme/appearance';
import Detail from '../../src/screens/asset/AssetDetailScreen';
import Order from '../../src/screens/order/OrderScreen';
import Chart from '../../src/screens/asset/AssetChartScreen';
import Market from '../../src/screens/market/MarketScreen';
import Search from '../../src/screens/market/MarketSearchScreen';
import Home from '../../src/screens/home/HomeScreen';
import { state, navigation } from './tradingMocks';
const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 60000 },
    mutations: { retry: false },
  },
});
function App() {
  const [screen, setScreen] = React.useState(
    new URLSearchParams(location.search).get('screen') ?? 'detail',
  );
  const [, refresh] = React.useReducer((n) => n + 1, 0);
  state.navigate = (next, params = {}) => {
    if (params.assetId) state.assetId = params.assetId;
    if (params.side) state.side = params.side;
    setScreen(
      next === 'Order'
        ? 'order'
        : next === 'AssetChart'
          ? 'chart'
        : next === 'MarketSearch'
          ? 'search'
          : next === 'Market'
            ? 'market'
            : 'detail',
    );
    refresh();
  };
  window.fixture = {
    state,
    client,
    setScreen,
    refresh: () => {
      client.clear();
      refresh();
    },
  };
  const Component = {
    detail: Detail,
    order: Order,
    chart: Chart,
    market: Market,
    search: Search,
    home: Home,
  }[screen];
  return (
    <QueryClientProvider client={client}>
      <AppearanceProvider>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 800 },
            insets: { top: 0, bottom: 0, left: 0, right: 0 },
          }}
        >
          <Component
            key={state.assetId + ':' + screen}
            route={{ params: { assetId: state.assetId, accountId: state.accountId, side: state.side ?? 'buy', returnToAsset: true } }}
            navigation={navigation}
          />
        </SafeAreaProvider>
      </AppearanceProvider>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')).render(<App />);
