import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider } from '../../src/theme/appearance';
import { TradingAccountProvider } from '../../src/features/tradingAccount/TradingAccountContext';
import MainTabs from '../../src/app/navigation/MainTabs';
import { navigation, transport } from './rootTabsMocks';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
const Stack = createNativeStackNavigator();
const navigationRef = createNavigationContainerRef();
window.fixture = { client, navigation, transport, navigationRef };
createRoot(document.getElementById('root')).render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 0, right: 0, bottom: 0, left: 0 } }}>
    <QueryClientProvider client={client}>
      <AppearanceProvider>
        <TradingAccountProvider>
          <NavigationContainer ref={navigationRef}><Stack.Navigator screenOptions={{ headerShown: false }}><Stack.Screen name="MainTabs" component={MainTabs} /></Stack.Navigator></NavigationContainer>
        </TradingAccountProvider>
      </AppearanceProvider>
    </QueryClientProvider>
  </SafeAreaProvider>,
);
