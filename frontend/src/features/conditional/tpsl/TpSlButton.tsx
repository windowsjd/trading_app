import React from 'react';
import { Text, View } from '../../../theme/native';
import { semantic } from '../../../theme/tokens';
import CTAButton from '../../../components/common/CTAButton';
import { TP_SL_TITLE } from '../tpSlModel';

/**
 * The entry point to the 손절가/익절가 sheet on a holding, a pending entry or
 * an entry being created. The label never changes; a short count of what is
 * set (`익절 2건 · 손절 1건`) sits beside it. A futures position's card pairs
 * the same label with 포지션 종료 as two equal buttons (FuturesPositionCard).
 */
export default function TpSlButton({ testID, summary, disabled = false, learningHint = null, onPress }: {
  testID: string;
  /** `익절 2건 · 손절 1건`; null when nothing is set (or not yet known). */
  summary: string | null;
  disabled?: boolean;
  learningHint?: string | null;
  onPress: () => void;
}) {
  return (
    <View style={styles.row}>
      <CTAButton variant="secondary" testID={testID} label={TP_SL_TITLE} style={styles.button}
        state={disabled ? 'disabled' : 'enabled'} learningHint={learningHint} onPress={onPress} />
      {summary ? <Text testID={`${testID}-summary`} style={styles.summary}>{summary}</Text> : null}
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 6, minWidth: 0 },
  button: { flexGrow: 0, flexShrink: 1, minHeight: 40, paddingHorizontal: 14, maxWidth: '100%' },
  summary: { flexShrink: 1, minWidth: 0, fontSize: 13, lineHeight: 19, fontWeight: '600', color: semantic.secondary },
} as const;
