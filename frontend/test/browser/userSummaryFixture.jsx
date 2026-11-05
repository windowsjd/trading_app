import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavigationContext } from '@react-navigation/native';
import { AppearanceProvider } from '../../src/theme/appearance';
import UserSeasonSummaryScreen from '../../src/screens/ranking/UserSeasonSummaryScreen';
import { transport } from './userSummaryMocks';
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
// The signed-in member (never the card's user); `?self=1` opens the member's own summary.
client.setQueryData(['me'], { id: 'viewer', nickname: '나의닉네임', profileImageUrl: null, role: 'user', status: 'active' });
window.fixture = { client, transport };
const navigation = { navigate: () => {}, isFocused: () => true, addListener: () => () => {} };
const userId = new URLSearchParams(location.search).get('self') === '1' ? 'viewer' : 'target';
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider><NavigationContext.Provider value={navigation}>
    <UserSeasonSummaryScreen route={{ params: { userId } }} />
  </NavigationContext.Provider></AppearanceProvider></QueryClientProvider>
);
