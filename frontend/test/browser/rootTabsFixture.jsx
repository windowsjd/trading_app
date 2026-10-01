import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppearanceProvider, useAppearance } from '../../src/theme/appearance';
import { TradingAccountProvider } from '../../src/features/tradingAccount/TradingAccountContext';
import Wallet from '../../src/screens/wallet/WalletScreen';
import Home from '../../src/screens/home/HomeScreen';
import Market from '../../src/screens/market/MarketScreen';
import Search from '../../src/screens/market/MarketSearchScreen';
import Ranking from '../../src/screens/ranking/RankingScreen';
import Record from '../../src/screens/record/RecordSeasonListScreen';
import Overall from '../../src/screens/my/OverallScreen';
import Guide from '../../src/screens/guide/GuideScreen';
import My from '../../src/screens/my/MyScreen';
import Settings from '../../src/screens/my/SettingsScreen';
import { navigation, transport } from './rootTabsMocks';

const screens = { wallet: Wallet, home: Home, market: Market, search: Search, ranking: Ranking, record: Record, overall: Overall, guide: Guide, my: My, settings: Settings };
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
function App() {
  const [screen, setScreen] = React.useState(new URLSearchParams(location.search).get('screen') ?? 'home');
  const appearance = useAppearance();
  const Screen = screens[screen];
  window.fixture = { client, navigation, transport, setScreen, appearance };
  return <Screen navigation={navigation} route={{ params: {} }} />;
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}>
    <AppearanceProvider>
      <TradingAccountProvider>
        <App />
      </TradingAccountProvider>
    </AppearanceProvider>
  </QueryClientProvider>,
);
