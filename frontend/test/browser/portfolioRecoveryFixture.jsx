import React from 'react';
import { createRoot } from 'react-dom/client';
import { useQueryClient } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppProviders from '../../src/app/AppProviders';
import RootNavigator from '../../src/app/navigation/RootNavigator';
import { rootNavigationRef as navigationRef } from '../../src/app/navigation/navigationRef';
import { useTradingAccount } from '../../src/features/tradingAccount/TradingAccountContext';
import { recovery } from './portfolioRecoveryMocks';
import { QUERY_KEYS } from '../../src/constants/queryKeys';
function Probe() {
  const client = useQueryClient(), accounts = useTradingAccount();
  window.fixture = { client, accounts, navigationRef, recovery, portfolioKey: QUERY_KEYS.tradingAccount.portfolio('season-account') };
  return <RootNavigator />;
}
createRoot(document.getElementById('root')).render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 0, right: 0, bottom: 0, left: 0 } }}>
  <AppProviders><Probe /></AppProviders>
</SafeAreaProvider>);
