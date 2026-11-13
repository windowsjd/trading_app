import React from 'react';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';

export type NoticeSectionsProps = { sections: ReadonlyArray<{ heading: string; paragraphs: readonly string[] }> };

/**
 * A notice's sections as 공지사항 draws them (a heading, then its paragraphs,
 * line breaks kept): the list itself and the admin editor's preview, so the
 * preview is exactly what members will read. Plain Text only — nothing in a
 * notice is ever interpreted as markup.
 */
export default function NoticeSections({ sections }: NoticeSectionsProps) {
  return (
    <>
      {sections.map((section, index) => (
        // Positions, not text: an admin may repeat a heading or a paragraph.
        <View key={index} style={styles.section}>
          <Text accessibilityRole="header" style={styles.heading}>{section.heading}</Text>
          {section.paragraphs.map((paragraph, paragraphIndex) => (
            <Text key={paragraphIndex} style={styles.paragraph}>{paragraph}</Text>
          ))}
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  section: { gap: 6, paddingTop: 14 },
  heading: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.text },
  paragraph: { fontSize: 15, lineHeight: 24, color: semantic.secondary },
});
