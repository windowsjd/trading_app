import React from 'react';
import { mainTabHeaderTitle } from '../../components/navigation/MainTabHeaderTitle';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';

import type { HomeStackParamList } from './types';
import HomeScreen from '../../screens/home/HomeScreen';
import FuturesScreen from '../../screens/futures/FuturesScreen';
import PortfolioScreen from '../../screens/home/PortfolioScreen';

const Stack = createNativeStackNavigator<HomeStackParamList>();

export default function HomeStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="HomeStack" screenOptions={stackTransition(reducedMotion, Platform.OS)}>
      <Stack.Screen
        name="Home"
        component={HomeScreen}
        options={{ title: '홈', headerTitle: mainTabHeaderTitle('home') }}
      />
      <Stack.Screen
        name="Portfolio"
        component={PortfolioScreen}
        options={{ title: '포트폴리오' }}
      />
      <Stack.Screen name="Futures" component={FuturesScreen} options={{ title: '암호화폐 선물' }} />
    </Stack.Navigator>
  );
}
