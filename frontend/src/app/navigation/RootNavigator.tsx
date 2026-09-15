import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import type { RootStackParamList } from './types';
import { rootNavigationRef } from './navigationRef';
import AuthStack from './AuthStack';
import MainTabs from './MainTabs';
import SplashScreen from '../../screens/auth/SplashScreen';
import ModeSelectionScreen from '../../screens/entry/ModeSelectionScreen';
import SeasonJoinScreen from '../../screens/season/SeasonJoinScreen';
import ScreenErrorBoundary from '../../components/states/ScreenErrorBoundary';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
  return (
    <NavigationContainer ref={rootNavigationRef}>
      <Stack.Navigator
        id="RootStack"
        initialRouteName="Splash"
        screenOptions={{ headerShown: false }}
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
        <Stack.Screen name="SeasonJoin" component={SeasonJoinScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
