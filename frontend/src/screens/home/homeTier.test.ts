import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { getHomeTier } from './tierPresentation.ts';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

function setup() {
  const h = interactionHarness();
  const rankingApi = h.load('src/features/ranking/api.ts', { '../../services/api/client': { apiClient: {} } });
  const module = h.load('src/screens/home/HomeAccountContext.tsx', {
    '../../features/ranking/api': rankingApi,
    '../../features/me/api': { getMe() {} },
    '../../components/tradingAccount/AccountSwitcher': { __esModule: true, default: ({ children, ...props }) => React.createElement('AccountSwitcher', props, children) },
    '../../components/states/SectionSkeleton': { __esModule: true, default: 'Skeleton' },
    '../../components/states/InlineEmptyState': { __esModule: true, default: 'Empty' },
    './AdminDiagnosticPanel': { __esModule: true, default: () => null },
  });
  // The account box and the tier badge beside the total assets share one context.
  const Card = module.default;
  const Badge = module.HomeTierBadge;
  const Name = module.HomeTierName;
  const context = {
    hasSeason: true, seasonId: 'selected-season', rankType: 'daily',
    meQuery: { data: { nickname: 'mycroft', profileImageUrl: null } },
    rankingQuery: { isLoading: false, isError: false, data: { state: 'available', myRanking: { state: 'available', rank: 12, provisionalTier: 'gold', finalTier: 'diamond' } } },
  };
  const tree = () => React.createElement(React.Fragment, null,
    React.createElement(Card, { context }), React.createElement('Hero', null, React.createElement(Badge, { context })),
    React.createElement('Trend', null, React.createElement(Name, { context })));
  const renderer = h.render(tree());
  const node = id => renderer.root.findAll(n => typeof n.type === 'string' && n.props.testID === id)[0];
  return { h, context, renderer, node, update: () => act(() => renderer.update(tree())), close: () => act(() => renderer.unmount()) };
}

for (const [canonical, name, id] of [
  ['bronze', 'Bronze', 'bronze'], ['silver', 'Silver', 'silver'], ['gold', 'Gold', 'gold'],
  ['platinum', 'Platinum', 'platinum'], ['diamond', 'Diamond', 'diamond'], ['master', 'Whale', 'whale'],
]) it(`${canonical} selects its complete provided emblem and Home presentation in both appearances`, t => {
  for (const mode of ['light', 'dark'] as const) assert.equal(getHomeTier(canonical, mode)?.name, name);
  const h = setup(); t.after(h.close);
  h.context.rankingQuery.data.myRanking.provisionalTier = canonical; h.update();
  assert.equal(h.node('home-tier').props.children, name);
  assert.ok(h.node(`home-emblem-${id}`));
  assert.ok(h.node('home-tier-image').props.source.uri.endsWith(`/${id}.png`));
  assert.equal(h.node('home-tier-image').props.resizeMode, 'contain');
  // The rank lives on the Ranking tab, not in Home's account box.
  assert.equal(h.node('home-rank') === undefined, true);
  assert.equal(h.node('home-whale-subject') === undefined, true);
  assert.equal(h.node('home-whale-wave') === undefined, true);
  // The emblem sits beside the total assets; Home's account box carries no tier art.
  assert.ok(h.renderer.root.findByType('Hero').findAll((n: any) => n.props.testID === `home-emblem-${id}`).length === 1);
  assert.equal(h.renderer.root.findByType('AccountSwitcher').findAll((n: any) => n.props.testID === `home-emblem-${id}`).length, 0);
  // Its name sits on the asset trend disclosure's line, not inside the hero.
  assert.equal(h.renderer.root.findByType('Trend').findAll((n: any) => n.props.testID === 'home-tier').length > 0, true);
  assert.equal(h.renderer.root.findByType('Hero').findAll((n: any) => n.props.testID === 'home-tier').length, 0);
  assert.equal(h.node(`home-tier-background-${id}-light`) === undefined, true);
  assert.deepEqual(Object.keys(h.renderer.root.findByType('AccountSwitcher').props).sort(), ['children', 'home']);
});

it('daily/final selection preserves the existing getRankingTier policy', t => {
  const h = setup(); t.after(h.close);
  assert.equal(h.node('home-tier').props.children, 'Gold');
  h.context.rankType = 'final'; h.context.rankingQuery.data.myRanking.rank = 245; h.update();
  assert.equal(h.node('home-tier').props.children, 'Diamond');
  assert.equal(h.node('home-rank') === undefined, true);
  h.context.rankingQuery.data.myRanking.finalTier = null; h.update();
  assert.equal(h.node('home-tier').props.children, '티어 미정', 'final never falls back to provisional');
  h.context.rankType = 'daily'; h.context.rankingQuery.data.myRanking.provisionalTier = null;
  h.context.rankingQuery.data.myRanking.finalTier = 'silver'; h.update();
  assert.equal(h.node('home-tier').props.children, 'Silver', 'retain the existing daily helper fallback');
});

