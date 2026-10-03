import React, { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { rootNavigationRef as navigationRef } from '../../src/app/navigation/navigationRef';
import RootNavigator from '../../src/app/navigation/RootNavigator';
import { AppearanceProvider } from '../../src/theme/appearance';
import { TradingAccountProvider } from '../../src/features/tradingAccount/TradingAccountContext';
import ActionPressable from '../../src/components/common/ActionPressable';
import { Text } from 'react-native';
import { timing } from './motionMocks';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
window.fixture = { client, timing, navigationRef };
navigationRef.addListener('state', () => window.motion.events.push({ stage: 'route-state', time: performance.now(), route: navigationRef.getCurrentRoute()?.name }));
const onRender = (_id, phase, duration) => window.motion.commits.push({ phase, duration, time: performance.now() });
const probe = new URLSearchParams(location.search).has('probe');
createRoot(document.getElementById('root')).render(
  <Profiler id="motion" onRender={onRender}>
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 0, right: 0, bottom: 0, left: 0 } }}>
      <QueryClientProvider client={client}>
        <AppearanceProvider>
          {probe ? <ActionPressable testID="motion-probe" onPress={() => {}} style={{ backgroundColor: '#111', borderRadius: 12, padding: 20, margin: 40 }}>
            <Text style={{ color: '#fff' }}>터치 피드백</Text>
          </ActionPressable> : <TradingAccountProvider><RootNavigator /></TradingAccountProvider>}
        </AppearanceProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  </Profiler>,
);
