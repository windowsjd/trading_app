import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppearanceProvider } from '../../src/theme/appearance';
import RankingScreen from '../../src/screens/ranking/RankingScreen';
import { transport } from './rankingTierMocks';
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
window.fixture = { client, transport };
const navigation = { navigate: (...args) => { window.lastNavigation = args; } };
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider><RankingScreen navigation={navigation} /></AppearanceProvider></QueryClientProvider>
);
