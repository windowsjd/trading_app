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
/** A fresh joinable current season (another season than the settled one). */
const current0 = () => ({ ...current, id: 'season-2', name: 'Season 2' });
function harness() {
  const h: any = { accounts: [general, season], loading: false, failed: false, retries: 0, opens: 0, beginnerOpens: 0,
    selections: [], navigation: [], season: { isSuccess: true, data: current }, open: { isPending: false, errorMessage: null } };
  const Screen = load(resolve('src/screens/entry/ModeSelectionScreen.tsx'), {
    react: { ...React, useMemo: fn => fn() },
    'react-native': { View: 'View', Text: 'Text', ScrollView: 'ScrollView', SafeAreaView: 'SafeAreaView', StyleSheet: { create: styles => styles } },
    '@tanstack/react-query': { useQuery: (options) => { h.queryOptions = options; return { ...h.season, refetch: () => { h.retries++; } }; } },
    '../../features/season/api': { getCurrentSeason: () => {} },
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ accounts: h.accounts,
      isLoading: h.loading, isError: h.failed, refetchAccounts: () => { h.retries++; }, selectAccount: id => h.selections.push(id) }) },
    '../../features/tradingAccount/useOpenGeneralAccount': { useOpenGeneralAccount: () => ({ ...h.open, start: () => { h.opens++; } }), useOpenBeginnerAccount: () => ({ ...h.open, start: () => { h.beginnerOpens++; } }) },
    '../../components/common/CTAButton': { default: 'CTA', __esModule: true },
    '../../components/states/ErrorState': { default: 'ErrorState', __esModule: true },
    '../../components/states/FullPageLoading': { default: 'FullPageLoading', __esModule: true },
    '../states/ErrorNotice': { default: 'ErrorNotice', __esModule: true },
    // A loading CTA's spinner is a native animation boundary for this shallow expansion.
    '../states/WhaleLoader': { default: 'WhaleLoader', __esModule: true },
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
  assert.equal(find(tree, 'mode-selection-general-start').props.label, '일반모드 계정만들기');
  assert.equal(find(tree, 'mode-selection-season-join').props.label, '시즌참가하기'); assert.equal(h.opens, 0);
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
  assert.match(text(tree), /초보모드 계정만들기/);
  assert.doesNotMatch(text(tree), /초보 계정 만들기/);
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

const order = (tree) => elements(tree).map(node => node.props.testID).filter(id => typeof id === 'string' && (
  id === 'beginner-account-entry' || id.startsWith('mode-selection-general-') || id.startsWith('mode-selection-season-')
  || id.startsWith('mode-selection-past-season-')));
/** A season account whose season was settled; `viewedAt` undefined = a server without the field. */
const settledSeason = (viewedAt?: string | null, patch: Record<string, unknown> = {}) => ({ ...season, id: 'settled', status: 'closed',
  season: { ...season.season, seasonId: 'season-0', seasonName: 'Season 0', seasonStatus: 'settled', participantStatus: 'finished',
    endAt: '2026-09-01T00:00:00Z', ...(viewedAt === undefined ? {} : { finalResultViewedAt: viewedAt }), ...patch } });

it('lists 시즌모드 first, then 일반모드, then 초보모드, keeping past seasons reachable', () => {
  const h = harness();
  h.accounts.push({ ...general, id: 'beginner', mode: 'beginner' });
  assert.deepEqual(order(h.render()), ['mode-selection-season-continue-season', 'mode-selection-general-use', 'beginner-account-entry']);
  const fresh = harness(); fresh.accounts = [];
  assert.deepEqual(order(fresh.render()), ['mode-selection-season-join', 'mode-selection-general-start', 'beginner-account-entry']);
  const past = harness();
  past.accounts = [general, { ...season, status: 'closed', season: { ...season.season, seasonStatus: 'settled' } }];
  past.season = { isSuccess: true, data: null };
  assert.deepEqual(order(past.render()), ['mode-selection-season-none', 'mode-selection-season-next-soon', 'mode-selection-general-use',
    'beginner-account-entry', 'mode-selection-past-season-season']);
  const unseen = harness();
  unseen.accounts = [general, settledSeason(null)];
  assert.deepEqual(order(unseen.render()), ['mode-selection-season-result', 'mode-selection-general-use', 'beginner-account-entry',
    'mode-selection-past-season-settled']);
  // Order only: nothing is selected or created by rendering.
  assert.deepEqual([h.selections, h.opens, h.beginnerOpens, fresh.opens, fresh.beginnerOpens, unseen.selections, unseen.navigation],
    [[], 0, 0, 0, 0, [], []]);
});

