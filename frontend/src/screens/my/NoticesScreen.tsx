import React, { useEffect, useRef, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MyStackParamList } from '../../app/navigation/types';
import { Platform, ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import ActionPressable from '../../components/common/ActionPressable';
import EmptyState from '../../components/states/EmptyState';
import { notices, type Notice } from '../../features/notice/notices';

const formatDate = (day: string) => day.split('-').join('.');

/**
 * 전체 > 공지사항. Each notice opens in place. A link from elsewhere (the
 * order book guide) passes `noticeId`: that notice is opened and scrolled to,
 * so the reader lands on its content inside this list.
 */
export default function NoticesScreen({ route }: NativeStackScreenProps<MyStackParamList, 'Notices'>) {
  const target = route.params?.noticeId;
  const [open, setOpen] = useState<string | null>(target ?? null);
  const scroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (target) setOpen(target);
  }, [target]);

  if (!notices.length) {
    return (
      <EmptyState
        title="등록된 공지사항이 없습니다."
        message="새로운 공지사항이 등록되면 이곳에서 확인할 수 있습니다."
      />
    );
  }
  return (
    <ScrollView ref={scroll} testID="notices-screen" style={styles.screen} contentContainerStyle={styles.content}>
      {notices.map((notice) => (
        <NoticeItem
          key={notice.id}
          notice={notice}
          expanded={open === notice.id}
          onToggle={() => setOpen((current) => (current === notice.id ? null : notice.id))}
          onLayout={(y) => {
            if (notice.id === target) scroll.current?.scrollTo({ y, animated: false });
          }}
        />
      ))}
    </ScrollView>
  );
}

function NoticeItem({ notice, expanded, onToggle, onLayout }: {
  notice: Notice;
  expanded: boolean;
  onToggle: () => void;
  onLayout: (y: number) => void;
}) {
  return (
    <View testID={`notice-${notice.id}`} style={styles.item} onLayout={(event) => onLayout(event.nativeEvent.layout.y)}>
      <ActionPressable
        testID={`notice-${notice.id}-toggle`}
        accessibilityRole="button"
        accessibilityLabel={`${notice.title}, ${formatDate(notice.publishedOn)}`}
        accessibilityHint={expanded ? '공지 내용을 접습니다.' : '공지 내용을 펼칩니다.'}
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={onToggle}
        style={styles.header}
      >
        <View style={styles.headerText}>
          <Text style={styles.title}>{notice.title}</Text>
          <Text style={styles.date}>{formatDate(notice.publishedOn)}</Text>
        </View>
        <Text style={styles.chevron}>{expanded ? '▲' : '▼'}</Text>
      </ActionPressable>
      {expanded ? (
        <View testID={`notice-${notice.id}-body`} style={styles.body}>
          {notice.sections.map((section) => (
            <View key={section.heading} style={styles.section}>
              <Text accessibilityRole="header" style={styles.heading}>{section.heading}</Text>
              {section.paragraphs.map((paragraph) => (
                <Text key={paragraph} style={styles.paragraph}>{paragraph}</Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: getHeaderScreenContentStyle(Platform.OS),
  item: { borderWidth: 1, borderColor: semantic.border, borderRadius: 14, backgroundColor: semantic.surface, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16, paddingVertical: 14 },
  headerText: { flex: 1, minWidth: 0, gap: 4 },
  title: { fontSize: 17, lineHeight: 25, fontWeight: '700', color: semantic.text },
  date: { fontSize: 13, lineHeight: 19, color: semantic.secondary, fontVariant: ['tabular-nums'] },
  chevron: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  body: { paddingHorizontal: 16, paddingBottom: 18, borderTopWidth: 1, borderTopColor: semantic.border },
  section: { gap: 6, paddingTop: 14 },
  heading: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.text },
  paragraph: { fontSize: 15, lineHeight: 24, color: semantic.secondary },
});
