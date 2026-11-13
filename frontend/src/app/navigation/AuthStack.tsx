import PasswordResetScreen from '../../screens/auth/PasswordResetScreen';
import MembershipDeletionResultScreen from '../../screens/auth/MembershipDeletionResultScreen';
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';
import { stackScreenLayout } from './stackScreenLayout';

import type { AuthStackParamList } from './types';
import LoginScreen from '../../screens/auth/LoginScreen';
import SignupScreen from '../../screens/auth/SignupScreen';
import LegalDocumentScreen from '../../screens/auth/LegalDocumentScreen';

const Stack = createNativeStackNavigator<AuthStackParamList>();

export default function AuthStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="AuthStack" screenOptions={{ headerShown: false, ...stackTransition(reducedMotion, Platform.OS) }} screenLayout={stackScreenLayout}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Signup" component={SignupScreen} />
      {/* Pushed over 회원가입 (which keeps its inputs and boxes), with a header back. */}
      <Stack.Screen name="LegalDocument" component={LegalDocumentScreen}
        options={({ route }) => ({ headerShown: true, title: route.params.document === 'privacy' ? '개인정보처리방침' : '이용약관' })} />
      <Stack.Screen name="PasswordReset" component={PasswordResetScreen} />
      <Stack.Screen name="MembershipDeletionResult" component={MembershipDeletionResultScreen} options={{ gestureEnabled: false }} />
    </Stack.Navigator>
  );
}
