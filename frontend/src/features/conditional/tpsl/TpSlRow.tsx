import React, { useState } from 'react';
import { Text, View } from '../../../theme/native';
import { semantic } from '../../../theme/tokens';
import ActionPressable from '../../../components/common/ActionPressable';

/**
 * One registered (or pending) setting in the 손절가/익절가 sheet: what it is,
 * its state, and — while it can still be canceled — a two-step cancel inside
 * the sheet (취소 → 취소하기 / 유지). Changing a price or share is cancel then
 * register again; there is no edit.
 */
export default function TpSlRow({ testID, title, detail, state, note, tone = 'normal', cancelLabel, canceling = false, confirm = true, onCancel }: {
  testID: string;
  /** e.g. `익절 · 110 USD 이상` */
  title: string;
  /** e.g. `수량 3주` / `체결 수량의 30%` */
  detail: string;
  state: string;
  note?: string | null;
  tone?: 'normal' | 'warning';
  /** Present only while the row can be canceled. */
  cancelLabel?: string | null;
  canceling?: boolean;
  /** False for a local draft: removed at once, nothing on the server. */
  confirm?: boolean;
  onCancel?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <View testID={testID} style={styles.row}>
      <View style={styles.line}>
        <Text style={styles.title}>{title}</Text>
        <Text testID={`${testID}-state`} style={[styles.state, tone === 'warning' && styles.warning]}>{state}</Text>
      </View>
      <Text style={styles.detail}>{detail}</Text>
      {note ? <Text testID={`${testID}-note`} style={[styles.detail, tone === 'warning' && styles.warning]}>{note}</Text> : null}
      {cancelLabel && onCancel ? (
        confirming ? (
          <View style={styles.actions}>
            <Text style={styles.detail}>이 설정을 취소할까요?</Text>
            <ActionPressable testID={`${testID}-keep`} accessibilityRole="button" disabled={canceling}
              onPress={() => setConfirming(false)} style={styles.action}>
              <Text style={styles.actionText}>유지</Text>
            </ActionPressable>
            <ActionPressable testID={`${testID}-confirm-cancel`} accessibilityRole="button" disabled={canceling}
              accessibilityState={{ disabled: canceling, busy: canceling }} aria-busy={canceling}
              onPress={() => { setConfirming(false); onCancel(); }} style={[styles.action, styles.destructive]}>
              <Text style={[styles.actionText, styles.destructiveText]}>취소하기</Text>
            </ActionPressable>
          </View>
        ) : (
          <ActionPressable testID={`${testID}-cancel`} accessibilityRole="button" disabled={canceling}
            accessibilityState={{ disabled: canceling, busy: canceling }} aria-busy={canceling}
            onPress={() => { if (confirm) setConfirming(true); else onCancel(); }} style={[styles.action, styles.cancel]}>
            <Text style={styles.actionText}>{canceling ? '취소 중...' : cancelLabel}</Text>
          </ActionPressable>
        )
      ) : null}
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  row: { gap: 4, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: semantic.border, minWidth: 0 },
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 2 },
  title: { flexShrink: 1, minWidth: 0, fontSize: 14, lineHeight: 20, fontWeight: '700', color: semantic.text, fontVariant: ['tabular-nums'] as 'tabular-nums'[] },
  state: { flexShrink: 0, fontSize: 12, lineHeight: 18, fontWeight: '600', color: semantic.secondary },
  warning: { color: semantic.warning },
  detail: { fontSize: 12, lineHeight: 18, color: semantic.secondary, flexShrink: 1, fontVariant: ['tabular-nums'] as 'tabular-nums'[] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 6, marginTop: 4 },
  action: { minHeight: 36, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.raised },
  cancel: { alignSelf: 'flex-start', marginTop: 4 },
  destructive: { borderColor: semantic.error },
  actionText: { fontSize: 13, fontWeight: '600', color: semantic.text },
  destructiveText: { color: semantic.error },
} as const;
