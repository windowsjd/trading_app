import React from 'react';
import { ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import CTAButton from '../../components/common/CTAButton';
import ActionPressable from '../../components/common/ActionPressable';
import ErrorNotice from '../../components/states/ErrorNotice';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { QUEST_CARDS, QUEST_CATEGORY, QUEST_GUIDE_COPY } from '../../features/quest/questContent';
import {
  BEGINNER_QUEST_KEYS,
  completedQuestCount,
  describeQuestCard,
  type BeginnerQuestKey,
  type BeginnerQuests,
} from '../../features/quest/questProgress';
import { useBeginnerQuestProgress } from '../../features/quest/useBeginnerQuestProgress';
import { useQuestGuide } from '../../features/quest/QuestGuideProvider';
import { formatKstDateTime } from '../../utils/format';
import { QuestMark, QuestProgressBar, QuestStatusBadge } from './BeginnerQuestParts';

/**
 * QUEST 01 환전하기 and QUEST 02 이체하기, each with its own server-proven
 * state. Starting opens the real Wallet screens under the spotlight guide;
 * nothing is executed or completed from this list.
 */
export default function BeginnerQuestList() {
  const quest = useBeginnerQuestProgress();
  const guide = useQuestGuide();
  const refresh = usePullToRefresh([quest.refreshQuery]);
  const { progress } = quest;
  return (
    <ScrollView contentContainerStyle={styles.content} refreshControl={refresh.refreshControl} testID="beginner-quest-list">
      <View style={styles.summary}>
        <Text accessibilityRole="header" style={styles.category}>{QUEST_CATEGORY}</Text>
        {progress ? (
          <View style={styles.summaryProgress}>
            <QuestProgressBar completed={completedQuestCount(progress)} total={BEGINNER_QUEST_KEYS.length} />
            <Text style={styles.progressText} testID="quest-summary-progress">
              퀘스트 {completedQuestCount(progress)}/{BEGINNER_QUEST_KEYS.length} 완료
            </Text>
          </View>
        ) : null}
      </View>
      {quest.accountId === null ? (
        <Text style={styles.body} testID="quest-account-required">초보 계정을 선택하면 퀘스트를 진행할 수 있어요.</Text>
      ) : (
        <>
          {!progress && !quest.isError ? (
            <Text style={styles.muted} testID="quest-card-loading">진행 상황을 확인하고 있어요.</Text>
          ) : null}
          {!progress && quest.isError ? (
            <View style={styles.notice}>
              <ErrorNotice error={quest.error} style={styles.error} testID="quest-card-error"
                message="진행 상황을 확인하지 못했어요. 다시 시도해 주세요." />
              <CTAButton label="다시 시도" variant="neutral" testID="quest-card-retry"
                onPress={() => { void quest.refreshQuery.refetch(); }} />
            </View>
          ) : null}
          {quest.isRefreshError ? (
            <Text style={styles.muted} testID="quest-card-stale">최신 진행 상황을 다시 확인하지 못했어요. 아래로 당겨 새로고침해 주세요.</Text>
          ) : null}
          {BEGINNER_QUEST_KEYS.map(key => (
            <QuestCard key={key} questKey={key} progress={progress} isError={quest.isError}
              active={guide?.active?.quest === key} highlighted={guide?.justCompleted === key}
              onStart={guide && progress ? () => guide.start(key, progress) : null}
              onResume={guide ? guide.resume : null}
              onExit={guide ? guide.exit : null} />
          ))}
        </>
      )}
    </ScrollView>
  );
}

function QuestCard({ questKey, progress, isError, active, highlighted, onStart, onResume, onExit }: {
  questKey: BeginnerQuestKey;
  progress: BeginnerQuests | null;
  isError: boolean;
  active: boolean;
  highlighted: boolean;
  onStart: (() => void) | null;
  onResume: (() => void) | null;
  onExit: (() => void) | null;
}) {
  const content = QUEST_CARDS[questKey];
  const display = describeQuestCard(questKey, { progress, isError, active });
  const done = progress?.[questKey].completed === true;
  const completedAt = progress?.[questKey].completedAt ?? null;
  const press = display.state === 'active' ? onResume : onStart;
  return (
    <View testID={`quest-card-${questKey}`}
      style={[styles.card, display.state === 'active' && styles.cardActive, highlighted && done && styles.cardHighlighted]}>
      <View style={styles.cardHeader}>
        <QuestMark done={done} />
        <View style={styles.heading}>
          {/* The badge wraps under the number before the title ever wraps. */}
          <View style={styles.numberRow}>
            <Text style={styles.number}>{content.number}</Text>
            <QuestStatusBadge state={display.state} label={display.statusLabel} testID={`quest-card-${questKey}-status`} />
          </View>
          <Text accessibilityRole="header" style={styles.title}>{content.title}</Text>
        </View>
      </View>
      <Text style={styles.body}>{content.summary}</Text>
      <View style={styles.topics} accessibilityLabel={`배우는 내용: ${content.topics.join(', ')}`}>
        {content.topics.map(topic => (
          <View key={topic} style={styles.topic}><Text style={styles.topicText}>{topic}</Text></View>
        ))}
      </View>
      {done && completedAt ? (
        <Text style={styles.done} testID={`quest-card-${questKey}-completed`}>완료 · {formatKstDateTime(completedAt)}</Text>
      ) : (
        <Text style={styles.muted}>{content.condition}</Text>
      )}
      {display.state === 'waiting' && questKey === 'transfer' ? (
        <Text style={styles.muted} testID="quest-card-transfer-waiting">{QUEST_CARDS.transfer.waiting}</Text>
      ) : null}
      <CTAButton
        label={display.actionLabel ?? '퀘스트 시작하기'}
        testID={`quest-card-${questKey}-start`}
        variant={display.state === 'completed' ? 'secondary' : 'primary'}
        state={display.canStart && press ? 'enabled' : 'disabled'}
        onPress={press ?? undefined}
      />
      {display.state === 'active' && onExit ? (
        <ActionPressable testID={`quest-card-${questKey}-exit`} accessibilityRole="button"
          accessibilityLabel={QUEST_GUIDE_COPY.actions.exit} onPress={onExit} style={styles.exit}>
          <Text style={styles.exitText}>{QUEST_GUIDE_COPY.actions.exit}</Text>
        </ActionPressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 32, gap: 12 },
  summary: { gap: 10 },
  summaryProgress: { gap: 8 },
  category: { fontSize: 20, lineHeight: 28, fontWeight: '700', color: semantic.text },
  progressText: { fontSize: 14, lineHeight: 22, fontWeight: '700', color: semantic.text },
  notice: { gap: 8 },
  card: { borderWidth: 1, borderColor: semantic.border, borderRadius: 16, padding: 16, backgroundColor: semantic.surface, gap: 10 },
  cardActive: { borderColor: semantic.info },
  cardHighlighted: { borderColor: semantic.success, borderWidth: 2, padding: 15 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  heading: { flex: 1, minWidth: 0, gap: 2 },
  numberRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 4 },
  number: { fontSize: 13, lineHeight: 20, fontWeight: '700', color: semantic.secondary },
  title: { fontSize: 20, lineHeight: 28, fontWeight: '700', color: semantic.text },
  body: { fontSize: 16, lineHeight: 25, color: semantic.secondary },
  topics: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  topic: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: semantic.raised, maxWidth: '100%' },
  topicText: { fontSize: 13, lineHeight: 20, color: semantic.secondary, flexShrink: 1 },
  done: { fontSize: 14, lineHeight: 22, fontWeight: '700', color: semantic.success },
  muted: { fontSize: 14, lineHeight: 22, color: semantic.secondary },
  error: { fontSize: 14, lineHeight: 22, color: semantic.error },
  exit: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  exitText: { fontSize: 14, lineHeight: 21, fontWeight: '600', color: semantic.secondary },
});
