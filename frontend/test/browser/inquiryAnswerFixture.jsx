import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider } from '../../src/theme/appearance';
import InquiryScreen from '../../src/screens/my/InquiryScreen';
import OrderFailureScreen from '../../src/screens/history/OrderFailureScreen';
import { scenarioName } from './inquiryAnswerMocks';
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
client.setQueryData(['me'], { id: 'fixture-user' });
const navigation = { navigate: (...args) => { window.lastNavigation = args; } };
const screen = scenarioName();
const params = screen === 'failure-loc'
  ? { accountId: 'acct-a', kind: 'loc', failureId: 'order-1' }
  : { accountId: 'acct-a', kind: 'futures_tp_sl', failureId: 'tpsl-1' };
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider><SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {screen === 'inquiry' ? <InquiryScreen /> : <OrderFailureScreen navigation={navigation} route={{ params }} />}
    </div>
  </SafeAreaProvider></AppearanceProvider></QueryClientProvider>
);
