import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider, useAppearance } from '../../src/theme/appearance';
import FuturesScreen from '../../src/screens/futures/FuturesScreen';
import { ScreenSheetHost } from '../../src/components/common/ScreenSheetHost';
import { state } from './futuresMocks';
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
window.refreshFuturesFixture = () => client.invalidateQueries();
function ThemeReady() { const appearance = useAppearance(); window.futuresAppearance = appearance; return null; }
function App() {
  const [, refresh] = React.useState(0);
  window.switchFuturesAccount = id => { state.accountId = id; refresh(n => n + 1); };
  // `?viewport=1`: a device-sized root, so the screen scrolls inside and bottom
  // sheets anchor to the visible bottom edge (as in the app).
  const viewport = new URLSearchParams(location.search).get('viewport') === '1';
  return <QueryClientProvider client={client}><AppearanceProvider><ThemeReady /><SafeAreaProvider style={viewport ? { height: '100vh', overflow: 'hidden' } : undefined}
    initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 0, bottom: 0, left: 0, right: 0 } }}>
    {/* Same sheet layer MainTabs provides to tab screens (leverage, 주문방식, help sheets). */}
    <ScreenSheetHost>
      <FuturesScreen route={{ params: { accountId: new URLSearchParams(location.search).get('account') ?? 'A' } }} navigation={{ navigate() {} }} />
    </ScreenSheetHost>
  </SafeAreaProvider></AppearanceProvider></QueryClientProvider>;
}
createRoot(document.getElementById('root')).render(<App />);
