import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import type { GuideStackParamList } from './types';
import GuideScreen from '../../screens/guide/GuideScreen';
import MarketBasicsScreen from '../../screens/guide/MarketBasicsScreen';
import MarketBasicsChaptersScreen from '../../screens/guide/MarketBasicsChaptersScreen';
import LiquidityScreen from '../../screens/guide/LiquidityScreen';
import CandlesScreen from '../../screens/guide/CandlesScreen';
import OrderTypesScreen from '../../screens/guide/OrderTypesScreen';

import GuideTopicScreen from '../../screens/guide/GuideTopicScreen';
import GuideChapterScreen from '../../screens/guide/GuideChapterScreen';

const Stack = createNativeStackNavigator<GuideStackParamList>();

export default function GuideStack() {
  return (
    <Stack.Navigator id="GuideStack">
      <Stack.Screen
        name="Guide"
        component={GuideScreen}
        options={{ title: '가이드' }}
      />
      <Stack.Screen
        name="MarketBasics"
        component={MarketBasicsChaptersScreen}
        options={{ title: '시장기초' }}
      />
      <Stack.Screen name="OrderBookLesson" component={MarketBasicsScreen} options={{ title: '호가창과 체결' }} />
      <Stack.Screen name="Liquidity" component={LiquidityScreen} options={{ title: '유동성과 가격 충격' }} />
      <Stack.Screen name="Candles" component={CandlesScreen} options={{ title: '캔들' }} />
      <Stack.Screen name="OrderTypes" component={OrderTypesScreen} options={{ title: '주문방식' }} />
      <Stack.Screen name="StockCharacteristics" component={GuideTopicScreen} options={{ title: '주식특성' }} />
      <Stack.Screen name="CorporateActions" component={GuideTopicScreen} options={{ title: '기업행동과 조정주가' }} />
      <Stack.Screen name="EtfIndex" component={GuideTopicScreen} options={{ title: 'ETF와 지수' }} />
      <Stack.Screen name="GuideChapter" component={GuideChapterScreen} options={{ title: '가이드 실습' }} />
    </Stack.Navigator>
  );
}
