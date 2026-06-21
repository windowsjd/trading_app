import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import type { MyStackParamList } from './types';
import MyScreen from '../../screens/my/MyScreen';
import RewardScreen from '../../screens/reward/RewardScreen';
import SettingsScreen from '../../screens/my/SettingsScreen';

const Stack = createNativeStackNavigator<MyStackParamList>();

export default function MyStack() {
  return (
    <Stack.Navigator id="MyStack">
      <Stack.Screen
        name="My"
        component={MyScreen}
        options={{ title: 'MY' }}
      />
      <Stack.Screen
        name="Reward"
        component={RewardScreen}
        options={{ title: '보상 / 뱃지' }}
      />
      <Stack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: '설정' }}
      />
    </Stack.Navigator>
  );
}
