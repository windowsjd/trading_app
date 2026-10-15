import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from '../../theme/native';
import Svg, { Path } from 'react-native-svg';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import ActionPressable from '../../components/common/ActionPressable';
import SegmentedControl from '../../components/common/SegmentedControl';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import type { MarginMode } from '../../features/futures/api';

const MARGIN_LABEL: Record<MarginMode, string> = { isolated: '격리(Isolated)', cross: '교차(Cross)' };

/**
 * 증거금 모드 for a new position. The small ⓘ beside the title opens a short
 * help sheet on 격리 and 교차; the form itself carries no explanation text.
 * The switch and the server's margin policies are unchanged.
 */
export default function FuturesMarginModeField({ value, onChange, disabled }: {
  value: MarginMode;
  onChange: (mode: MarginMode) => void;
  disabled: boolean;
}) {
  const { colors } = useAppearance();
  const [help, setHelp] = useState(false);
  return (
    <View style={styles.group}>
      <View style={styles.title}>
        <Text style={styles.label}>증거금 모드</Text>
        <ActionPressable
          testID="futures-margin-info"
          accessibilityRole="button"
          accessibilityLabel="증거금 모드 설명"
          accessibilityHint="격리와 교차의 차이를 엽니다"
          // A 24pt mark with a 44pt target.
          hitSlop={10}
          onPress={() => setHelp(true)}
          style={styles.info}
        >
          <Svg width={16} height={16} viewBox="0 0 24 24" aria-hidden>
            <Path d="M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 11v6M12 7.5v.5" fill="none" stroke={colors.secondary}
              strokeWidth={2} strokeLinecap="round" />
          </Svg>
        </ActionPressable>
      </View>
      <SegmentedControl testID="futures-margin-mode" accessibilityLabel="증거금 모드" compact value={value} onChange={onChange}
        options={(['isolated', 'cross'] as const).map((mode) => ({
          key: mode, label: mode === 'isolated' ? '격리' : '교차', accessibilityLabel: MARGIN_LABEL[mode],
          testID: `futures-margin-${mode}`, disabled,
        }))} />
      <SheetPortal>
        <InlineBottomSheet testID="futures-margin-info-sheet" title="증거금 모드" floating visible={help} onClose={() => setHelp(false)}>
          <ScrollView style={styles.scroll} bounces={false}>
            <View style={styles.help} testID="futures-margin-info-body">
              <View style={styles.term}>
                <Text accessibilityRole="header" style={styles.termTitle}>격리 (Isolated)</Text>
                <Text style={styles.termText}>
                  해당 포지션에 배정된 증거금을 기준으로 위험을 관리합니다. 다른 교차 포지션의 공동 담보와 구분됩니다.
                </Text>
              </View>
              <View style={styles.term}>
                <Text accessibilityRole="header" style={styles.termTitle}>교차 (Cross)</Text>
                <Text style={styles.termText}>
                  선물 지갑의 공동 담보를 교차 포지션들이 함께 사용합니다. 다른 교차 포지션의 손익과 위험도 사용 가능 담보에 영향을 줄 수 있습니다.
                </Text>
              </View>
            </View>
          </ScrollView>
        </InlineBottomSheet>
      </SheetPortal>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 4, minWidth: 0 },
  title: { flexDirection: 'row', alignItems: 'center', gap: 2, minWidth: 0 },
  label: { fontSize: 12, color: semantic.muted, flexShrink: 1 },
  info: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 0, flexShrink: 1 },
  help: { gap: 16, paddingHorizontal: 4, paddingBottom: 8 },
  term: { gap: 4 },
  termTitle: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.text },
  termText: { fontSize: 14, lineHeight: 21, color: semantic.secondary },
});
