import React, { useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import { LEGAL_DOCUMENTS, type LegalBlock } from '../../constants/legalDocuments';
import type { LegalDocumentScreenProps } from '../../app/navigation/types';

/**
 * 이용약관 / 개인정보처리방침 opened from the signup screen's 자세히 보기
 * (2026-11-13): the title, the key points first, then the full text with
 * every table row, and a way back. Only reading: nothing here checks a
 * signup box, and the signup screen underneath keeps its inputs.
 */
export default function LegalDocumentScreen({ route, navigation }: LegalDocumentScreenProps) {
  const document = LEGAL_DOCUMENTS[route.params.document] ?? LEGAL_DOCUMENTS.terms;
  const [linkError, setLinkError] = useState(false);
  const open = async (url: string) => {
    setLinkError(false);
    try {
      await Linking.openURL(url);
    } catch {
      setLinkError(true);
    }
  };
  return (
    <ScrollView testID={`legal-document-${document.kind}`} style={styles.screen} contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>{document.title}</Text>

      <View testID="legal-document-summary" style={styles.summary}>
        <Text accessibilityRole="header" style={styles.summaryTitle}>핵심 내용 요약</Text>
        {document.summary.map((point, index) => (
          <View key={index} style={styles.bulletRow}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.summaryText}>{point}</Text>
          </View>
        ))}
        <Text style={styles.note}>요약은 이해를 돕기 위한 것이며, 아래 전문이 우선합니다.</Text>
      </View>

      <Text accessibilityRole="header" style={styles.fullTitle}>전문</Text>
      {document.intro ? <Text style={styles.paragraph}>{document.intro}</Text> : null}
      {document.sections.map((section) => (
        <View key={section.heading} style={styles.section}>
          <Text accessibilityRole="header" style={styles.heading}>{section.heading}</Text>
          {section.blocks.map((block, index) => (
            <Block key={index} block={block} onOpen={(url) => void open(url)} />
          ))}
        </View>
      ))}
      {linkError ? (
        <Text testID="legal-document-link-error" accessibilityLiveRegion="polite" style={styles.error}>
          링크를 열지 못했습니다. 잠시 후 다시 시도해주세요.
        </Text>
      ) : null}

      <CTAButton testID="legal-document-back" variant="neutral" label="이전 화면으로 돌아가기" onPress={() => navigation.goBack()} />
    </ScrollView>
  );
}

function Block({ block, onOpen }: { block: LegalBlock; onOpen: (url: string) => void }) {
  if (block.kind === 'paragraph') return <Text style={styles.paragraph}>{block.text}</Text>;
  if (block.kind === 'list') {
    return (
      <View style={styles.list}>
        {block.items.map((item, index) => (
          <View key={index} style={styles.bulletRow}>
            <Text style={styles.marker}>{block.ordered ? `${index + 1}.` : '•'}</Text>
            <Text style={[styles.paragraph, styles.rowText]}>{item}</Text>
          </View>
        ))}
      </View>
    );
  }
  if (block.kind === 'table') {
    // One card per row, every cell under its column's name (the first cell
    // in bold), so each wraps in full on a 320 pt phone at large text.
    return (
      <View style={styles.list}>
        {block.rows.map((row, rowIndex) => (
          <View key={rowIndex} testID="legal-document-table-row" style={styles.rowCard}>
            {row.map((cell, cellIndex) => (
              <View key={cellIndex} style={styles.cell}>
                <Text style={styles.cellLabel}>{block.columns[cellIndex]}</Text>
                <Text style={cellIndex ? styles.cellText : styles.rowTitle}>{cell}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    );
  }
  return (
    <ActionPressable accessibilityRole="link" accessibilityLabel={block.label} onPress={() => onOpen(block.url)} style={styles.link}>
      <Text style={styles.linkText}>{block.label}</Text>
      {block.url.startsWith('mailto:') ? null : <Text selectable style={styles.url}>{block.url}</Text>}
    </ActionPressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getHeaderScreenContentStyle(Platform.OS), paddingBottom: 40 },
  title: { fontSize: 24, lineHeight: 32, fontWeight: '800', color: semantic.text },
  summary: { gap: 10, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface },
  summaryTitle: { fontSize: 17, lineHeight: 24, fontWeight: '700', color: semantic.text },
  summaryText: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 23, color: semantic.text },
  note: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  fullTitle: { fontSize: 19, lineHeight: 27, fontWeight: '700', color: semantic.text, marginTop: 8 },
  section: { gap: 8, paddingTop: 4 },
  heading: { fontSize: 16, lineHeight: 24, fontWeight: '700', color: semantic.text },
  paragraph: { fontSize: 15, lineHeight: 24, color: semantic.secondary },
  // Beside a marker: takes the rest of the row and wraps there.
  rowText: { flex: 1, minWidth: 0 },
  list: { gap: 6 },
  bulletRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  bullet: { fontSize: 15, lineHeight: 23, color: semantic.text },
  marker: { minWidth: 18, fontSize: 15, lineHeight: 24, color: semantic.secondary },
  rowCard: { gap: 6, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface },
  rowTitle: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.text },
  cell: { gap: 2 },
  cellLabel: { fontSize: 13, lineHeight: 19, fontWeight: '600', color: semantic.secondary },
  cellText: { fontSize: 15, lineHeight: 23, color: semantic.text },
  link: { minHeight: 44, justifyContent: 'center', gap: 2 },
  linkText: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.secondaryActionForeground, textDecorationLine: 'underline' },
  url: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  error: { fontSize: 14, lineHeight: 20, color: semantic.error },
});
