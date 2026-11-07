import React from 'react';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';

/**
 * A Home header action (2026-11-07): 36dp pill in a 44dp target, radius 12,
 * icon 18 + label 14/700 in the secondary action colors (the guide's 학습
 * 시작 tone; dark mode through the tokens). `iconOnly` when the header is
 * too narrow; the label stays for screen readers. A count badge sits 8dp
 * outside the top right corner, ringed in the header's color (surface).
 */
export default function HomeHeaderButton({ testID, icon, label, accessibilityLabel, badge = null, iconOnly = false, onPress }: {
  testID: string;
  icon: React.ReactNode;
  label: string;
  accessibilityLabel?: string;
  badge?: number | null;
  iconOnly?: boolean;
  onPress: () => void;
}) {
  const a11y = `${accessibilityLabel ?? label}${badge ? `, 남은 퀘스트 ${badge}개` : ''}`;
  return (
    <ActionPressable testID={testID} accessibilityRole="button" accessibilityLabel={a11y} onPress={onPress}
      hitSlop={{ top: 4, bottom: 4 }}
      style={{ minHeight: 36, minWidth: 36, borderRadius: 12, paddingHorizontal: iconOnly ? 9 : 12, flexDirection: 'row',
        alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: semantic.secondaryActionSurface }}>
      {icon}
      {iconOnly ? null : (
        <Text numberOfLines={1} maxFontSizeMultiplier={1.6}
          style={{ fontSize: 14, lineHeight: 20, fontWeight: '700', color: semantic.secondaryActionForeground }}>{label}</Text>
      )}
      {badge ? (
        <View testID={`${testID}-badge`} pointerEvents="none" accessible={false}
          style={{ position: 'absolute', top: -8, right: -8, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
            alignItems: 'center', justifyContent: 'center', backgroundColor: semantic.alert, borderWidth: 2, borderColor: semantic.surface }}>
          <Text maxFontSizeMultiplier={1.2} style={{ fontSize: 10, lineHeight: 12, fontWeight: '700', color: semantic.onAlert }}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      ) : null}
    </ActionPressable>
  );
}