it('a settled season whose result was not seen offers 시즌결과 확인하기 first, opening that season\'s result', () => {
  const h = harness();
  // Joinable current season too: the unseen result still comes first.
  h.accounts = [general, settledSeason(null)];
  const tree = h.render();
  const button = find(tree, 'mode-selection-season-result');
  assert.equal(button.props.label, '시즌결과 확인하기');
  assert.equal(find(tree, 'mode-selection-season-join') === undefined, true);
  assert.equal(find(tree, 'mode-selection-season-next-soon') === undefined, true);
  assert.match(text(tree), /시즌모드 정해진 기간동안 가상투자로 수익률을 경쟁해보세요! Season 0/);
  button.props.onPress();
  assert.deepEqual(h.navigation, [['SeasonFinalResult', { seasonId: 'season-0' }]]);
  assert.deepEqual([h.selections, h.opens, h.beginnerOpens], [[], 0, 0]);
});

it('after the result was seen: 시즌참가하기 when a season is joinable, otherwise a disabled 다음시즌이 곧 시작됩니다', () => {
  const joinable = harness();
  joinable.accounts = [general, settledSeason('2026-09-02T00:00:00Z')];
  let tree = joinable.render();
  assert.equal(find(tree, 'mode-selection-season-result') === undefined, true);
  assert.equal(find(tree, 'mode-selection-season-join').props.label, '시즌참가하기');
  find(tree, 'mode-selection-season-join').props.onPress();
  assert.deepEqual(joinable.navigation, [['SeasonJoin']]);

  for (const current of [null, { ...current0(), status: 'upcoming', effectiveMode: 'upcoming' },
    { ...current0(), status: 'ended', effectiveMode: 'ended' }, { ...current0(), status: 'settled', effectiveMode: 'settled' },
    { ...current0(), joined: true }]) {
    const waiting = harness();
    waiting.accounts = [general, settledSeason('2026-09-02T00:00:00Z')];
    waiting.season = { isSuccess: true, data: current };
    tree = waiting.render();
    const soon = find(tree, 'mode-selection-season-next-soon');
    assert.equal(soon.props.label, '다음시즌이 곧 시작됩니다');
    assert.equal(soon.props.state, 'disabled');
    assert.equal(soon.props.onPress === undefined, true);
    assert.equal(find(tree, 'mode-selection-season-join') === undefined, true);
    assert.equal(find(tree, 'mode-selection-season-result') === undefined, true);
  }
  // "No current season" (404) is an answer too: nothing to join yet.
  const none = harness();
  none.accounts = [settledSeason('2026-09-02T00:00:00Z')];
  none.season = { isError: true, error: { response: { status: 404, data: { error: { code: 'SEASON_NOT_FOUND' } } } } };
  assert.equal(find(none.render(), 'mode-selection-season-next-soon').props.state, 'disabled');
});

