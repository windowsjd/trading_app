import React from 'react';
import { ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import type { QuestDetailScreenProps } from '../../app/navigation/types';
import { QUEST_01_CONTENT } from '../../features/quest/questOneContent';
import type { QuestPracticeStep } from '../../features/quest/questProgress';
import { useBeginnerQuestProgress } from '../../features/quest/useBeginnerQuestProgress';
import { formatKstDateTime } from '../../utils/format';
import { QuestProgressBar, QuestStatusBadge } from './BeginnerQuestParts';

const content = QUEST_01_CONTENT;

/** Practice reuses the existing Wallet screens; nothing is executed here. */
export default function BeginnerQuestDetailScreen(_props: QuestDetailScreenProps) {
  const rootNavigation = useRootNavigation();
  const quest = useBeginnerQuestProgress();
  const refresh = usePullToRefresh([quest.refreshQuery]);
  const { display, progress } = quest;
  const openWallet = (screen: 'WalletFx' | 'WalletTransfer') =>
    rootNavigation.navigate('MainTabs', { screen: 'WalletTab', params: { screen, initial: false } });
  const stepState = (step: QuestPracticeStep | undefined) =>
    !step
      ? display.kind === 'error' ? '확인 불가' : '확인 중'
      : step.completed ? `완료 · ${formatKstDateTime(step.completedAt)}` : '미완료';
  const fxDone = progress?.fx.completed === true;

  return (
    <SafeAreaView edges={['left', 'right']} style={styles.screen} testID="quest-detail-screen">
      <ScrollView contentContainerStyle={styles.content} refreshControl={refresh.refreshControl}>
        <View style={styles.header}>
          <Text style={styles.number}>{content.number} · {content.category}</Text>
          <Text accessibilityRole="header" style={styles.title}>{content.title}</Text>
          <Text style={styles.body}>{content.goal}</Text>
        </View>

        <View style={styles.card} testID="quest-detail-progress">
          <View style={styles.row}>
            <Text style={styles.cardTitle}>실습 진행 상황</Text>
            <QuestStatusBadge display={display} status={progress?.status ?? null} testID="quest-detail-status" />
          </View>
          {progress ? (
            <>
              <QuestProgressBar completed={progress.completedCount} total={progress.totalCount} />
              <Text style={styles.strong} testID="quest-detail-progress-label">{display.progressLabel}</Text>
            </>
          ) : null}
          {display.kind === 'loading' ? <Text style={styles.small}>진행 상황을 확인하고 있어요.</Text> : null}
          {display.kind === 'error' ? (
            <>
              <ErrorNotice error={quest.error} style={styles.error} testID="quest-detail-error"
                message="진행 상황을 확인하지 못했어요. 다시 시도해 주세요." />
              <CTAButton label="다시 시도" variant="neutral" testID="quest-detail-retry"
                onPress={() => { void quest.refreshQuery.refetch(); }} />
            </>
          ) : null}
          {quest.isRefreshError ? (
            <Text style={styles.small} testID="quest-detail-stale">최신 진행 상황을 다시 확인하지 못했어요. 아래로 당겨 새로고침해 주세요.</Text>
          ) : null}
          {progress?.status === 'completed' ? (
            <Text style={styles.done} testID="quest-detail-completed">{content.completed}</Text>
          ) : (
            <Text style={styles.small}>{content.returnHint}</Text>
          )}
        </View>

        <Section index={1} kind="학습" title={content.wallets.title}>
          <Text style={styles.body}>{content.wallets.intro}</Text>
          {content.wallets.items.map(wallet => (
            <View key={wallet.name} style={styles.item}>
              <Text style={styles.strong}>{wallet.name}</Text>
              {wallet.lines.map(line => <Text key={line} style={styles.body}>· {line}</Text>)}
            </View>
          ))}
          <Text style={styles.point}>{content.wallets.point}</Text>
        </Section>

        <Section index={2} kind="학습" title={content.fxConcepts.title}>
          {content.fxConcepts.terms.map(term => (
            <View key={term.term} style={styles.item}>
              <Text style={styles.strong}>{term.term} ({term.english})</Text>
              <Text style={styles.body}>{term.meaning}</Text>
            </View>
          ))}
          <Text style={styles.strong}>{content.fxConcepts.flowTitle}</Text>
          {content.fxConcepts.flow.map((line, index) => (
            <Text key={line} style={styles.body}>{index + 1}. {line}</Text>
          ))}
          {content.fxConcepts.notes.map(note => <Text key={note} style={styles.point}>{note}</Text>)}
        </Section>

        <Section index={3} kind="실습" title={content.fxPractice.title} testID="quest-step-fx"
          state={stepState(progress?.fx)} done={fxDone}>
          <Text style={styles.route}>{content.fxPractice.route}</Text>
          <Text style={styles.body}>{content.fxPractice.body}</Text>
          <Text style={styles.small}>{content.fxPractice.condition}</Text>
          <CTAButton label={content.fxPractice.action} testID="quest-open-fx"
            variant={fxDone ? 'secondary' : 'primary'} onPress={() => openWallet('WalletFx')} />
        </Section>

        <Section index={4} kind="실습" title={content.transferPractice.title} testID="quest-step-transfer"
          state={stepState(progress?.transfer)} done={progress?.transfer.completed === true}>
          <Text style={styles.route}>{content.transferPractice.route}</Text>
          {content.transferPractice.lines.map(line => <Text key={line} style={styles.body}>· {line}</Text>)}
          <Text style={styles.small}>{content.transferPractice.condition}</Text>
          {fxDone ? null : <Text style={styles.small} testID="quest-transfer-wait">{content.transferPractice.waitForFx}</Text>}
          <CTAButton label={content.transferPractice.action} testID="quest-open-transfer"
            state={fxDone ? 'enabled' : 'disabled'}
            variant={progress?.transfer.completed ? 'secondary' : 'primary'}
            onPress={() => openWallet('WalletTransfer')} />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ index, kind, title, state, done = false, testID, children }: {
  index: number;
  kind: '학습' | '실습';
  title: string;
  state?: string;
  done?: boolean;
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.row}>
        <Text style={styles.step}>{index}단계 · {kind}</Text>
        {state ? <Text style={[styles.state, done && styles.stateDone]} testID={testID ? `${testID}-state` : undefined}>{state}</Text> : null}
      </View>
      <Text accessibilityRole="header" style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: { padding: 16, paddingBottom: 32, gap: 12 },
  header: { gap: 6 },
  number: { fontSize: 14, lineHeight: 22, fontWeight: '700', color: semantic.secondary },
  title: { fontSize: 22, lineHeight: 32, fontWeight: '700', color: semantic.text },
  card: { borderWidth: 1, borderColor: semantic.border, borderRadius: 14, padding: 16, backgroundColor: semantic.surface, gap: 10 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { fontSize: 18, lineHeight: 27, fontWeight: '700', color: semantic.text },
  step: { fontSize: 14, lineHeight: 22, fontWeight: '700', color: semantic.info },
  state: { fontSize: 14, lineHeight: 22, fontWeight: '700', color: semantic.secondary },
  stateDone: { color: semantic.success },
  item: { gap: 2 },
  body: { fontSize: 16, lineHeight: 26, color: semantic.secondary },
  strong: { fontSize: 16, lineHeight: 26, fontWeight: '700', color: semantic.text },
  small: { fontSize: 14, lineHeight: 22, color: semantic.secondary },
  point: { fontSize: 14, lineHeight: 22, color: semantic.text, backgroundColor: semantic.infoSurface, borderRadius: 10, padding: 12 },
  route: { fontSize: 15, lineHeight: 23, fontWeight: '700', color: semantic.info },
  done: { fontSize: 15, lineHeight: 23, fontWeight: '700', color: semantic.success },
  error: { fontSize: 14, lineHeight: 22, color: semantic.error },
});
