import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';

import type { RecordStackParamList } from './types';
import RecordSeasonListScreen from '../../screens/record/RecordSeasonListScreen';
import RecordSeasonDetailScreen from '../../screens/record/RecordSeasonDetailScreen';
import RecordProfitAnalysisScreen from '../../screens/record/RecordProfitAnalysisScreen';

const Stack = createNativeStackNavigator<RecordStackParamList>();

export default function RecordStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="RecordStack" screenOptions={stackTransition(reducedMotion, Platform.OS)}>
      <Stack.Screen
        name="RecordSeasonList"
        component={RecordSeasonListScreen}
        options={{ title: '전적' }}
      />
      <Stack.Screen
        name="RecordSeasonDetail"
        component={RecordSeasonDetailScreen}
        options={{ title: '시즌 상세' }}
      />
      <Stack.Screen
        name="RecordProfitAnalysis"
        component={RecordProfitAnalysisScreen}
        options={{ title: '수익 분석' }}
      />
    </Stack.Navigator>
  );
}
