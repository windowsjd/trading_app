import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppearanceProvider } from '../../src/theme/appearance';
import { TradingAccountProvider } from '../../src/features/tradingAccount/TradingAccountContext';
import Home from '../../src/screens/home/HomeScreen';
import Market from '../../src/screens/market/MarketScreen';
import Search from '../../src/screens/market/MarketSearchScreen';
import Ranking from '../../src/screens/ranking/RankingScreen';
import Record from '../../src/screens/record/RecordSeasonListScreen';
import Overall from '../../src/screens/my/OverallScreen';
import Guide from '../../src/screens/guide/GuideScreen';
import { navigation, transport } from './rootTabsMocks';

const screens = { home: Home, market: Market, search: Search, ranking: Ranking, record: Record, overall: Overall, guide: Guide };
const Screen = screens[new URLSearchParams(location.search).get('screen') ?? 'home'];
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
window.fixture = { client, navigation, transport };
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}>
    <AppearanceProvider>
      <TradingAccountProvider>
        <Screen navigation={navigation} route={{ params: {} }} />
      </TradingAccountProvider>
    </AppearanceProvider>
  </QueryClientProvider>,
);
