import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';
const require = createRequire(import.meta.url);
const React = require('react');
const { load, elements } = require('../../../test/ledgerTestHarness.cjs');
const general = { id: 'general', mode: 'general', status: 'active', season: null };
const season = { id: 'season', mode: 'season', status: 'active', season: {
  seasonId: 'current', seasonName: 'Season 1', seasonStatus: 'active', participantStatus: 'active',
  startAt: '2020-01-01T00:00:00Z', endAt: '2099-01-01T00:00:00Z',
} };
const current = { id: 'current', name: 'Season 1', status: 'active', joined: false,
  startAt: '2020-01-01T00:00:00Z', endAt: '2099-01-01T00:00:00Z' };
function harness() {
  const h: any = { accounts: [general, season], loading: false, failed: false, retries: 0, opens: 0, beginnerOpens: 0,
    selections: [], navigation: [], season: { isSuccess: true, data: current }, open: { isPending: false, errorMessage: null } };
  const Screen = load(resolve('src/screens/entry/ModeSelectionScreen.tsx'), {
    react: { ...React, useMemo: fn => fn() },
    'react-native': { View: 'View', Text: 'Text', ScrollView: 'ScrollView', SafeAreaView: 'SafeAreaView', StyleSheet: { create: styles => styles } },
    '@tanstack/react-query': { useQuery: () => ({ ...h.season, refetch: () => { h.retries++; } }) },
    '../../features/season/api': { getCurrentSeason: () => {} },
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ accounts: h.accounts,
      isLoading: h.loading, isError: h.failed, refetchAccounts: () => { h.retries++; }, selectAccount: id => h.selections.push(id) }) },
    '../../features/tradingAccount/useOpenGeneralAccount': { useOpenGeneralAccount: () => ({ ...h.open, start: () => { h.opens++; } }), useOpenBeginnerAccount: () => ({ ...h.open, start: () => { h.beginnerOpens++; } }) },
    '../../components/common/CTAButton': { default: 'CTA', __esModule: true },
    '../../components/states/ErrorState': { default: 'ErrorState', __esModule: true },
    '../../components/states/FullPageLoading': { default: 'FullPageLoading', __esModule: true },
    '../states/ErrorNotice': { default: 'ErrorNotice', __esModule: true },
  }).default;
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand);
    if (!React.isValidElement(node)) return node;
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return React.cloneElement(node, {}, expand(node.props.children));
  }
  h.render = () => expand(Screen({ navigation: { reset: args => h.navigation.push(['reset', args]), navigate: (...args) => h.navigation.push(args) } }));
  return h;
}
const find = (tree, id) => elements(tree).find(node => node.props.testID === id);
const text = tree => elements(tree, 'Text').map(node => node.props.children).join(' ');
it('simplifies owned general/joined season cards while retaining explicit local selection', () => {
  const h = harness(), tree = h.render();
  assert.match(text(tree), /계정 선택하기/); assert.match(text(tree), /일반모드/); assert.match(text(tree), /시즌모드.*참가중.*Season 1/);
  assert.doesNotMatch(text(tree), /투자 방식을|일반 투자|시즌 투자|시간가중|초기 자금/);
  assert.equal(find(tree, 'mode-selection-general-use').props.label, '일반모드');
  assert.equal(find(tree, 'mode-selection-season-continue-season').props.label, '시즌모드');
  assert.equal(find(tree, 'mode-selection-season-join') === undefined, true);
  assert.equal(h.opens, 0); assert.deepEqual(h.selections, []);
  find(tree, 'mode-selection-general-use').props.onPress(); find(tree, 'mode-selection-season-continue-season').props.onPress();
  assert.deepEqual(h.selections, ['general', 'season']); assert.equal(h.opens, 0); assert.equal(h.navigation.length, 2);
});
it('unjoined and empty-account cards offer explicit start/join without a fabricated participation badge', () => {
  const h = harness(); h.accounts = [];
  const tree = h.render(); assert.doesNotMatch(text(tree), /참가중/);
  assert.equal(find(tree, 'mode-selection-general-start').props.label, '일반모드');
  assert.equal(find(tree, 'mode-selection-season-join').props.label, '시즌 참가하기'); assert.equal(h.opens, 0);
  find(tree, 'mode-selection-general-start').props.onPress(); assert.equal(h.opens, 1);
  find(tree, 'mode-selection-season-join').props.onPress(); assert.deepEqual(h.navigation, [['SeasonJoin']]);
});
it('keeps loading, account/season retries, general-open failure and past-season access', () => {
  const h = harness(); h.loading = true; assert.equal(h.render().type, 'FullPageLoading');
  h.loading = false; h.failed = true; const failed = h.render(); assert.equal(failed.type, 'ErrorState'); failed.props.onRetry(); assert.equal(h.retries, 1);
  h.failed = false; h.accounts = []; h.open = { isPending: true, errorMessage: '계정 개설 오류' };
  h.season = { isError: true, error: new Error('offline') };
  let tree = h.render(); assert.match(text(tree), /계정 개설 오류|시즌 정보를 불러오지 못했습니다/);
  assert.equal(find(tree, 'mode-selection-general-start').props.state, 'loading');
  elements(tree, 'CTA').find(node => node.props.label === '시즌 정보 다시 확인').props.onPress(); assert.equal(h.retries, 2);
  h.accounts = [general, { ...season, status: 'closed', season: { ...season.season, seasonStatus: 'settled' } }];
  h.season = { isSuccess: true, data: null }; tree = h.render(); assert.ok(find(tree, 'mode-selection-season-none'));
  assert.ok(find(tree, 'mode-selection-past-season-season')); find(tree, 'mode-selection-past-season-season').props.onPress();
  assert.deepEqual(h.selections, ['season']); assert.equal(h.opens, 0);
});


