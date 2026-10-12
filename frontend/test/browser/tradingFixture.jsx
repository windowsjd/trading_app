// Browser-only fixture: production RN Web screens/components and API wrappers;
// account/auth/transport inputs are isolated from production and never sent out.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider, useAppearance } from '../../src/theme/appearance';
import Detail from '../../src/screens/asset/AssetDetailScreen';
import Order from '../../src/screens/order/OrderScreen';
import Chart from '../../src/screens/asset/AssetChartScreen';
import Market from '../../src/screens/market/MarketScreen';
import Search from '../../src/screens/market/MarketSearchScreen';
import Home from '../../src/screens/home/HomeScreen';
import Settings from '../../src/screens/my/SettingsScreen';
import Futures from '../../src/screens/futures/FuturesScreen';
import { state, navigation } from './tradingMocks';
import { ScreenSheetHost } from '../../src/components/common/ScreenSheetHost';
import OrderFillBanner from '../../src/features/order/OrderFillBanner';
// `?fillBanner=1` overlays one real-fill banner (layout/visual checks only).
const fillBanner = new URLSearchParams(location.search).get('fillBanner') === '1' ? {
  id: 'account-fixture:fixture-order', accountId: 'account-fixture', orderId: 'fixture-order',
  title: new URLSearchParams(location.search).get('longName') === '1'
    ? '아주 긴 이름을 가진 국내 상장 주식회사 우선주 Example Holdings LOC 매수 체결 완료' : '삼성전자 매수 체결 완료',
  detail: '일반모드 · 조건주문 · 체결 수량 1,234,567.123456', overflow: 2,
} : null;
const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 60000 },
    mutations: { retry: false },
  },
});
function PreferenceProbe() {
  const appearance = useAppearance();
  window.tradingAppearance = appearance;
  return null;
}
function App() {
  const [screen, setScreen] = React.useState(
    new URLSearchParams(location.search).get('screen') ?? 'detail',
  );
  const [, refresh] = React.useReducer((n) => n + 1, 0);
  state.navigate = (next, params = {}) => {
    if (params.assetId) state.assetId = params.assetId;
    if (params.side) state.side = params.side;
    if (params.instrumentId) state.instrumentId = params.instrumentId;
    setScreen(
      next === 'Futures' ? 'futures' : next === 'Order'
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
  // Native-stack setParams merges into the current route (same screen).
  state.setParams = (params) => {
    state.paramCalls = [...(state.paramCalls ?? []), params];
    if (params.assetId) state.assetId = params.assetId;
    if (params.side) state.side = params.side;
    if (params.accountId) state.accountId = params.accountId;
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
    settings: Settings,
    futures: Futures,
  }[screen];
  return (
    <QueryClientProvider client={client}>
      <AppearanceProvider>
        <PreferenceProbe />
        <SafeAreaProvider
          // `?viewport=1`: a device-sized root, so screens scroll inside and
          // bottom sheets anchor to the visible bottom edge.
          style={new URLSearchParams(location.search).get('viewport') === '1' ? { height: '100vh', overflow: 'hidden' } : undefined}
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 800 },
            insets: { top: 0, bottom: 0, left: 0, right: 0 },
          }}
        >
          {/* Same sheet layer MainTabs provides to tab screens. */}
          <ScreenSheetHost>
            <Component
              key={state.assetId + ':' + screen}
              route={{ params: { assetId: state.assetId, accountId: state.accountId, instrumentId: state.instrumentId, side: state.side ?? 'buy', returnToAsset: true } }}
              navigation={navigation}
            />
          </ScreenSheetHost>
          <OrderFillBanner notice={fillBanner} onDone={() => {}} onOpenHistory={(notice) => { state.history = notice.accountId; }} />
        </SafeAreaProvider>
      </AppearanceProvider>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')).render(<App />);
