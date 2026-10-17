import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MyStackParamList } from '../../app/navigation/types';
import { Platform, ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import ActionPressable from '../../components/common/ActionPressable';
import EmptyState from '../../components/states/EmptyState';
import { mergeNotices, notices, type Notice } from '../../features/notice/notices';
import { useImportantNotices } from '../../features/notice/useImportantNotices';

const formatDate = (day: string) => day.split('-').join('.');

/**
 * 전체 > 공지사항. Each notice opens in place. A link from elsewhere (the
 * order book guide, an important-notice push) passes `noticeId`: that notice
 * is opened and scrolled to, so the reader lands on its content inside this
 * list. Important notices published by an operator are listed with the app's
 * own; if they cannot be read, the app's notices still show.
 */
export default function NoticesScreen({ route }: NativeStackScreenProps<MyStackParamList, 'Notices'>) {
  const target = route.params?.noticeId;
  const pushAt = route.params?.pushAt;
  const [open, setOpen] = useState<string | null>(target ?? null);
  const scroll = useRef<ScrollView>(null);
  const important = useImportantNotices();
  const { retry } = important;
  const list = useMemo(() => mergeNotices(notices, important.notices), [important.notices]);
  const found = !!target && list.some((notice) => notice.id === target);
  // A notice published after the list was read: read it again once before
  // saying it cannot be found.
  const [refetchedFor, setRefetchedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!target || found || important.state !== 'ready' || refetchedFor === target) return;
    setRefetchedFor(target);
    retry();
  }, [target, found, important.state, refetchedFor, retry]);
  const targetMissing = !!target && !found && important.state !== 'loading' && refetchedFor === target;
  // `pushAt` changes with every tap, so the same notice opens again.
  useEffect(() => {
    if (target) setOpen(target);
  }, [target, pushAt]);

  if (!list.length) {
    return (
      <EmptyState
        title="등록된 공지사항이 없습니다."
        message="새로운 공지사항이 등록되면 이곳에서 확인할 수 있습니다."
      />
    );
  }
  return (
    <ScrollView ref={scroll} testID="notices-screen" style={styles.screen} contentContainerStyle={styles.content}>
      {targetMissing ? (
        <Text testID="notices-target-missing" accessibilityRole="alert" style={styles.notice}>
          해당 공지를 찾을 수 없습니다. 내려간 공지일 수 있어요.
        </Text>
      ) : null}
      {important.state === 'error' ? (
        <ActionPressable testID="notices-important-retry" accessibilityRole="button" onPress={important.retry}
          accessibilityLabel="중요 공지를 불러오지 못했습니다. 다시 불러오기" style={styles.retry}>
          <Text style={styles.notice}>중요 공지를 불러오지 못했습니다. 눌러서 다시 불러오기</Text>
        </ActionPressable>
      ) : null}
      {list.map((notice) => (
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
        accessibilityLabel={`${notice.important ? '중요 공지, ' : ''}${notice.title}, ${formatDate(notice.publishedOn)}`}
        accessibilityHint={expanded ? '공지 내용을 접습니다.' : '공지 내용을 펼칩니다.'}
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={onToggle}
        style={styles.header}
      >
        <View style={styles.headerText}>
          <Text style={styles.title}>{notice.title}</Text>
          <Text style={styles.date}>
            {notice.important ? <Text style={styles.important}>중요 · </Text> : null}
            {formatDate(notice.publishedOn)}
          </Text>
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
  important: { fontWeight: '700', color: semantic.text },
  notice: { fontSize: 14, lineHeight: 21, color: semantic.secondary },
  retry: { minHeight: 44, justifyContent: 'center' },
});
