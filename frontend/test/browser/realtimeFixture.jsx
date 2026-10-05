import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider } from '../../src/theme/appearance';
import Market from '../../src/screens/market/MarketScreen';
import Chart from '../../src/screens/asset/AssetChartScreen';
import Order from '../../src/screens/order/OrderScreen';
import Fx from '../../src/screens/wallet/WalletFxScreen';
import { state, navigation } from './realtimeMocks';

const sockets = [];
class Socket {
  constructor() { this.frames = []; this.onopen = this.onclose = this.onerror = this.onmessage = null; sockets.push(this); }
  send(frame) { this.frames.push(JSON.parse(frame)); }
  close() {}
}
window.WebSocket = Socket;
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 }, mutations: { retry: false } } });
window.runtimeHarness = {
  sockets, state,
  open: () => sockets[0].onopen?.({}),
  receive: payload => sockets[0].onmessage?.({ data: JSON.stringify(payload) }),
  drop: code => sockets[0].onclose?.({ code }),
};
const screen = new URLSearchParams(location.search).get('screen') ?? 'chart';
const Component = { market: Market, chart: Chart, order: Order, fx: Fx }[screen];
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider>
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } }}>
      <Component route={{ params: { assetId: state.assetId, accountId: state.accountId, side: 'buy' } }} navigation={navigation} />
    </SafeAreaProvider>
  </AppearanceProvider></QueryClientProvider>,
);
