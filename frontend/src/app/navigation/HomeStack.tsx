import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';

import type { HomeStackParamList } from './types';
import HomeScreen from '../../screens/home/HomeScreen';
import PortfolioScreen from '../../screens/home/PortfolioScreen';

const Stack = createNativeStackNavigator<HomeStackParamList>();

export default function HomeStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="HomeStack" screenOptions={stackTransition(reducedMotion, Platform.OS)}>
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
    </Stack.Navigator>
  );
}
