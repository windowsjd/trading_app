import FuturesScreen from '../../screens/futures/FuturesScreen';
import React from 'react';
import { mainTabHeaderTitle } from '../../components/navigation/MainTabHeaderTitle';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';
import { stackScreenLayout } from './stackScreenLayout';
import { questNavigationRouter } from '../../features/quest/questNavigationGuard';

import type { MarketStackParamList } from './types';
import MarketScreen from '../../screens/market/MarketScreen';
import WatchlistScreen from '../../screens/market/WatchlistScreen';
import MarketSearchScreen from '../../screens/market/MarketSearchScreen';
import AssetDetailScreen from '../../screens/asset/AssetDetailScreen';
import OrderScreen from '../../screens/order/OrderScreen';

const Stack = createNativeStackNavigator<MarketStackParamList>();

export default function MarketStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="MarketStack" UNSTABLE_router={questNavigationRouter} screenOptions={stackTransition(reducedMotion, Platform.OS)} screenLayout={stackScreenLayout}>
      <Stack.Screen
        name="Market"
        component={MarketScreen}
        options={{ title: '마켓', headerTitle: mainTabHeaderTitle('market') }}
      />
      <Stack.Screen
        name="MarketSearch"
        component={MarketSearchScreen}
        options={{ title: '종목 검색' }}
      />
      <Stack.Screen name="Watchlist" component={WatchlistScreen} options={{ title: '관심종목' }} />
      {/* The trading screens' titles take the tab headers' heavy theme font:
          same family, color and size, only bolder. */}
      <Stack.Screen
        name="AssetDetail"
        component={AssetDetailScreen}
        options={({ theme }) => ({ title: '종목 상세', headerTitleStyle: theme.fonts.heavy })}
      />
      <Stack.Screen
        name="Order"
        component={OrderScreen}
        options={({ theme }) => ({ title: '주문', headerTitleStyle: theme.fonts.heavy })}
      />
      <Stack.Screen name="Futures" component={FuturesScreen} options={{ title: '암호화폐 선물' }} />
    </Stack.Navigator>
  );
}
