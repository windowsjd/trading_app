import React from 'react';
import { mainTabHeaderTitle } from '../../components/navigation/MainTabHeaderTitle';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';
import { stackScreenLayout } from './stackScreenLayout';
import { questNavigationRouter } from '../../features/quest/questNavigationGuard';
import type { WalletStackParamList } from './types';
import WalletScreen from '../../screens/wallet/WalletScreen';
import GuestWalletScreen from '../../screens/wallet/GuestWalletScreen';
import WalletTransactionsScreen from '../../screens/home/WalletTransactionsScreen';

const Stack = createNativeStackNavigator<WalletStackParamList>();

/** Guest browsing's 지갑 tab: the same header, no wallet reads. */
export function GuestWalletStack() {
  return <WalletStack guest />;
}

export default function WalletStack({ guest = false }: { guest?: boolean } = {}) {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="WalletStack" UNSTABLE_router={questNavigationRouter} screenOptions={stackTransition(reducedMotion, Platform.OS)} screenLayout={stackScreenLayout}>
      <Stack.Screen name="Wallet" component={guest ? GuestWalletScreen : WalletScreen} options={{ title: '지갑', headerTitle: mainTabHeaderTitle('wallet') }} />
      {guest ? null : <Stack.Screen name="WalletTransactions" component={WalletTransactionsScreen} options={{ title: '지갑 원장' }} />}
    </Stack.Navigator>
  );
}
