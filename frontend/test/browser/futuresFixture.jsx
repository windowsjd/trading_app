import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider, useAppearance } from '../../src/theme/appearance';
import FuturesScreen from '../../src/screens/futures/FuturesScreen';
import { state } from './futuresMocks';
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function ThemeReady() { const appearance = useAppearance(); window.futuresAppearance = appearance; return null; }
function App() {
  const [, refresh] = React.useState(0);
  window.switchFuturesAccount = id => { state.accountId = id; refresh(n => n + 1); };
  return <QueryClientProvider client={client}><AppearanceProvider><ThemeReady /><SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 0, bottom: 0, left: 0, right: 0 } }}>
    <FuturesScreen route={{ params: { accountId: new URLSearchParams(location.search).get('account') ?? 'A' } }} navigation={{ navigate() {} }} />
  </SafeAreaProvider></AppearanceProvider></QueryClientProvider>;
}
createRoot(document.getElementById('root')).render(<App />);
