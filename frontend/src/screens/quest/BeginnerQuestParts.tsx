import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import TabBarIcon from '../../components/navigation/TabBarIcon';
import type { QuestCardState } from '../../features/quest/questProgress';

export function QuestReplayIcon() {
  const { colors } = useAppearance();
  return <Svg testID="quest-replay-icon" width={16} height={16} viewBox="0 0 24 24" fill="none"
    stroke={colors.secondaryActionForeground} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" focusable={false} aria-hidden>
    <Path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6" />
  </Svg>;
}

/** Unknown (loading/error) keeps a neutral or error tone; never the done tone. */
export function QuestStatusBadge({ state, label, testID }: { state: QuestCardState; label: string; testID?: string }) {
  const tone = state === 'error' ? styles.error
    : state === 'completed' ? styles.done
      : state === 'active' ? styles.active
        : styles.idle;
  const text = state === 'error' ? styles.errorText
    : state === 'completed' ? styles.doneText
      : state === 'active' ? styles.activeText
        : styles.idleText;
  return (
    <View style={[styles.badge, tone]} testID={testID}>
      <Text style={[styles.badgeText, text]} accessibilityLabel={`진행 상태 ${label}`}>{label}</Text>
    </View>
  );
}

/** Decorative; the adjacent "퀘스트 n/2 완료" text carries the same fact. */
export function QuestProgressBar({ completed, total }: { completed: number; total: number }) {
  return (
    <View style={styles.bar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: total }, (_, index) => (
        <View key={index} style={[styles.segment, index < completed ? styles.segmentDone : null]} />
      ))}
    </View>
  );
}

/** The quest flag in a tinted disc; success-tinted once the server proved it. */
export function QuestMark({ done }: { done: boolean }) {
  const { colors } = useAppearance();
  return (
    <View style={[styles.mark, done ? styles.markDone : null]}
      accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <TabBarIcon name="quest" size={20} color={done ? colors.success : colors.info} focused />
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexShrink: 0, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 13, lineHeight: 20, fontWeight: '700' },
  idle: { backgroundColor: semantic.raised },
  idleText: { color: semantic.secondary },
  active: { backgroundColor: semantic.infoSurface },
  activeText: { color: semantic.info },
  done: { backgroundColor: semantic.successSurface },
  doneText: { color: semantic.success },
  error: { backgroundColor: semantic.errorSurface },
  errorText: { color: semantic.error },
  bar: { flexDirection: 'row', gap: 6 },
  segment: { flex: 1, height: 6, borderRadius: 3, backgroundColor: semantic.border },
  segmentDone: { backgroundColor: semantic.success },
  mark: {
    width: 40,
    height: 40,
    borderRadius: 20,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: semantic.infoSurface,
  },
  markDone: { backgroundColor: semantic.successSurface },
});
