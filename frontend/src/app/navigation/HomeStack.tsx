import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import type { HomeStackParamList } from './types';
import HomeScreen from '../../screens/home/HomeScreen';
import PortfolioScreen from '../../screens/home/PortfolioScreen';
import WalletTransactionsScreen from '../../screens/home/WalletTransactionsScreen';
import WalletFxScreen from '../../screens/wallet/WalletFxScreen';

const Stack = createNativeStackNavigator<HomeStackParamList>();

export default function HomeStack() {
  return (
    <Stack.Navigator id="HomeStack">
      <Stack.Screen
        name="Home"
        component={HomeScreen}
        options={{ title: '홈' }}
      />
      <Stack.Screen
        name="Portfolio"
        component={PortfolioScreen}
        options={{ title: '포트폴리오' }}
      />
      <Stack.Screen
        name="WalletFx"
        component={WalletFxScreen}
        options={{ title: '지갑 / 환전' }}
      />
      <Stack.Screen
        name="WalletTransactions"
        component={WalletTransactionsScreen}
        options={{ title: '지갑 원장' }}
      />
    </Stack.Navigator>
  );
}
