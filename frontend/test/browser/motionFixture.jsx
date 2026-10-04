import React, { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { rootNavigationRef as navigationRef } from '../../src/app/navigation/navigationRef';
import RootNavigator from '../../src/app/navigation/RootNavigator';
import { AppearanceProvider } from '../../src/theme/appearance';
import { TradingAccountProvider } from '../../src/features/tradingAccount/TradingAccountContext';
import ActionPressable from '../../src/components/common/ActionPressable';
import CTAButton from '../../src/components/common/CTAButton';
import { LessonAction } from '../../src/screens/guide/LessonUi';
import { ScrollView, Text } from '../../src/theme/native';
import { semantic } from '../../src/theme/tokens';
import { financial } from '../../src/theme/financialColors';
import { timing } from './motionMocks';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
window.fixture = { client, timing, navigationRef };
navigationRef.addListener('state', () => window.motion.events.push({ stage: 'route-state', time: performance.now(), route: navigationRef.getCurrentRoute()?.name }));
const onRender = (_id, phase, duration) => window.motion.commits.push({ phase, duration, time: performance.now() });
const probe = new URLSearchParams(location.search).has('probe');
const primaryProbe = new URLSearchParams(location.search).has('primaryProbe');
function PrimaryProbes() {
  const [state, setState] = React.useState('enabled');
  const submit = () => { window.fixture.primaryCalls = (window.fixture.primaryCalls ?? 0) + 1; setState('loading'); };
  window.fixture.finishPrimary = () => setState('enabled');
  return <ScrollView contentContainerStyle={{ padding: 24, gap: 16, backgroundColor: semantic.screen }}>
    <CTAButton testID="primary-wide" label="시즌 참가하기" state={state} onPress={submit} />
    <CTAButton testID="primary-narrow" label="완료" onPress={() => {}} style={{ width: 124 }} />
    <CTAButton testID="primary-long" label="확인한 내용을 저장하고 다음 단계로 계속 진행하기" onPress={() => {}} />
    <CTAButton testID="primary-disabled" label="환전하기" state="disabled" onPress={submit} />
    <CTAButton testID="primary-blocked" label="진행 불가" state="blocked" onPress={submit} />
    <CTAButton testID="primary-loading" label="처리 중" state="loading" onPress={submit} />
    <CTAButton testID="primary-neutral" label="뒤로가기" variant="neutral" onPress={() => {}} />
    <CTAButton testID="primary-buy" label="매수" style={{ backgroundColor: financial.buyAction }} onPress={() => {}} />
    <CTAButton testID="primary-sell" label="매도" style={{ backgroundColor: financial.sellAction }} onPress={() => {}} />
    <ActionPressable testID="primary-selected" accessibilityRole="tab" accessibilityState={{ selected: true }}
      style={{ backgroundColor: semantic.selected, borderRadius: 12, padding: 14 }} onPress={() => {}}>
      <Text style={{ color: semantic.onAccent }}>선택 탭</Text>
    </ActionPressable>
    <LessonAction id="primary-lesson" label="결과 확인" onPress={() => {}} />
    <LessonAction id="primary-lesson-selected" label="선택 값" selected onPress={() => {}} />
    <LessonAction id="primary-lesson-secondary" label="처음부터" secondary onPress={() => {}} />
    <LessonAction id="primary-lesson-financial" label="매수 실행" primary={false} onPress={() => {}} />
  </ScrollView>;
}
createRoot(document.getElementById('root')).render(
  <Profiler id="motion" onRender={onRender}>
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 0, right: 0, bottom: 0, left: 0 } }}>
      <QueryClientProvider client={client}>
        <AppearanceProvider>
          {primaryProbe ? <PrimaryProbes /> : probe ? <ScrollView contentContainerStyle={{ padding: 24, gap: 16, backgroundColor: semantic.screen }}>
            {[
              ['motion-probe', semantic.selected, semantic.onAccent, '선택 버튼'],
              ['motion-surface', semantic.surface, semantic.text, '밝은/어두운 표면'],
              ['motion-buy', financial.buyAction, semantic.onAccent, '구매하기'],
              ['motion-sell', financial.sellAction, semantic.onAccent, '판매하기'],
            ].map(([testID, backgroundColor, color, label]) => <ActionPressable key={testID} testID={testID} onPress={() => {}} style={{ backgroundColor, borderRadius: 12, padding: 20 }}>
              <Text style={{ color }}>{label}</Text>
            </ActionPressable>)}
          </ScrollView> : <TradingAccountProvider><RootNavigator /></TradingAccountProvider>}
        </AppearanceProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  </Profiler>,
);
