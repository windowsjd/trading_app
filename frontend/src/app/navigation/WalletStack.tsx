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
import WalletFxScreen from '../../screens/wallet/WalletFxScreen';
import WalletTransactionsScreen from '../../screens/home/WalletTransactionsScreen';

const Stack = createNativeStackNavigator<WalletStackParamList>();

export default function WalletStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="WalletStack" UNSTABLE_router={questNavigationRouter} screenOptions={stackTransition(reducedMotion, Platform.OS)} screenLayout={stackScreenLayout}>
      <Stack.Screen name="Wallet" component={WalletScreen} options={{ title: '지갑', headerTitle: mainTabHeaderTitle('wallet') }} />
      <Stack.Screen name="WalletFx" component={WalletFxScreen} options={{ title: '환전' }} />
      <Stack.Screen name="WalletTransactions" component={WalletTransactionsScreen} options={{ title: '지갑 원장' }} />
    </Stack.Navigator>
  );
}
