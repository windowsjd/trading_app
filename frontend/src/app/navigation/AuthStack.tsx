import PasswordResetScreen from '../../screens/auth/PasswordResetScreen';
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';
import { stackScreenLayout } from './stackScreenLayout';

import type { AuthStackParamList } from './types';
import LoginScreen from '../../screens/auth/LoginScreen';
import SignupScreen from '../../screens/auth/SignupScreen';

const Stack = createNativeStackNavigator<AuthStackParamList>();

export default function AuthStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="AuthStack" screenOptions={{ headerShown: false, ...stackTransition(reducedMotion, Platform.OS) }} screenLayout={stackScreenLayout}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Signup" component={SignupScreen} />
      <Stack.Screen name="PasswordReset" component={PasswordResetScreen} />
    </Stack.Navigator>
  );
}
