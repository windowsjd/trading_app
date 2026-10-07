import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { getHomeTier } from './tierPresentation.ts';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

function setup() {
  const h = interactionHarness();
  const rankingApi = h.load('src/features/ranking/api.ts', { '../../services/api/client': { apiClient: {} } });
  const Card = h.load('src/screens/home/HomeAccountContext.tsx', {
    '../../features/ranking/api': rankingApi,
    '../../features/me/api': { getMe() {} },
    '../../components/tradingAccount/AccountSwitcher': { __esModule: true, default: ({ children, ...props }) => React.createElement('AccountSwitcher', props, children, props.homeVisual) },
    '../../components/states/SectionSkeleton': { __esModule: true, default: 'Skeleton' },
    '../../components/states/InlineEmptyState': { __esModule: true, default: 'Empty' },
  }).default;
  const context = {
    hasSeason: true, seasonId: 'selected-season', rankType: 'daily',
    meQuery: { data: { nickname: 'mycroft', profileImageUrl: null } },
    rankingQuery: { isLoading: false, isError: false, data: { state: 'available', myRanking: { state: 'available', rank: 12, provisionalTier: 'gold', finalTier: 'diamond' } } },
  };
  const tree = () => React.createElement(Card, { context });
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
  assert.equal(h.node('home-rank').props.children, '#12');
  assert.equal(h.node('home-whale-subject'), undefined);
  assert.equal(h.node('home-whale-wave'), undefined);
  assert.equal(h.renderer.root.findByType('AccountSwitcher').props.homeCardStyle.backgroundColor, getHomeTier(canonical, 'light')?.palette.backgroundColor);
});

it('daily/final selection preserves the existing getRankingTier policy', t => {
  const h = setup(); t.after(h.close);
  assert.equal(h.node('home-tier').props.children, 'Gold');
  h.context.rankType = 'final'; h.context.rankingQuery.data.myRanking.rank = 245; h.update();
  assert.equal(h.node('home-tier').props.children, 'Diamond');
  assert.equal(h.node('home-rank').props.children, '#245');
  assert.match(h.node('home-rank').props.accessibilityLabel, /최종/);
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
    assert.equal(h.node('home-tier-image'), undefined);
    assert.equal(h.renderer.root.findByType('AccountSwitcher').props.homeCardStyle, undefined);
    if (state === 'loading') assert.equal(h.node('home-tier').props.children, '티어 확인 중');
    if (state === 'error') assert.equal(h.node('home-tier').props.children, '티어 확인 실패');
    assert.equal(h.node('home-rank').props.children, ['null', 'unknown'].includes(state) ? '#12' : state === 'loading' ? '—' : '-');
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
  for (const id of ['home-tier', 'home-tier-image', 'home-tier-neutral', 'home-rank']) assert.equal(h.node(id), undefined);
  assert.equal(h.renderer.root.findByType('AccountSwitcher').props.homeCardStyle, undefined);
});

it('supplies the emblem beside the account information and leaves all text untruncated', t => {
  const h = setup(); t.after(h.close);
  assert.ok(h.renderer.root.findByType('AccountSwitcher').props.homeVisual);
  assert.equal(h.node('home-nickname').props.numberOfLines, undefined);
  assert.ok(flatten(h.node('home-nickname').props.style).fontSize > 15);
});

it('an unavailable rank never prints an invalid number or hides the known tier', t => {
  const h = setup(); t.after(h.close);
  for (const rank of [null, undefined, NaN, 0, -1]) {
    h.context.rankingQuery.data.myRanking.rank = rank; h.update();
    assert.equal(h.node('home-rank').props.children, '-');
    assert.equal(h.node('home-tier').props.children, 'Gold');
  }
});
