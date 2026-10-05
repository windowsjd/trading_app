import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaInsetsContext, SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from '../../src/app/navigation/RootNavigator';
import { rootNavigationRef as navigationRef } from '../../src/app/navigation/navigationRef';
import { AppearanceProvider, useAppearance } from '../../src/theme/appearance';
import { TradingAccountProvider } from '../../src/features/tradingAccount/TradingAccountContext';
import TabBarIcon from '../../src/components/navigation/TabBarIcon';
import { View, Text } from '../../src/theme/native';

const params = new URLSearchParams(location.search);
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
window.fixture = { navigationRef, client };
function Icons() {
  const { colors } = useAppearance();
  return <View style={{ flex: 1, padding: 24, gap: 24, backgroundColor: colors.navigation }}>
    {[24, 20, 18].map(size => <View key={size} style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
      <Text>{size}px</Text>
      <TabBarIcon name="home" size={size} color={colors.navigationHomeInactive} />
      <TabBarIcon name="home" size={size} color="#326FE5" focused />
    </View>)}
  </View>;
}
const top = Number(params.get('topInset') ?? 0), bottom = Number(params.get('bottomInset') ?? 0);
createRoot(document.getElementById('root')).render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top, right: 0, bottom, left: 0 } }}>
    {/* Browser env(safe-area-inset-*) is zero on this host. Supply controlled
        inset inputs after the web provider measures, without replacing hooks. */}
    <SafeAreaInsetsContext.Provider value={{ top, right: 0, bottom, left: 0 }}>
    <QueryClientProvider client={client}>
      <AppearanceProvider>
        {params.has('icons') ? <Icons /> : <TradingAccountProvider><RootNavigator /></TradingAccountProvider>}
      </AppearanceProvider>
    </QueryClientProvider>
    </SafeAreaInsetsContext.Provider>
  </SafeAreaProvider>,
);
