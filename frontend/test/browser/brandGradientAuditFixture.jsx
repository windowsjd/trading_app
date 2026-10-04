import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppearanceProvider } from '../../src/theme/appearance';
import { semantic } from '../../src/theme/tokens';
import { financial } from '../../src/theme/financialColors';
import { ScrollView, View, Text } from '../../src/theme/native';
import CTAButton from '../../src/components/common/CTAButton';
import ActionPressable from '../../src/components/common/ActionPressable';
import { LessonAction } from '../../src/screens/guide/LessonUi';

const action = () => { window.actionCalls = (window.actionCalls ?? 0) + 1; };
const buttonStyle = { borderRadius: 12, paddingVertical: 14, alignItems: 'center' };
function Fixture() {
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12, backgroundColor: semantic.screen }}>
      <CTAButton testID="brand-full" label="확인" onPress={action} />
      <CTAButton testID="brand-narrow" label="확인" onPress={action} style={{ width: 96 }} />
      <CTAButton testID="brand-neutral" label="확인" onPress={action} variant="neutral" />
      {['disabled', 'blocked', 'loading'].map((state) => (
        <CTAButton key={state} testID={`brand-${state}`} label="확인" onPress={action} state={state} />
      ))}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <CTAButton testID="brand-buy" label="매수" onPress={action} style={{ flex: 1, backgroundColor: financial.buyAction }} />
        <CTAButton testID="brand-sell" label="매도" onPress={action} style={{ flex: 1, backgroundColor: financial.sellAction }} />
      </View>
      <ActionPressable testID="brand-custom" primary onPress={action} style={{ ...buttonStyle, backgroundColor: semantic.selected }}>
        <Text style={{ color: semantic.onAccent, fontSize: 16, fontWeight: '700' }}>로그인</Text>
      </ActionPressable>
      <ActionPressable testID="brand-selected" onPress={action} style={{ ...buttonStyle, backgroundColor: semantic.selected }}>
        <Text style={{ color: semantic.onAccent }}>선택</Text>
      </ActionPressable>
      <LessonAction id="brand-lesson" label="결과 확인" onPress={action} />
      <LessonAction id="brand-lesson-choice" label="선택" selected onPress={action} />
      <LessonAction id="brand-lesson-financial" label="매수 실행" primary={false} onPress={action} />
      <LessonAction id="brand-lesson-secondary" label="처음부터" secondary onPress={action} />
    </ScrollView>
  );
}
createRoot(document.getElementById('root')).render(<AppearanceProvider><Fixture /></AppearanceProvider>);
