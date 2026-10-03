import React from 'react';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { useAppearance } from '../../theme/appearance';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { chartTransition, rootTransition, stackTransition } from './transitionPolicy';
import { Platform } from '../../theme/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import type { RootStackParamList } from './types';
import { rootNavigationRef } from './navigationRef';
import AssetChartScreen from '../../screens/asset/AssetChartScreen';
import TradeHistoryScreen from '../../screens/history/TradeHistoryScreen';
import AuthStack from './AuthStack';
import MainTabs from './MainTabs';
import SplashScreen from '../../screens/auth/SplashScreen';
import ModeSelectionScreen from '../../screens/entry/ModeSelectionScreen';
import SeasonJoinScreen from '../../screens/season/SeasonJoinScreen';
import ScreenErrorBoundary from '../../components/states/ScreenErrorBoundary';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
  const { mode, colors } = useAppearance();
  const reducedMotion = useReducedMotion();
  const navigationTheme = {
    ...(mode === 'dark' ? DarkTheme : DefaultTheme),
    colors: {
      ...(mode === 'dark' ? DarkTheme.colors : DefaultTheme.colors),
      primary: colors.text,
      background: colors.screen,
      card: colors.surface,
      text: colors.text,
      border: colors.border,
    },
  };
  return (
    <NavigationContainer ref={rootNavigationRef} theme={navigationTheme}>
      <Stack.Navigator
        id="RootStack"
        initialRouteName="Splash"
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.screen }, ...rootTransition(reducedMotion) }}
        // Keep navigation and session/account providers alive during a render
        // failure. Retrying remounts only this root screen (MainTabs opens Home).
        screenLayout={({ children }) => (
          <ScreenErrorBoundary>{children}</ScreenErrorBoundary>
        )}
      >
        <Stack.Screen name="Splash" component={SplashScreen} />
        <Stack.Screen name="AuthStack" component={AuthStack} />
        <Stack.Screen name="ModeSelection" component={ModeSelectionScreen} />
        <Stack.Screen name="MainTabs" component={MainTabs} />
        <Stack.Screen name="TradeHistory" component={TradeHistoryScreen} options={{
          ...stackTransition(reducedMotion, Platform.OS),
          headerShown: true,
          title: '거래 내역',
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
        }} />
        <Stack.Screen name="SeasonJoin" component={SeasonJoinScreen} options={stackTransition(reducedMotion, Platform.OS)} />
        <Stack.Screen name="AssetChart" component={AssetChartScreen} options={chartTransition(reducedMotion)} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
