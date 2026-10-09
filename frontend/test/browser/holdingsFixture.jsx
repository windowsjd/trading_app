import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavigationContext } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider, useAppearance } from '../../src/theme/appearance';
import { ScrollView } from '../../src/theme/native';
import { TradingAccountProvider, useTradingAccount } from '../../src/features/tradingAccount/TradingAccountContext';
import Home from '../../src/screens/home/HomeScreen';
import Wallet from '../../src/screens/wallet/WalletScreen';
import Portfolio from '../../src/screens/home/PortfolioScreen';
import AccountHoldings from '../../src/screens/asset/AccountHoldings';
import Futures from '../../src/screens/futures/FuturesScreen';
import Summary from '../../src/screens/ranking/UserSeasonSummaryScreen';
import { navigation, transport } from './holdingsMocks';
const params = new URLSearchParams(location.search);
localStorage.setItem('selectedTradingAccountId:home-user', `${params.get('mode') ?? 'general'}-account`);
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
function Screen() {
  const accounts = useTradingAccount();
  const appearance = useAppearance();
  window.holdingsFixture = { client, accounts, appearance, transport, navigation };
  const screen = params.get('screen') ?? 'home';
  if (screen === 'friend') return <Summary route={{ params: { userId: 'friend' } }} />;
  if (!accounts.selectedAccount) return null;
  if (screen === 'market-holdings') return <ScrollView contentContainerStyle={{ padding: 16 }}>
    <AccountHoldings key={accounts.selectedAccountId} accountId={accounts.selectedAccountId} account={accounts.selectedAccount} assetId="btc" isFocused />
  </ScrollView>;
  if (screen === 'futures') return <Futures route={{ params: { accountId: accounts.selectedAccountId } }} navigation={navigation} />;
  const Component = { home: Home, wallet: Wallet, portfolio: Portfolio }[screen];
  return <Component navigation={navigation} />;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}>
  <AppearanceProvider><SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight },
    insets: { top: 24, bottom: 34, left: 0, right: 0 } }}>
    <NavigationContext.Provider value={navigation}><TradingAccountProvider><Screen /></TradingAccountProvider></NavigationContext.Provider>
  </SafeAreaProvider></AppearanceProvider>
</QueryClientProvider>);
