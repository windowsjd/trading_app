import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import type { GuideStackParamList } from './types';
import GuideScreen from '../../screens/guide/GuideScreen';

const Stack = createNativeStackNavigator<GuideStackParamList>();

export default function GuideStack() {
  return (
    <Stack.Navigator id="GuideStack">
      <Stack.Screen
        name="Guide"
        component={GuideScreen}
        options={{ title: '가이드' }}
      />
    </Stack.Navigator>
  );
}
