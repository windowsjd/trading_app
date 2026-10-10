import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { describeQuestOne, type QuestOneProgress } from '../../features/quest/questProgress.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const Renderer = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const step = (completed: boolean) => ({ completed, completedAt: completed ? '2026-10-10T01:00:00.000Z' : null });
const progressOf = (count: 0 | 1 | 2): QuestOneProgress => ({
  status: count === 0 ? 'not_started' : count === 2 ? 'completed' : 'in_progress',
  completedCount: count,
  totalCount: 2,
  fx: step(count > 0),
  transfer: step(count > 1),
});

async function renderLearning(state: { progress: QuestOneProgress | null; isError?: boolean; accountId?: string | null }) {
  const refetches: unknown[] = [];
  const quest = {
    accountId: state.accountId === undefined ? 'beginner-1' : state.accountId,
    progress: state.progress,
    display: describeQuestOne({ progress: state.progress, isError: state.isError === true }),
    error: state.isError ? new Error('network') : null,
    isRefreshError: false,
    refreshQuery: { isFetching: false, enabled: true, refetch: () => { refetches.push('refetch'); return Promise.resolve(); } },
  };
  const Screen = load(resolve('src/screens/quest/BeginnerLearningScreen.tsx'), {
    'react-native': { View: 'View', Text: 'Text', ScrollView: 'ScrollView', SafeAreaView: 'SafeAreaView', RefreshControl: 'RefreshControl', ActivityIndicator: 'ActivityIndicator', Platform: { OS: 'ios' }, StyleSheet: { create: x => x } },
    '../../features/quest/useBeginnerQuestProgress': { useBeginnerQuestProgress: () => quest },
    '../../components/states/ErrorNotice': { default: 'ErrorNotice', __esModule: true },
  }).default;
  const navigated: unknown[][] = [];
  let renderer: any;
  await Renderer.act(async () => {
    renderer = Renderer.create(React.createElement(Screen, { navigation: { navigate: (...args: unknown[]) => navigated.push(args) } }));
  });
  const all = (id: string) => renderer.root.findAll(node => node.props.testID === id && typeof node.type === 'string');
  const text = () => renderer.root.findAllByType('Text').map(node => [node.props.children].flat(Infinity).join('')).join(' ');
  return { renderer, all, text, navigated, refetches };
}

it('lists only the decided QUEST 01 with server-proven progress and opens its detail', async t => {
  for (const [count, status, cta] of [[0, '미시작', '퀘스트 시작하기'], [1, '진행 중', '이어하기'], [2, '완료', '다시 살펴보기']] as const) {
    const h = await renderLearning({ progress: progressOf(count) });
    t.after(async () => { await Renderer.act(async () => h.renderer.unmount()); });
    const copy = h.text();
    assert.match(copy, /공통 기초 — 암호화폐 현물/);
    assert.match(copy, /QUEST 01/);
    assert.match(copy, /거래 자금 준비하기/);
    assert.match(copy, /환전과 이체를 배우고 암호화폐 현물 거래를 준비합니다\./);
    assert.match(copy, new RegExp(`진행 상태 ${status}|${status}`));
    assert.equal(h.all('quest-card-progress')[0]?.props.children, `실습 ${count}/2 완료`);
    assert.equal(h.all('quest-card-open').length, 1, 'one card only, no invented quests');
    assert.equal(h.all('quest-card-open')[0].props.accessibilityLabel, cta);
    // No fake unlocks, rewards, levels or percentages.
    assert.doesNotMatch(copy, /\d+%|레벨|해금|잠금|경험치|보상/);
    await Renderer.act(async () => h.all('quest-card-open')[0].props.onPress());
    assert.deepEqual(h.navigated, [['QuestDetail', { questId: 'common-01-trading-funds' }]]);
  }
});

it('shows loading and error as unknown progress, never as complete', async t => {
  const loading = await renderLearning({ progress: null });
  t.after(async () => { await Renderer.act(async () => loading.renderer.unmount()); });
  assert.equal(loading.all('quest-card-loading').length, 1);
  assert.equal(loading.all('quest-card-progress').length, 0);
  assert.doesNotMatch(loading.text(), /완료|미시작|진행 중/);
  assert.match(loading.text(), /확인 중/);

  const failed = await renderLearning({ progress: null, isError: true });
  t.after(async () => { await Renderer.act(async () => failed.renderer.unmount()); });
  assert.match(failed.text(), /확인 불가/);
  assert.doesNotMatch(failed.text(), /완료|미시작/);
  assert.equal(failed.all('quest-card-error').length, 1);
  await Renderer.act(async () => failed.all('quest-card-retry')[0].props.onPress());
  assert.deepEqual(failed.refetches, ['refetch']);
  // The teaching content stays reachable while progress is unknown.
  assert.equal(failed.all('quest-card-open')[0].props.accessibilityLabel, '퀘스트 열기');

  const noAccount = await renderLearning({ progress: null, accountId: null });
  t.after(async () => { await Renderer.act(async () => noAccount.renderer.unmount()); });
  assert.equal(noAccount.all('quest-account-required').length, 1);
  assert.equal(noAccount.all('quest-card-open').length, 0);
});

it('keeps the segment switch to the actual existing guide content and navigation', async t => {
  const h = await renderLearning({ progress: progressOf(0) });
  t.after(async () => { await Renderer.act(async () => h.renderer.unmount()); });
  const find = (id: string) => h.renderer.root.findAll(node => node.props.testID === id)[0];
  assert.equal(find('beginner-quest-list') !== undefined, true);
  assert.equal(find('beginner-segment-quests').props.accessibilityState.selected, true);
  await Renderer.act(async () => find('beginner-segment-guide').props.onPress());
  assert.equal(find('beginner-quest-list') === undefined, true);
  assert.equal(find('beginner-segment-guide').props.accessibilityState.selected, true);
  const guideCard = h.renderer.root.findAll(node => node.props.accessibilityHint === '시장기초 가이드를 엽니다.')[0];
  assert.equal(guideCard !== undefined, true);
  await Renderer.act(async () => guideCard.props.onPress());
  assert.deepEqual(h.navigated, [['MarketBasics']]);
  await Renderer.act(async () => find('beginner-segment-quests').props.onPress());
  assert.equal(find('beginner-quest-list') !== undefined, true);
  assert.equal(h.renderer.root.findAll(node => node.props.accessibilityHint === '시장기초 가이드를 엽니다.').length, 0);
});