it('re-reads the current season only while waiting, so a season that opens later turns into 시즌참가하기', () => {
  const h = harness();
  h.accounts = [general, settledSeason('2026-09-02T00:00:00Z')];
  h.season = { isSuccess: true, data: null };
  h.render();
  const interval = (data) => h.queryOptions.refetchInterval({ state: { data } });
  assert.equal(interval(undefined), 60_000);
  assert.equal(interval({ ...current0(), status: 'upcoming', effectiveMode: 'upcoming' }), 60_000);
  assert.equal(interval(current0()), false, 'a joinable season stops the polling');
  h.season = { isSuccess: true, data: current0() };
  assert.equal(find(h.render(), 'mode-selection-season-join').props.label, '시즌참가하기');
  // Never while an unseen result or a running season is on the card.
  const unseen = harness(); unseen.accounts = [general, settledSeason(null)]; unseen.render();
  assert.equal(unseen.queryOptions.refetchInterval({ state: { data: undefined } }), false);
  const running = harness(); running.render();
  assert.equal(running.queryOptions.refetchInterval({ state: { data: undefined } }), false);
});

it('an ended season awaiting settlement shows no result yet; a server without the view field never offers one', () => {
  const settling = harness();
  settling.accounts = [general, settledSeason(null, { seasonStatus: 'ended' })];
  settling.season = { isSuccess: true, data: null };
  let tree = settling.render();
  assert.equal(find(tree, 'mode-selection-season-result') === undefined, true);
  const sentences = elements(tree, 'Text').map(node => [node.props.children].flat().join('')).join(' ');
  assert.match(sentences, /Season 0 결과를 정산하고 있습니다\. 정산이 끝나면 이곳에서 시즌결과를 확인할 수 있습니다\./);
  assert.equal(find(tree, 'mode-selection-season-next-soon').props.state, 'disabled');

  const older = harness();
  older.accounts = [general, settledSeason(undefined)];
  older.season = { isSuccess: true, data: null };
  tree = older.render();
  assert.equal(find(tree, 'mode-selection-season-result') === undefined, true);
  assert.equal(find(tree, 'mode-selection-season-next-soon').props.label, '다음시즌이 곧 시작됩니다');
});

it('describes each account type directly under its title and no longer shows the old beginner note', () => {
  const copy = {
    beginner: '퀘스트를 따라 투자의 기초부터 다양한 거래 방법까지 단계별로 연습합니다.',
    general: '시즌 기간 제한 없이 자유롭게 가상 투자를 연습합니다.',
    season: '정해진 기간동안 가상투자로 수익률을 경쟁해보세요!',
  };
  const texts = tree => elements(tree, 'Text').map(node => [node.props.children].flat().join(''));
  // Owned general + joined season, then a fresh user offered start/join.
  const joined = harness(), fresh = harness();
  fresh.accounts = [];
  for (const [h, seasonName] of [[joined, 'Season 1'], [fresh, 'Season 1']] as const) {
    const tree = h.render(), all = texts(tree);
    assert.doesNotMatch(all.join(' '), /초보 계정의 자산과 거래 기록은 다른 계정과 별도로 관리됩니다/);
    assert.equal(find(tree, 'beginner-account-description').props.children, copy.beginner);
    assert.equal(find(tree, 'mode-description-general').props.children, copy.general);
    assert.equal(find(tree, 'mode-description-season').props.children, copy.season);
    // Each sentence follows its own title (a status badge may sit between) and precedes the next card.
    const at = (value: string) => all.indexOf(value);
    assert.equal(at(copy.beginner), at('초보모드') + 1);
    assert.equal(at('일반모드') < at(copy.general) && at(copy.general) <= at('일반모드') + 2, true);
    assert.equal(at(copy.season) < at('일반모드'), true, '시즌모드 is listed first');
    assert.equal(at(copy.general) < at('초보모드'), true);
    assert.equal(at('시즌모드') < at(copy.season) && at(copy.season) < at(seasonName), true);
    assert.equal(all.filter(value => Object.values(copy).includes(value)).length, 3, 'one sentence per type');
  }
  // Rendering the copy creates or selects nothing.
  assert.deepEqual([joined.selections, joined.opens, joined.beginnerOpens, fresh.opens, fresh.beginnerOpens], [[], 0, 0, 0, 0]);
});
