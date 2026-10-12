import React from 'react';
import { mainTabHeaderTitle } from '../../components/navigation/MainTabHeaderTitle';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';
import { stackScreenLayout } from './stackScreenLayout';

import type { HomeStackParamList } from './types';
import HomeScreen from '../../screens/home/HomeScreen';
import PortfolioScreen from '../../screens/home/PortfolioScreen';

const Stack = createNativeStackNavigator<HomeStackParamList>();

export default function HomeStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="HomeStack" screenOptions={stackTransition(reducedMotion, Platform.OS)} screenLayout={stackScreenLayout}>
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
    </Stack.Navigator>
  );
}
