import React from 'react';
import { mainTabHeaderTitle } from '../../components/navigation/MainTabHeaderTitle';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';
import { stackScreenLayout } from './stackScreenLayout';
import HeaderHomeBackButton from '../../components/navigation/HeaderHomeBackButton';

import type { GuideStackParamList } from './types';
import GuideScreen from '../../screens/guide/GuideScreen';
import BeginnerLearningScreen from '../../screens/quest/BeginnerLearningScreen';
import MarketBasicsScreen from '../../screens/guide/MarketBasicsScreen';
import MarketBasicsChaptersScreen from '../../screens/guide/MarketBasicsChaptersScreen';
import LiquidityScreen from '../../screens/guide/LiquidityScreen';
import CandlesScreen from '../../screens/guide/CandlesScreen';
import OrderTypesScreen from '../../screens/guide/OrderTypesScreen';

import GuideTopicScreen from '../../screens/guide/GuideTopicScreen';
import GuideChapterScreen from '../../screens/guide/GuideChapterScreen';

const Stack = createNativeStackNavigator<GuideStackParamList>();

/**
 * The beginner's 퀘스트 and the general member's 가이드 (2026-11-07): routes
 * kept under their tab names (the quest guide is bound to QuestTab) but
 * hidden from the tab bar; Home's header opens them and their first screen
 * goes back to Home. Guests keep 가이드 as a visible tab without that button.
 */
export function QuestStack() {
  return <GuideStack beginner homeBack />;
}

export function MemberGuideStack() {
  return <GuideStack homeBack />;
}

const homeBackOptions = { headerLeft: ({ tintColor }: { tintColor?: string }) => <HeaderHomeBackButton tintColor={tintColor} /> };

export default function GuideStack({ beginner = false, homeBack = false }: { beginner?: boolean; homeBack?: boolean } = {}) {
  const reducedMotion = useReducedMotion();
  return (
    // Lesson titles (시장기초, 호가창과 체결…) use the tab headers' 700-weight
    // theme font instead of the platform's lighter default stack title.
    <Stack.Navigator id="GuideStack" screenOptions={({ theme }) => ({
      ...stackTransition(reducedMotion, Platform.OS), headerTitleStyle: theme.fonts.heavy,
    })} screenLayout={stackScreenLayout}>
      <Stack.Screen
        name="Guide"
        component={beginner ? BeginnerLearningScreen : GuideScreen}
        options={{
          ...(beginner
            ? { title: '퀘스트', headerTitle: mainTabHeaderTitle('quest') }
            : { title: '가이드', headerTitle: mainTabHeaderTitle('guide') }),
          ...(homeBack ? homeBackOptions : {}),
        }}
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
      <Stack.Screen name="EtfIndex" component={GuideTopicScreen} options={{ title: 'ETF와 지수' }} />
      <Stack.Screen name="GuideChapter" component={GuideChapterScreen} options={{ title: '가이드 실습' }} />
    </Stack.Navigator>
  );
}
