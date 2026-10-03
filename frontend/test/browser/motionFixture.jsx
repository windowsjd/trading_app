import React, { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { rootNavigationRef as navigationRef } from '../../src/app/navigation/navigationRef';
import RootNavigator from '../../src/app/navigation/RootNavigator';
import { AppearanceProvider } from '../../src/theme/appearance';
import { TradingAccountProvider } from '../../src/features/tradingAccount/TradingAccountContext';
import ActionPressable from '../../src/components/common/ActionPressable';
import { ScrollView, Text } from '../../src/theme/native';
import { semantic } from '../../src/theme/tokens';
import { financial } from '../../src/theme/financialColors';
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
          {probe ? <ScrollView contentContainerStyle={{ padding: 24, gap: 16, backgroundColor: semantic.screen }}>
            {[
              ['motion-probe', semantic.selected, semantic.onAccent, '선택 버튼'],
              ['motion-surface', semantic.surface, semantic.text, '밝은/어두운 표면'],
              ['motion-buy', financial.buyAction, semantic.onAccent, '구매하기'],
              ['motion-sell', financial.sellAction, semantic.onAccent, '판매하기'],
            ].map(([testID, backgroundColor, color, label]) => <ActionPressable key={testID} testID={testID} onPress={() => {}} style={{ backgroundColor, borderRadius: 12, padding: 20 }}>
              <Text style={{ color }}>{label}</Text>
            </ActionPressable>)}
          </ScrollView> : <TradingAccountProvider><RootNavigator /></TradingAccountProvider>}
        </AppearanceProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  </Profiler>,
);
