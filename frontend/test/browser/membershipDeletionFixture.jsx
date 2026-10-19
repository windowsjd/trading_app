import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContext } from '@react-navigation/native';
import { AppearanceProvider } from '../../src/theme/appearance';
import MembershipDeletionScreen from '../../src/screens/my/MembershipDeletionScreen';
import MembershipDeletionResultScreen from '../../src/screens/auth/MembershipDeletionResultScreen';
import { rememberMembershipDeletion } from '../../src/features/me/membershipDeletionFlow';

const query = new URLSearchParams(location.search);
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
client.setQueryData(['me'], { id: 'fixture-user', role: 'user' });
const navigation = { navigate: () => {}, goBack: () => { window.wentBack = true; }, replace: () => {}, isFocused: () => true, addListener: () => () => {} };
if (query.get('key') === '1') rememberMembershipDeletion('k'.repeat(64));
const status = query.get('status') ?? 'cleanup_pending';
const params = { status, deletedAt: '2026-10-18T03:00:00.000Z', completedAt: status === 'completed' ? '2026-10-18T03:00:01.000Z' : null };
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider><SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <NavigationContext.Provider value={navigation}><div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {query.get('screen') === 'result'
        ? <MembershipDeletionResultScreen route={{ params }} navigation={navigation} />
        : <MembershipDeletionScreen navigation={navigation} route={{ params: undefined }} />}
    </div></NavigationContext.Provider>
  </SafeAreaProvider></AppearanceProvider></QueryClientProvider>
);
