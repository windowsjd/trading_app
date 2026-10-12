import React from 'react';
import { ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { QUEST_CARDS, QUEST_CATEGORY } from '../../features/quest/questContent';
import {
  BEGINNER_QUEST_KEYS,
  FOUNDATION_KEYS,
  completedQuestCount,
  describeQuestCard,
  type BeginnerQuestKey,
  type BeginnerQuests,
} from '../../features/quest/questProgress';
import { useBeginnerQuestProgress } from '../../features/quest/useBeginnerQuestProgress';
import { useQuestGuide } from '../../features/quest/QuestGuideProvider';
import { QuestMark, QuestProgressBar, QuestReplayIcon, QuestStatusBadge } from './BeginnerQuestParts';

/**
 * QUEST 01 환전하기 and QUEST 02 이체하기, each with its own server-proven
 * state. Starting opens the real Wallet screens under the spotlight guide;
 * nothing is executed or completed from this list. Coming back here has
 * already ended any guide, so a card only ever starts a new one.
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
          {BEGINNER_QUEST_KEYS.map((key, index) => (
            <React.Fragment key={key}>
            {index === 6 ? <Text accessibilityRole="header" style={styles.category}>시장별 심화 — 자유 진행</Text> : null}
            <QuestCard key={key} questKey={key} progress={progress} isError={quest.isError}
              highlighted={guide?.justCompleted === key} starting={guide?.starting === key}
              onStart={guide && progress ? () => guide.start(key) : null} />
            </React.Fragment>
          ))}
        </>
      )}
    </ScrollView>
  );
}

function QuestCard({ questKey, progress, isError, highlighted, starting, onStart }: {
  questKey: BeginnerQuestKey;
  progress: BeginnerQuests | null;
  isError: boolean;
  highlighted: boolean;
  /** Its latest server progress is being read before the guide opens. */
  starting: boolean;
  onStart: (() => void) | null;
}) {
  const content = QUEST_CARDS[questKey];
  const display = describeQuestCard(questKey, { progress, isError });
  const done = progress?.[questKey].completed === true;
  return (
    <View testID={`quest-card-${questKey}`}
      style={[styles.card, highlighted && done && styles.cardHighlighted]}>
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
      {!done ? (
        <Text style={styles.muted}>{content.condition}</Text>
      ) : null}
      {display.state === 'waiting' ? (
        <Text style={styles.muted} testID={`quest-card-${questKey}-waiting`}>
          {questKey === 'transfer' ? QUEST_CARDS.transfer.waiting : FOUNDATION_KEYS.includes(questKey)
            ? '앞선 공통 기초 퀘스트를 완료하면 시작할 수 있어요.' : 'QUEST 06을 완료하면 네 심화 퀘스트를 원하는 순서로 진행할 수 있어요.'}
        </Text>
      ) : null}
      {progress && (questKey === 'protection' && !progress.operations.conditionalOrdersEnabled
        || questKey === 'limitBuy' && !progress.operations.limitOrdersEnabled
        || (questKey === 'futuresLong' || questKey === 'futuresShort') && progress.operations.futuresTradingMode !== 'ENABLED') ? (
        <Text style={styles.muted} testID={`quest-card-${questKey}-operations`}>현재 서버 운영 정책으로 이 실습의 신규 거래가 제공되지 않습니다.</Text>
      ) : null}
      <CTAButton
        label={display.actionLabel ?? '퀘스트 시작하기'}
        leadingIcon={display.state === 'completed' ? <QuestReplayIcon /> : undefined}
        testID={`quest-card-${questKey}-start`}
        variant={display.state === 'completed' ? 'secondary' : 'primary'}
        state={starting ? 'loading' : display.canStart && onStart ? 'enabled' : 'disabled'}
        onPress={onStart ?? undefined}
      />
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
  cardHighlighted: { borderColor: semantic.success, borderWidth: 2, padding: 15 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  heading: { flex: 1, minWidth: 0, gap: 2 },
  numberRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 4 },
  number: { fontSize: 13, lineHeight: 20, fontWeight: '700', color: semantic.secondary },
  title: { fontSize: 20, lineHeight: 28, fontWeight: '700', color: semantic.text },
  body: { fontSize: 16, lineHeight: 25, color: semantic.secondary },
  muted: { fontSize: 14, lineHeight: 22, color: semantic.secondary },
  error: { fontSize: 14, lineHeight: 22, color: semantic.error },
});
