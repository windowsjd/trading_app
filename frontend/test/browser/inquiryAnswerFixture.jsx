import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContext } from '@react-navigation/native';
import { AppearanceProvider } from '../../src/theme/appearance';
import InquiryScreen from '../../src/screens/my/InquiryScreen';
import InquiryAnswerScreen from '../../src/screens/my/InquiryAnswerScreen';
import OrderFailureScreen from '../../src/screens/history/OrderFailureScreen';
import { fixtureMe, scenarioName } from './inquiryAnswerMocks';
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
client.setQueryData(['me'], fixtureMe());
// A focused screen outside a navigator (the inquiry screens read again on focus).
const navigation = { navigate: (...args) => { window.lastNavigation = args; }, isFocused: () => true, addListener: () => () => {} };
const screen = scenarioName();
const params = screen === 'failure-loc'
  ? { accountId: 'acct-a', kind: 'loc', failureId: 'order-1' }
  : { accountId: 'acct-a', kind: 'futures_tp_sl', failureId: 'tpsl-1' };
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider><SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <NavigationContext.Provider value={navigation}><div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {screen === 'inquiry' ? <InquiryScreen navigation={navigation} />
        : screen === 'answer' ? <InquiryAnswerScreen route={{ params: { inquiryId: new URLSearchParams(location.search).get('id') } }} />
          : <OrderFailureScreen navigation={navigation} route={{ params }} />}
    </div></NavigationContext.Provider>
  </SafeAreaProvider></AppearanceProvider></QueryClientProvider>
);
