import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';
import type { BeginnerQuestKey, BeginnerQuests } from '../../features/quest/questProgress.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const Renderer = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const FX_AT = '2026-10-10T01:00:00.000Z';
const TRANSFER_AT = '2026-10-10T01:05:00.000Z';
const progressOf = (count: 0 | 1 | 2): BeginnerQuests => ({
  exchange: { status: count > 0 ? 'completed' : 'not_started', completed: count > 0, completedAt: count > 0 ? FX_AT : null },
  transfer: { status: count > 1 ? 'completed' : 'not_started', completed: count > 1, completedAt: count > 1 ? TRANSFER_AT : null },
});

type Guide = {
  active: { quest: BeginnerQuestKey; phase: string; replay: boolean } | null;
  returnCount: number;
  justCompleted: BeginnerQuestKey | null;
  calls: unknown[][];
};

async function renderLearning(state: { progress: BeginnerQuests | null; isError?: boolean; accountId?: string | null; guide?: Partial<Guide> | null }) {
  const refetches: unknown[] = [];
  const quest = {
    accountId: state.accountId === undefined ? 'beginner-1' : state.accountId,
    progress: state.progress,
    isError: state.isError === true,
    error: state.isError ? new Error('network') : null,
    isRefreshError: false,
    refreshQuery: { isFetching: false, enabled: true, refetch: () => { refetches.push('refetch'); return Promise.resolve(); } },
  };
  const calls: unknown[][] = [];
  const guide = state.guide === null ? null : {
    active: null, returnCount: 0, justCompleted: null, ...state.guide,
    start: (key: BeginnerQuestKey, progress: BeginnerQuests) => calls.push(['start', key, progress === state.progress]),
    resume: () => calls.push(['resume']),
    exit: () => calls.push(['exit']),
  };
  const Screen = load(resolve('src/screens/quest/BeginnerLearningScreen.tsx'), {
    'react-native': { View: 'View', Text: 'Text', ScrollView: 'ScrollView', SafeAreaView: 'SafeAreaView', RefreshControl: 'RefreshControl', ActivityIndicator: 'ActivityIndicator', Platform: { OS: 'ios' }, StyleSheet: { create: x => x } },
    'react-native-svg': { default: 'Svg', Path: 'Path', Circle: 'Circle', __esModule: true },
    '../../features/quest/useBeginnerQuestProgress': { useBeginnerQuestProgress: () => quest },
    '../../features/quest/QuestGuideProvider': { useQuestGuide: () => guide },
    '../../components/states/ErrorNotice': { default: 'ErrorNotice', __esModule: true },
  }).default;
  const navigated: unknown[][] = [];
  let renderer: any;
  await Renderer.act(async () => {
    renderer = Renderer.create(React.createElement(Screen, { navigation: { navigate: (...args: unknown[]) => navigated.push(args) } }));
  });
  const all = (id: string) => renderer.root.findAll(node => node.props.testID === id && typeof node.type === 'string');
  const has = (id: string) => all(id).length > 0;
  const textOf = (node: any) => node.findAllByType('Text').map(child => [child.props.children].flat(Infinity).join('')).join(' ');
  const text = () => textOf(renderer.root);
  const cardText = (key: BeginnerQuestKey) => textOf(all(`quest-card-${key}`)[0]);
  const status = (key: BeginnerQuestKey) => textOf(all(`quest-card-${key}-status`)[0]);
  const start = (key: BeginnerQuestKey) => all(`quest-card-${key}-start`)[0];
  return { renderer, all, has, text, cardText, status, start, navigated, refetches, calls,
    update: async (next: Partial<Guide>) => {
      Object.assign(guide ?? {}, next);
      await Renderer.act(async () => renderer.update(React.createElement(Screen, { navigation: { navigate: (...args: unknown[]) => navigated.push(args) } })));
    } };
}

it('shows QUEST 01 환전하기 and QUEST 02 이체하기 as separate cards with their own state', async t => {
  for (const [count, exchange, transfer, transferEnabled] of [
    [0, '미시작', '대기', false], [1, '완료', '미시작', true], [2, '완료', '완료', true],
  ] as const) {
    const h = await renderLearning({ progress: progressOf(count) });
    t.after(async () => { await Renderer.act(async () => h.renderer.unmount()); });
    const copy = h.text();
    assert.match(copy, /공통 기초 — 암호화폐 현물/);
    assert.equal(h.all('quest-summary-progress')[0].props.children.join(''), `퀘스트 ${count}/2 완료`);
    assert.match(h.cardText('exchange'), /QUEST 01/);
    assert.match(h.cardText('exchange'), /환전하기/);
    assert.match(h.cardText('transfer'), /QUEST 02/);
    assert.match(h.cardText('transfer'), /이체하기/);
    assert.equal(h.status('exchange'), exchange);
    assert.equal(h.status('transfer'), transfer);
    assert.equal(h.start('exchange').props.accessibilityState.disabled, false);
    assert.equal(h.start('transfer').props.accessibilityState.disabled, !transferEnabled);
    assert.equal(h.has('quest-card-transfer-waiting'), count === 0);
    assert.equal(h.has('quest-card-exchange-completed'), count > 0);
    assert.equal(h.has('quest-card-transfer-completed'), count > 1);
    // The removed intro sentence, and no invented rewards, levels or unlocks.
    assert.doesNotMatch(copy, /실제 거래 기능을 직접 사용해 보며 단계별로 배워요/);
    assert.doesNotMatch(copy, /\d+%|레벨|해금|잠금|경험치|보상/);
  }
});

