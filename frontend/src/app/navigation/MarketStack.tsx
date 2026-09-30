import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';

import type { MarketStackParamList } from './types';
import MarketScreen from '../../screens/market/MarketScreen';
import MarketSearchScreen from '../../screens/market/MarketSearchScreen';
import AssetDetailScreen from '../../screens/asset/AssetDetailScreen';
import OrderScreen from '../../screens/order/OrderScreen';

const Stack = createNativeStackNavigator<MarketStackParamList>();

export default function MarketStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="MarketStack" screenOptions={stackTransition(reducedMotion, Platform.OS)}>
      <Stack.Screen
        name="Market"
        component={MarketScreen}
        options={{ title: '마켓' }}
      />
      <Stack.Screen
        name="MarketSearch"
        component={MarketSearchScreen}
        options={{ title: '종목 검색' }}
      />
      <Stack.Screen
        name="AssetDetail"
        component={AssetDetailScreen}
        options={{ title: '종목 상세' }}
      />
      <Stack.Screen
        name="Order"
        component={OrderScreen}
        options={{ title: '주문' }}
      />
    </Stack.Navigator>
  );
}
