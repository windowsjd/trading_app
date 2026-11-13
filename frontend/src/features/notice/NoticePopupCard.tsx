import React from 'react';
import { ScrollView, Text, View, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import CTAButton from '../../components/common/CTAButton';

/**
 * The centered 공지 팝업 card (2026-11-13): 공지사항 label, the title and the
 * notice's summary — never the full text — with 자세히 보기 and 확인. The
 * text scrolls inside the card, so a long title or summary at a large font
 * size is never cut. Also drawn by the admin editor's preview.
 */
export default function NoticePopupCard({ title, summary, onDetail, onConfirm, testID = 'notice-popup' }: {
  title: string;
  summary: string;
  onDetail?: () => void;
  onConfirm?: () => void;
  testID?: string;
}) {
  const { height } = useWindowDimensions();
  return (
    <View testID={`${testID}-card`} accessibilityViewIsModal style={[styles.card, { maxHeight: Math.max(height * 0.8, 240) }]}>
      <Text style={styles.label}>공지사항</Text>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.text}>
        <Text testID={`${testID}-title`} accessibilityRole="header" style={styles.title}>{title}</Text>
        <Text testID={`${testID}-summary`} style={styles.summary}>{summary}</Text>
      </ScrollView>
      <View style={styles.actions}>
        <CTAButton testID={`${testID}-detail`} variant="neutral" label="자세히 보기" style={styles.flex} onPress={() => onDetail?.()} />
        <CTAButton testID={`${testID}-confirm`} label="확인" style={styles.flex} onPress={() => onConfirm?.()} />
      </View>
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  card: { width: '100%', maxWidth: 420, borderRadius: 20, backgroundColor: semantic.surface, padding: 20, gap: 12 },
  label: { alignSelf: 'flex-start', fontSize: 13, lineHeight: 18, fontWeight: '700', color: semantic.secondaryActionForeground },
  scroll: { flexGrow: 0, flexShrink: 1 },
  text: { gap: 10 },
  title: { fontSize: 19, lineHeight: 27, fontWeight: '700', color: semantic.text },
  summary: { fontSize: 15, lineHeight: 23, color: semantic.secondary },
  actions: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
} as const;