it('beginner entry is always available and creation requires an explicit press', () => {
  const h = harness();
  assert.equal(find(h.render(), 'beginner-account-entry') !== undefined, true);
  const tree = h.render();
  assert.equal(h.beginnerOpens, 0);
  assert.match(text(tree), /초보 계정 만들기/);
  find(tree, 'beginner-account-start').props.onPress();
  assert.equal(h.beginnerOpens, 1);
  assert.equal(h.opens, 0);
});
it('existing beginner selection changes accounts without creating or moving data', () => {
  const h = harness();
  h.accounts.push({ ...general, id: 'beginner', mode: 'beginner' });
  const tree = h.render();
  find(tree, 'beginner-account-start').props.onPress();
  assert.deepEqual(h.selections, ['beginner']);
  assert.equal(h.beginnerOpens, 0);
  find(h.render(), 'mode-selection-general-use').props.onPress();
  assert.deepEqual(h.selections, ['beginner', 'general']);
  assert.equal(h.opens, 0);
});

it('beginner creation errors retain the original error for the shared diagnostic surface', () => {
  const h = harness();
  const failure = { response: { status: 409, data: { error: { code: 'TRADING_ACCOUNT_INTEGRITY_ERROR' } } } };
  h.open.error = failure;
  const tree = h.render();
  assert.equal(find(tree, 'beginner-account-error').props.error === failure, true);
  assert.equal(h.beginnerOpens, 0);
  assert.equal(h.selections.length, 0);
});

it('lists 초보모드 first, then 일반모드, then 시즌모드, keeping past seasons reachable', () => {
  const order = (tree) => elements(tree).map(node => node.props.testID).filter(id => typeof id === 'string' && (
    id === 'beginner-account-entry' || id.startsWith('mode-selection-general-') || id.startsWith('mode-selection-season-')
    || id.startsWith('mode-selection-past-season-')));
  const h = harness();
  h.accounts.push({ ...general, id: 'beginner', mode: 'beginner' });
  assert.deepEqual(order(h.render()), ['beginner-account-entry', 'mode-selection-general-use', 'mode-selection-season-continue-season']);
  const fresh = harness(); fresh.accounts = [];
  assert.deepEqual(order(fresh.render()), ['beginner-account-entry', 'mode-selection-general-start', 'mode-selection-season-join']);
  const past = harness();
  past.accounts = [general, { ...season, status: 'closed', season: { ...season.season, seasonStatus: 'settled' } }];
  past.season = { isSuccess: true, data: null };
  assert.deepEqual(order(past.render()), ['beginner-account-entry', 'mode-selection-general-use', 'mode-selection-season-none', 'mode-selection-past-season-season']);
  // Order only: nothing is selected or created by rendering.
  assert.deepEqual([h.selections, h.opens, h.beginnerOpens, fresh.opens, fresh.beginnerOpens], [[], 0, 0, 0, 0]);
});