it('starts the guide directly from the card, never a text detail screen', async t => {
  const h = await renderLearning({ progress: progressOf(1) });
  t.after(async () => { await Renderer.act(async () => h.renderer.unmount()); });
  assert.equal(h.start('transfer').props.accessibilityLabel, '퀘스트 시작하기');
  await Renderer.act(async () => h.start('transfer').props.onPress());
  assert.equal(h.start('exchange').props.accessibilityLabel, '다시 둘러보기');
  await Renderer.act(async () => h.start('exchange').props.onPress());
  assert.deepEqual(h.calls, [['start', 'transfer', true], ['start', 'exchange', true]]);
  assert.deepEqual(h.navigated, [], 'no QuestDetail route');
});

it('shows a running guide as in progress with resume and exit', async t => {
  const h = await renderLearning({ progress: progressOf(0), guide: { active: { quest: 'exchange', phase: 'guiding', replay: false } } });
  t.after(async () => { await Renderer.act(async () => h.renderer.unmount()); });
  assert.equal(h.status('exchange'), '진행 중');
  assert.equal(h.start('exchange').props.accessibilityLabel, '이어하기');
  await Renderer.act(async () => h.start('exchange').props.onPress());
  await Renderer.act(async () => h.all('quest-card-exchange-exit')[0].props.onPress());
  assert.deepEqual(h.calls, [['resume'], ['exit']]);
  assert.equal(h.has('quest-card-transfer-exit'), false);
});

it('shows loading and error as unknown progress, never as complete or startable', async t => {
  const loading = await renderLearning({ progress: null });
  t.after(async () => { await Renderer.act(async () => loading.renderer.unmount()); });
  assert.equal(loading.has('quest-card-loading'), true);
  assert.equal(loading.has('quest-summary-progress'), false);
  assert.equal(loading.status('exchange'), '확인 중');
  assert.equal(loading.status('transfer'), '확인 중');
  assert.equal(loading.start('exchange').props.accessibilityState.disabled, true);
  // Card copy explains when a quest completes; no status claims it.
  for (const key of ['exchange', 'transfer'] as const) {
    assert.doesNotMatch(loading.status(key), /완료|미시작|진행 중|대기/);
    assert.equal(loading.has(`quest-card-${key}-completed`), false);
  }

  const failed = await renderLearning({ progress: null, isError: true });
  t.after(async () => { await Renderer.act(async () => failed.renderer.unmount()); });
  assert.equal(failed.status('exchange'), '확인 불가');
  assert.equal(failed.status('transfer'), '확인 불가');
  assert.equal(failed.has('quest-card-exchange-completed'), false);
  assert.equal(failed.has('quest-card-error'), true);
  assert.equal(failed.start('transfer').props.accessibilityState.disabled, true);
  await Renderer.act(async () => failed.all('quest-card-retry')[0].props.onPress());
  assert.deepEqual(failed.refetches, ['refetch']);
  assert.deepEqual(failed.calls, []);

  const noAccount = await renderLearning({ progress: null, accountId: null });
  t.after(async () => { await Renderer.act(async () => noAccount.renderer.unmount()); });
  assert.equal(noAccount.has('quest-account-required'), true);
  assert.equal(noAccount.has('quest-card-exchange'), false);

  const noGuide = await renderLearning({ progress: progressOf(0), guide: null });
  t.after(async () => { await Renderer.act(async () => noGuide.renderer.unmount()); });
  assert.equal(noGuide.start('exchange').props.accessibilityState.disabled, true, 'no guide, no practice start');
});

it('keeps the segment switch to the existing guide and returns to quests after a completion', async t => {
  const h = await renderLearning({ progress: progressOf(0) });
  t.after(async () => { await Renderer.act(async () => h.renderer.unmount()); });
  const find = (id: string) => h.renderer.root.findAll(node => node.props.testID === id)[0];
  assert.equal(find('beginner-quest-list') !== undefined, true);
  assert.equal(find('beginner-segment-quests').props.accessibilityState.selected, true);
  await Renderer.act(async () => find('beginner-segment-guide').props.onPress());
  assert.equal(find('beginner-quest-list') === undefined, true);
  const guideCard = h.renderer.root.findAll(node => node.props.accessibilityHint === '시장기초 가이드를 엽니다.')[0];
  assert.equal(guideCard !== undefined, true);
  await Renderer.act(async () => guideCard.props.onPress());
  assert.deepEqual(h.navigated, [['MarketBasics']]);
  await h.update({ returnCount: 1, justCompleted: 'exchange' });
  assert.equal(find('beginner-quest-list') !== undefined, true, 'a finished practice lands on the quest cards');
  assert.equal(find('beginner-segment-quests').props.accessibilityState.selected, true);
});
