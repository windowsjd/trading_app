import React from 'react';
import { mainTabHeaderTitle } from '../../components/navigation/MainTabHeaderTitle';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';
import { stackScreenLayout } from './stackScreenLayout';

import type { HomeStackParamList } from './types';
import HomeScreen from '../../screens/home/HomeScreen';
import GuestHomeScreen from '../../screens/home/GuestHomeScreen';
import PortfolioScreen from '../../screens/home/PortfolioScreen';

const Stack = createNativeStackNavigator<HomeStackParamList>();

/** Guest browsing's Home tab: the same header, no account screens. */
export function GuestHomeStack() {
  return <HomeStack guest />;
}

export default function HomeStack({ guest = false }: { guest?: boolean } = {}) {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="HomeStack" screenOptions={stackTransition(reducedMotion, Platform.OS)} screenLayout={stackScreenLayout}>
      <Stack.Screen
        name="Home"
        component={guest ? GuestHomeScreen : HomeScreen}
        options={{ title: '홈', headerTitle: mainTabHeaderTitle('home') }}
      />
      {guest ? null : (
        <Stack.Screen
          name="Portfolio"
          component={PortfolioScreen}
          options={{ title: '포트폴리오' }}
        />
      )}
    </Stack.Navigator>
  );
}
