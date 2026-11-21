import React from 'react';
import { mainTabHeaderTitle } from '../../components/navigation/MainTabHeaderTitle';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';
import { stackScreenLayout } from './stackScreenLayout';
import type { ModesStackParamList } from './types';
import GuestModesScreen from '../../screens/entry/GuestModesScreen';
import LegalDocumentScreen from '../../screens/auth/LegalDocumentScreen';

const Stack = createNativeStackNavigator<ModesStackParamList>();

/** 투자모드: guest browsing's fifth tab, in MY's place. */
export default function ModesStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="ModesStack" screenOptions={stackTransition(reducedMotion, Platform.OS)} screenLayout={stackScreenLayout}>
      <Stack.Screen name="Modes" component={GuestModesScreen} options={{ title: '투자모드', headerTitle: mainTabHeaderTitle('modes') }} />
      <Stack.Screen name="LegalDocument" component={LegalDocumentScreen}
        options={({ route }) => ({ title: route.params.document === 'privacy' ? '개인정보처리방침' : '이용약관' })} />
    </Stack.Navigator>
  );
}
