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

const FX_AT = '2026-10-10T01:00:00.000Z';
const TRANSFER_AT = '2026-10-10T01:05:00.000Z';
const progressOf = (count: 0 | 1 | 2): QuestOneProgress => ({
  status: count === 0 ? 'not_started' : count === 2 ? 'completed' : 'in_progress',
  completedCount: count,
  totalCount: 2,
  fx: { completed: count > 0, completedAt: count > 0 ? FX_AT : null },
  transfer: { completed: count > 1, completedAt: count > 1 ? TRANSFER_AT : null },
});

async function renderDetail(state: { progress: QuestOneProgress | null; isError?: boolean; isRefreshError?: boolean }) {
  const navigated: unknown[][] = [];
  const refetches: unknown[] = [];
  const quest = {
    accountId: 'beginner-1',
    progress: state.progress,
    display: describeQuestOne({ progress: state.progress, isError: state.isError === true }),
    error: state.isError ? new Error('network') : null,
    isRefreshError: state.isRefreshError === true,
    refreshQuery: { isFetching: false, enabled: true, refetch: () => { refetches.push('refetch'); return Promise.resolve(); } },
  };
  const Screen = load(resolve('src/screens/quest/BeginnerQuestDetailScreen.tsx'), {
    'react-native': { View: 'View', Text: 'Text', ScrollView: 'ScrollView', SafeAreaView: 'SafeAreaView', RefreshControl: 'RefreshControl', ActivityIndicator: 'ActivityIndicator', Platform: { OS: 'android' }, StyleSheet: { create: x => x } },
    '../../features/quest/useBeginnerQuestProgress': { useBeginnerQuestProgress: () => quest },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate: (...args: unknown[]) => navigated.push(args) }) },
    '../../components/states/ErrorNotice': { default: 'ErrorNotice', __esModule: true },
  }).default;
  let renderer: any;
  await Renderer.act(async () => {
    renderer = Renderer.create(React.createElement(Screen, { route: { params: { questId: 'common-01-trading-funds' } }, navigation: {} }));
  });
  const one = (id: string) => renderer.root.findAll(node => node.props.testID === id && typeof node.type === 'string')[0];
  const has = (id: string) => one(id) !== undefined;
  const textOf = (node: any) => node.findAllByType('Text').map(child => [child.props.children].flat(Infinity).join('')).join(' ');
  const stateOf = (id: string) => [one(`${id}-state`)?.props.children].flat(Infinity).join('');
  return { renderer, one, has, text: () => textOf(renderer.root), stateOf, navigated, refetches };
}

it('teaches the four wallets, FX terms and both practices without invented numbers', async t => {
  const h = await renderDetail({ progress: progressOf(0) });
  t.after(async () => { await Renderer.act(async () => h.renderer.unmount()); });
  const copy = h.text();
  for (const expected of ['QUEST 01', '거래 자금 준비하기', '증권 KRW 지갑', '증권 USD 지갑', '암호화폐 현물 USD 지갑', '암호화폐 선물 USD 지갑',
    '환전 (Foreign Exchange)', '환율 (Exchange Rate)', '환전 수수료 (FX Fee)', '실제 수령액 (Net Received Amount)',
    '증권 KRW → 증권 USD', '증권 USD → 암호화폐 현물 USD', '이체는 통화를 바꾸는 거래가 아니에요.']) {
    assert.equal(copy.includes(expected), true, expected);
  }
  assert.equal([...copy.matchAll(/(\d)단계 · (학습|실습)/g)].map(match => match[0]).join(','), '1단계 · 학습,2단계 · 학습,3단계 · 실습,4단계 · 실습');
  // Teaching copy never states a rate, fee amount, reward, level or unlock.
  assert.doesNotMatch(copy, /\d[.,]\d|\d{2,}\s*(원|달러)|%|보상|경험치|레벨|해금|잠금/);
});

it('starts at 0/2 and sends each practice to the existing Wallet screens', async t => {
  const h = await renderDetail({ progress: progressOf(0) });
  t.after(async () => { await Renderer.act(async () => h.renderer.unmount()); });
  assert.equal(h.one('quest-detail-progress-label').props.children, '실습 0/2 완료');
  assert.equal(h.stateOf('quest-step-fx'), '미완료');
  assert.equal(h.stateOf('quest-step-transfer'), '미완료');
  assert.equal(h.has('quest-detail-completed'), false);
  // Transfer follows FX in the lesson; the Wallet tab itself is not restricted.
  assert.equal(h.one('quest-open-transfer').props.disabled, true);
  assert.equal(h.has('quest-transfer-wait'), true);
  await Renderer.act(async () => h.one('quest-open-fx').props.onPress());
  assert.deepEqual(h.navigated, [['MainTabs', { screen: 'WalletTab', params: { screen: 'WalletFx', initial: false } }]]);
});

it('shows the proven FX at 1/2 and opens the existing transfer screen', async t => {
  const h = await renderDetail({ progress: progressOf(1) });
  t.after(async () => { await Renderer.act(async () => h.renderer.unmount()); });
  assert.equal(h.one('quest-detail-progress-label').props.children, '실습 1/2 완료');
  assert.equal(h.stateOf('quest-step-fx'), '완료 · 2026-10-10 10:00');
  assert.equal(h.stateOf('quest-step-transfer'), '미완료');
  assert.equal(h.one('quest-open-transfer').props.disabled, false);
  assert.equal(h.has('quest-transfer-wait'), false);
  await Renderer.act(async () => h.one('quest-open-transfer').props.onPress());
  assert.deepEqual(h.navigated, [['MainTabs', { screen: 'WalletTab', params: { screen: 'WalletTransfer', initial: false } }]]);
});

it('marks the quest complete only at 2/2 and keeps it reviewable', async t => {
  const h = await renderDetail({ progress: progressOf(2) });
  t.after(async () => { await Renderer.act(async () => h.renderer.unmount()); });
  assert.equal(h.one('quest-detail-progress-label').props.children, '실습 2/2 완료');
  assert.equal(h.stateOf('quest-step-transfer'), '완료 · 2026-10-10 10:05');
  assert.equal(h.has('quest-detail-completed'), true);
  assert.equal(h.one('quest-open-fx').props.disabled, false);
  assert.equal(h.one('quest-open-transfer').props.disabled, false);
});

it('never shows completion while progress is loading, failed or stale', async t => {
  for (const [isError, state] of [[false, '확인 중'], [true, '확인 불가']] as const) {
    const h = await renderDetail({ progress: null, isError });
    t.after(async () => { await Renderer.act(async () => h.renderer.unmount()); });
    assert.equal(h.stateOf('quest-step-fx'), state);
    assert.equal(h.stateOf('quest-step-transfer'), state);
    assert.equal(h.has('quest-detail-progress-label'), false);
    assert.equal(h.has('quest-detail-completed'), false);
    assert.equal(h.one('quest-open-transfer').props.disabled, true);
    assert.doesNotMatch(h.stateOf('quest-step-fx') + h.stateOf('quest-step-transfer'), /완료/);
    assert.equal(h.has('quest-detail-error'), isError);
    if (isError) {
      await Renderer.act(async () => h.one('quest-detail-retry').props.onPress());
      assert.deepEqual(h.refetches, ['refetch']);
    }
  }
  const stale = await renderDetail({ progress: progressOf(1), isRefreshError: true });
  t.after(async () => { await Renderer.act(async () => stale.renderer.unmount()); });
  assert.equal(stale.has('quest-detail-stale'), true);
  assert.equal(stale.stateOf('quest-step-fx'), '완료 · 2026-10-10 10:00');
});
