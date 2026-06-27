import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import type { RecordStackParamList } from './types';
import RecordSeasonListScreen from '../../screens/record/RecordSeasonListScreen';
import RecordSeasonDetailScreen from '../../screens/record/RecordSeasonDetailScreen';
import RecordProfitAnalysisScreen from '../../screens/record/RecordProfitAnalysisScreen';
import RecordOrderListScreen from '../../screens/record/RecordOrderListScreen';
import RecordExchangeListScreen from '../../screens/record/RecordExchangeListScreen';

const Stack = createNativeStackNavigator<RecordStackParamList>();

export default function RecordStack() {
  return (
    <Stack.Navigator id="RecordStack">
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
      <Stack.Screen
        name="RecordOrderList"
        component={RecordOrderListScreen}
        options={{ title: '거래 내역' }}
      />
      <Stack.Screen
        name="RecordExchangeList"
        component={RecordExchangeListScreen}
        options={{ title: '환전 내역' }}
      />
    </Stack.Navigator>
  );
}
