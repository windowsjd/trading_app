import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavigationContext } from '@react-navigation/native';
import { AppearanceProvider } from '../../src/theme/appearance';
import RankingScreen from '../../src/screens/ranking/RankingScreen';
import { transport } from './rankingTierMocks';
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
window.fixture = { client, transport };
// A focused screen outside a navigator (RankingScreen pauses its 순위 안내 slot on blur).
const navigation = { navigate: (...args) => { window.lastNavigation = args; }, isFocused: () => true, addListener: () => () => {} };
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider><NavigationContext.Provider value={navigation}>
    <RankingScreen navigation={navigation} />
  </NavigationContext.Provider></AppearanceProvider></QueryClientProvider>
);
