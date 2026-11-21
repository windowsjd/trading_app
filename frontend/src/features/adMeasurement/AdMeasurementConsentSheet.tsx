import React from 'react';
import { ScrollView, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import CTAButton from '../../components/common/CTAButton';
import { AD_MEASUREMENT_NOTICE } from './consent';

type Props = {
  visible: boolean;
  /** The one-time question after install: answered with a button, never just closed. */
  requiresAnswer: boolean;
  busy: boolean;
  platform: 'ios' | 'android';
  onAgree: () => void;
  onDecline: () => void;
  onClose: () => void;
  testID?: string;
};

/**
 * The 광고 성과 측정 notice and its two answers (2026-11-21): everything a
 * person needs before agreeing — who receives what, why, where, for how long,
 * what is never sent — and that refusing costs nothing. 동의 and 동의하지 않음
 * look the same, so neither is the obvious tap. On iOS it says that the
 * system's 앱 추적 허용 follows; that prompt appears only after 동의.
 */
export default function AdMeasurementConsentSheet({
  visible, requiresAnswer, busy, platform, onAgree, onDecline, onClose, testID = 'ad-measurement-consent',
}: Props) {
  const notice = AD_MEASUREMENT_NOTICE;
  return (
    <InlineBottomSheet visible={visible} onClose={onClose} dismissible={!requiresAnswer && !busy} testID={testID}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>{notice.title}</Text>
        <Text style={styles.body}>{notice.lead}</Text>
        <View style={styles.table}>
          {notice.rows.map((row) => (
            <View key={row.label} style={styles.row}>
              <Text style={styles.label}>{row.label}</Text>
              <Text style={styles.value}>{row.value}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.body}>{notice.excluded}</Text>
        <Text style={styles.body}>{platform === 'ios' ? notice.ios : notice.android}</Text>
        <Text style={styles.emphasis}>{notice.refusal}</Text>
      </ScrollView>
      <View style={styles.actions}>
        <CTAButton testID={`${testID}-decline`} label="동의하지 않음" variant="secondary" style={styles.action}
          state={busy ? 'disabled' : 'enabled'} onPress={onDecline} />
        <CTAButton testID={`${testID}-agree`} label="동의" variant="secondary" style={styles.action}
          state={busy ? 'loading' : 'enabled'} onPress={onAgree} />
      </View>
    </InlineBottomSheet>
  );
}

// Plain objects: navigator and screen harnesses load this with minimal react-native mocks.
const styles = {
  scroll: { flexShrink: 1 },
  content: { gap: 10, paddingHorizontal: 4, paddingBottom: 4 },
  title: { fontSize: 18, lineHeight: 26, fontWeight: '700' as const },
  body: { fontSize: 14, lineHeight: 21, color: semantic.secondary },
  emphasis: { fontSize: 14, lineHeight: 21, fontWeight: '600' as const },
  table: { borderWidth: 1, borderColor: semantic.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 4 },
  row: { paddingVertical: 8, gap: 2 },
  label: { fontSize: 13, lineHeight: 19, fontWeight: '600' as const, color: semantic.secondary },
  value: { fontSize: 14, lineHeight: 21 },
  actions: { flexDirection: 'row' as const, gap: 8, paddingTop: 4 },
  action: { flex: 1 },
};
