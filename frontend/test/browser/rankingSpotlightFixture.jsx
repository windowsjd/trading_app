import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavigationContext } from '@react-navigation/native';
import { AppearanceProvider, useAppearance } from '../../src/theme/appearance';
import RankingScreen from '../../src/screens/ranking/RankingScreen';
import { transport } from './rankingTierMocks';

// The ranking tab with its focus in the check's hands: `?focused=0` mounts it
// unfocused, `fixture.focus(true|false)` sends focus/blur as a tab navigator
// does, and `fixture.appearance(mode)` switches Light/Dark live.
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
let focused = new URLSearchParams(location.search).get('focused') !== '0';
const listeners = new Set();
const navigation = {
  navigate: (...args) => { window.lastNavigation = args; },
  isFocused: () => focused,
  addListener: (type, listener) => { const entry = { type, listener }; listeners.add(entry); return () => listeners.delete(entry); },
};
window.fixture = {
  client, transport,
  focus(next = true) {
    focused = next;
    listeners.forEach(({ type, listener }) => { if (type === (next ? 'focus' : 'blur')) listener(); });
  },
};
function AppearanceHandle() {
  const { setPreference } = useAppearance();
  window.fixture.appearance = setPreference;
  return null;
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider><NavigationContext.Provider value={navigation}>
    <AppearanceHandle />
    <RankingScreen navigation={navigation} />
  </NavigationContext.Provider></AppearanceProvider></QueryClientProvider>
);
