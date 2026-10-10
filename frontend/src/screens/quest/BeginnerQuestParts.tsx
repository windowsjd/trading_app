import React from 'react';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import type { BeginnerQuestStatus, QuestDisplayState } from '../../features/quest/questProgress';

/** Unknown (loading/error) keeps a neutral or error tone; never the done tone. */
export function QuestStatusBadge({ display, status, testID }: {
  display: QuestDisplayState;
  status: BeginnerQuestStatus | null;
  testID?: string;
}) {
  const tone = display.kind === 'error'
    ? styles.error
    : status === 'completed'
      ? styles.done
      : status === 'in_progress'
        ? styles.active
        : styles.idle;
  const text = display.kind === 'error'
    ? styles.errorText
    : status === 'completed'
      ? styles.doneText
      : status === 'in_progress'
        ? styles.activeText
        : styles.idleText;
  return (
    <View style={[styles.badge, tone]} testID={testID}>
      <Text style={[styles.badgeText, text]} accessibilityLabel={`진행 상태 ${display.statusLabel}`}>{display.statusLabel}</Text>
    </View>
  );
}

/** Decorative; the adjacent "실습 n/2 완료" text carries the same fact. */
export function QuestProgressBar({ completed, total }: { completed: number; total: number }) {
  return (
    <View style={styles.bar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: total }, (_, index) => (
        <View key={index} style={[styles.segment, index < completed ? styles.segmentDone : null]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
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
});