for (const state of ['loading', 'error', 'null', 'unknown', 'response-unavailable', 'my-unavailable', 'not-joined', 'missing-season', 'missing-response']) {
  it(`${state} uses neutral visuals, including errors retaining cached data`, t => {
    const h = setup(); t.after(h.close);
    const q = h.context.rankingQuery;
    if (state === 'loading') q.isLoading = true;
    if (state === 'error') q.isError = true;
    if (state === 'null') { q.data.myRanking.provisionalTier = null; q.data.myRanking.finalTier = null; }
    if (state === 'unknown') q.data.myRanking.provisionalTier = 'grandmaster';
    if (state === 'response-unavailable') q.data.state = 'unavailable';
    if (state === 'my-unavailable') q.data.myRanking.state = 'unavailable';
    if (state === 'not-joined') q.data.myRanking.state = 'not_joined';
    if (state === 'missing-season') h.context.seasonId = null;
    if (state === 'missing-response') q.data = undefined;
    h.update();
    assert.ok(h.node('home-tier-neutral'));
    assert.equal(h.node('home-tier-image') === undefined, true);
    assert.equal(h.renderer.root.findAll((n: any) => typeof n.type === 'string' && String(n.props?.testID ?? '').startsWith('home-tier-background-')).length, 0);
    if (state === 'loading') assert.equal(h.node('home-tier').props.children, '티어 확인 중');
    if (state === 'error') assert.equal(h.node('home-tier').props.children, '티어 확인 실패');
    assert.equal(h.node('home-rank') === undefined, true);
    // Only a failed read keeps a notice (with its own diagnostic) in the account box.
    assert.equal(h.renderer.root.findByType('AccountSwitcher').findAll((n: any) => n.props.message === '랭킹 정보를 불러오지 못했습니다.').length > 0, state === 'error');
  });
}

it('unknown identifiers cannot select an inherited property or invent a tier', () => {
  for (const value of [null, undefined, '-', 'whale', 'Grandmaster', 'constructor', '__proto__', 'gold II']) assert.equal(getHomeTier(value, 'light'), null);
  assert.equal(getHomeTier('Master', 'dark')?.name, 'Whale');
});

it('general account has no tier, frame, background or rank; missing me does not remove a valid tier', t => {
  const h = setup(); t.after(h.close);
  h.context.meQuery.data = undefined; h.update();
  assert.ok(h.node('home-emblem-gold'));
  h.context.hasSeason = false; h.context.seasonId = null; h.update();
  for (const id of ['home-tier', 'home-tier-image', 'home-tier-neutral', 'home-rank', 'home-tier-badge']) assert.equal(h.node(id) === undefined, true);
  assert.equal(h.renderer.root.findByType('Trend').findAll((n: any) => typeof n.type === 'string' && n.type !== 'Trend').length, 0);
});

it('keeps the emblem out of the account box and leaves all text untruncated', t => {
  const h = setup(); t.after(h.close);
  assert.ok(h.node('home-tier-badge'));
  assert.equal(h.renderer.root.findByType('AccountSwitcher').findAll((n: any) => n.props.testID === 'home-tier-badge').length, 0);
  assert.equal(h.node('home-nickname').props.numberOfLines, undefined);
  assert.ok(flatten(h.node('home-nickname').props.style).fontSize > 15);
});

it('the account box never prints a rank, and an invalid rank never hides the known tier', t => {
  const h = setup(); t.after(h.close);
  for (const rank of [12, null, undefined, NaN, 0, -1]) {
    h.context.rankingQuery.data.myRanking.rank = rank; h.update();
    assert.equal(h.node('home-rank') === undefined, true);
    assert.equal(h.renderer.root.findAll((n: any) => typeof n.type === 'string' && /^#/.test(String(n.props.children))).length, 0);
    assert.equal(h.node('home-tier').props.children, 'Gold');
  }
});

for (const [width, fontScale, size] of [[430, 1, 140], [390, 1, 132], [360, 1.3, 132], [359, 1, 100], [390, 1.5, 100], [320, 2, 100]] as const) {
  it(`the emblem beside the total is ${size}dp at ${width}dp / text ×${fontScale}, keeping its proportions`, t => {
    const h = setup(); t.after(h.close);
    h.h.dimensions = { ...h.h.dimensions, width, fontScale };
    h.context.rankingQuery.isError = true; h.update();
    const neutral = flatten(h.node('home-tier-neutral').props.style);
    assert.equal(neutral.width, size); assert.equal(neutral.height, size);
    h.context.rankingQuery.isError = false; h.update();
    const emblem = flatten(h.node('home-emblem-gold').props.style);
    assert.equal(Math.abs(emblem.width / emblem.height - 1) < 0.2, true, 'original aspect, never stretched to the slot');
    assert.equal(emblem.width > size * 0.8 && emblem.width <= size * 1.1, true);
    // The name's column is the emblem's own width, so it centers under it.
    const column = () => flatten(h.renderer.root.findByType('Trend').findAll((n: any) => typeof n.type === 'string' && n.type !== 'Trend')[0].props.style).minWidth;
    assert.equal(column(), emblem.width);
    h.context.rankingQuery.data.myRanking.provisionalTier = 'master'; h.update();
    assert.equal(column(), flatten(h.node('home-emblem-whale').props.style).width);
  });
}
