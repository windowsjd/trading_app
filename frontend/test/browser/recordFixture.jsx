import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider, useAppearance } from '../../src/theme/appearance';
import { TradingAccountProvider } from '../../src/features/tradingAccount/TradingAccountContext';
import Detail from '../../src/screens/record/RecordSeasonDetailScreen';
import Profit from '../../src/screens/record/RecordProfitAnalysisScreen';
import History from '../../src/screens/history/TradeHistoryScreen';
import { transport } from './recordMocks';
const params = new URLSearchParams(location.search);
const Stack = createNativeStackNavigator();
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
function App() {
  const appearance = useAppearance();
  window.fixture = { client, transport, appearance };
  return <NavigationContainer><Stack.Navigator initialRouteName={params.get('record') ?? 'detail'} screenOptions={{ headerShown: false }}>
    <Stack.Screen name="detail" component={Detail} initialParams={{ seasonId: 'record-0' }} />
    <Stack.Screen name="profit" component={Profit} initialParams={{ seasonId: 'record-0' }} />
    <Stack.Screen name="history" component={History} initialParams={{ seasonId: 'record-0' }} />
  </Stack.Navigator></NavigationContainer>;
}
createRoot(document.getElementById('root')).render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 0, bottom: 0, left: 0, right: 0 } }}>
  <QueryClientProvider client={client}><AppearanceProvider><TradingAccountProvider><App /></TradingAccountProvider></AppearanceProvider></QueryClientProvider>
</SafeAreaProvider>);
