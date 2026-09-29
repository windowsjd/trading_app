import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OverallScreen from '../../src/screens/my/OverallScreen';
import NoticesScreen from '../../src/screens/my/NoticesScreen';
import FriendsScreen from '../../src/screens/friends/FriendsScreen';
import SettingsScreen from '../../src/screens/my/SettingsScreen';
import SummaryScreen from '../../src/screens/ranking/UserSeasonSummaryScreen';
const screens = {
  overall: OverallScreen,
  notices: NoticesScreen,
  friends: FriendsScreen,
  settings: SettingsScreen,
  summary: SummaryScreen,
};
const Screen =
  screens[new URLSearchParams(location.search).get('screen') ?? 'overall'];
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const navigation = {
  navigate: (route) => {
    window.lastNavigation = route;
  },
};
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}>
    <Screen navigation={navigation} route={{ params: { userId: 'friend' } }} />
  </QueryClientProvider>,
);
