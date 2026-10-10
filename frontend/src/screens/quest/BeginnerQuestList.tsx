import React from 'react';
import { ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { QUEST_01_CONTENT } from '../../features/quest/questOneContent';
import { QUEST_01_ID, type BeginnerQuestId } from '../../features/quest/questProgress';
import { useBeginnerQuestProgress } from '../../features/quest/useBeginnerQuestProgress';
import { QuestProgressBar, QuestStatusBadge } from './BeginnerQuestParts';

/** Only quests whose content and completion rule are decided are listed. */
export default function BeginnerQuestList({ onOpen }: { onOpen: (questId: BeginnerQuestId) => void }) {
  const quest = useBeginnerQuestProgress();
  const refresh = usePullToRefresh([quest.refreshQuery]);
  const { display, progress } = quest;
  return (
    <ScrollView contentContainerStyle={styles.content} refreshControl={refresh.refreshControl} testID="beginner-quest-list">
      <Text style={styles.intro}>실제 거래 기능을 직접 사용해 보며 단계별로 배워요.</Text>
      <Text accessibilityRole="header" style={styles.category}>{QUEST_01_CONTENT.category}</Text>
      {quest.accountId === null ? (
        <Text style={styles.body} testID="quest-account-required">초보 계정을 선택하면 퀘스트를 진행할 수 있어요.</Text>
      ) : (
        <View style={styles.card} testID="quest-card-common-01">
          <View style={styles.cardHeader}>
            <Text style={styles.number}>{QUEST_01_CONTENT.number}</Text>
            <QuestStatusBadge display={display} status={progress?.status ?? null} testID="quest-card-status" />
          </View>
          <Text style={styles.title}>{QUEST_01_CONTENT.title}</Text>
          <Text style={styles.body}>{QUEST_01_CONTENT.summary}</Text>
          {progress ? (
            <View style={styles.progress}>
              <QuestProgressBar completed={progress.completedCount} total={progress.totalCount} />
              <Text style={styles.progressText} testID="quest-card-progress">{display.progressLabel}</Text>
            </View>
          ) : null}
          {display.kind === 'loading' ? (
            <Text style={styles.muted} testID="quest-card-loading">진행 상황을 확인하고 있어요.</Text>
          ) : null}
          {display.kind === 'error' ? (
            <View style={styles.progress}>
              <ErrorNotice error={quest.error} style={styles.error} testID="quest-card-error"
                message="진행 상황을 확인하지 못했어요. 다시 시도해 주세요." />
              <CTAButton label="다시 시도" variant="neutral" testID="quest-card-retry"
                onPress={() => { void quest.refreshQuery.refetch(); }} />
            </View>
          ) : null}
          {quest.isRefreshError ? (
            <Text style={styles.muted} testID="quest-card-stale">최신 진행 상황을 다시 확인하지 못했어요. 아래로 당겨 새로고침해 주세요.</Text>
          ) : null}
          <CTAButton label={display.actionLabel} testID="quest-card-open"
            variant={progress?.status === 'completed' ? 'secondary' : 'primary'}
            onPress={() => onOpen(QUEST_01_ID)} />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32, gap: 12 },
  intro: { fontSize: 16, lineHeight: 26, color: semantic.secondary },
  category: { fontSize: 20, lineHeight: 28, fontWeight: '700', color: semantic.text, marginTop: 4 },
  card: { borderWidth: 1, borderColor: semantic.border, borderRadius: 14, padding: 16, backgroundColor: semantic.surface, gap: 10 },
  cardHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  number: { fontSize: 14, lineHeight: 22, fontWeight: '700', color: semantic.secondary },
  title: { fontSize: 20, lineHeight: 28, fontWeight: '700', color: semantic.text },
  body: { fontSize: 16, lineHeight: 26, color: semantic.secondary },
  progress: { gap: 8 },
  progressText: { fontSize: 14, lineHeight: 22, fontWeight: '700', color: semantic.text },
  muted: { fontSize: 14, lineHeight: 22, color: semantic.secondary },
  error: { fontSize: 14, lineHeight: 22, color: semantic.error },
});
