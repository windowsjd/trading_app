import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, mock, type TestContext } from 'node:test';
import { availableRankings } from '../../features/ranking/fixtures.ts';
import type { RankingInsight } from '../../features/ranking/rankingInsights.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { getFinancialColors } from '../../theme/financialColors.ts';
import { semantic } from '../../theme/tokens.ts';
import { getHomeTier } from '../home/tierPresentation.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const query = require('@tanstack/react-query');

const FIVE: RankingInsight[] = [
  { key: 'above', label: '바로 위 hana까지', value: '3,389', suffix: '원', glyph: '↑' },
  { key: 'first', label: '1위 demiant까지', value: '46,693', suffix: '원', glyph: '1' },
  { key: 'tier', label: 'Platinum 티어까지', value: '17,141', suffix: '원', glyph: 'P', tier: 'platinum' },
  { key: 'goal', label: '본전까지', value: '44,731', suffix: '원', glyph: '0%' },
  { key: 'change', label: '어제보다 자산', value: '+55,269', suffix: '원', glyph: '▲', direction: 'up',
    detail: { text: '▲ 순위 4계단 상승', spoken: '순위 4계단 상승', direction: 'up' } },
];
const FULL_LABEL = '순위 안내. 바로 위 hana까지 3,389원. 1위 demiant까지 46,693원. Platinum 티어까지 17,141원. '
  + '본전까지 44,731원. 어제보다 자산 +55,269원, 순위 4계단 상승.';
const SHOWN = {
  above: '↑|바로 위 hana까지|3,389|원',
  first: '1|1위 demiant까지|46,693|원',
  tier: 'P|Platinum 티어까지|17,141|원',
  goal: '0%|본전까지|44,731|원',
  change: '▲|어제보다 자산|+55,269|원|▲| 순위 4계단 상승',
};
// Exit 180 ms ease-in to -8, a 40 ms blank, enter 260 ms ease-out from +8 (native driver, not an interaction).
const EXIT = ['opacity 0 180 0.25 true false', 'offset -8 180 0.25 true false'];
const ENTER = ['opacity 1 260 0.875 true false', 'offset 0 260 0.875 true false'];

const strings = (node: any): string[] =>
  node.children.flatMap((child: any) => (typeof child === 'string' ? [child] : strings(child)));

function slotHarness(t: TestContext, reduced = false) {
  mock.timers.enable({ apis: ['setTimeout'] });
  // The slot's live timers: mocked setTimeouts neither fired nor cleared.
  // React captured its own timer functions at load, so only the slot's count.
  const pending = new Set<unknown>();
  const mockedSet = globalThis.setTimeout;
  const mockedClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    const id = mockedSet(() => { pending.delete(id); callback(); }, ms);
    pending.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(id);
    mockedClear(id);
  }) as typeof clearTimeout;

  const ui = interactionHarness();
  ui.reduced = reduced;
  const h: any = { ui, pending, appListeners: 0, renderer: null, mounted: false };
  ui.native.AppState = {
    currentState: 'active',
    addEventListener: (_type: string, listener: (state: string) => void) => {
      h.appListeners += 1;
      h.appState = (state: string) => act(() => listener(state));
      return { remove: () => { h.appListeners -= 1; } };
    },
  };
  const Slot = ui.load('src/screens/ranking/RankingInsightSlot.tsx').default;
  t.after(() => {
    if (h.mounted) act(() => h.renderer.unmount());
    globalThis.setTimeout = mockedSet;
    globalThis.clearTimeout = mockedClear;
    mock.timers.reset();
  });

  h.render = (messages: RankingInsight[], paused = false) => {
    h.props = { messages, paused };
    h.renderer = ui.render(React.createElement(Slot, h.props));
    h.mounted = true;
  };
  h.update = (next: Record<string, unknown>) => {
    h.props = { ...h.props, ...next };
    act(() => h.renderer.update(React.createElement(Slot, h.props)));
  };
  h.unmount = () => { act(() => h.renderer.unmount()); h.mounted = false; };
  h.hosts = (id: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id);
  h.has = (id: string) => h.hosts(id).length > 0;
  h.node = (id: string) => h.hosts(id)[0];
  h.tick = (ms: number) => act(() => { mock.timers.tick(ms); });
  h.finish = () => ui.finish();
  h.press = (id: string) => act(() => h.node(id).props.onPress());
  h.message = () => h.node('ranking-slot-message');
  h.shown = () => strings(h.message()).join('|');
  h.opacity = () => h.message().props.style.opacity;
  h.offset = () => h.message().props.style.transform[0]?.translateY;
  h.motions = () => ui.animations.map((animation: any) => [
    animation.value === h.opacity() ? 'opacity' : animation.value === h.offset() ? 'offset' : 'other',
    animation.options.toValue, animation.options.duration, animation.options.easing(0.5),
    animation.options.useNativeDriver, animation.options.isInteraction,
  ].join(' '));
  // One full transition: exit → blank → enter.
  h.complete = () => { h.finish(); h.tick(40); h.finish(); };
  return h;
}

describe('순위 안내 슬롯: 로테이션', () => {
  it('moves on after 4 s: exit 180 ms → 40 ms blank → enter 260 ms, then dwells 4 s again', (t) => {
    const h = slotHarness(t);
    h.render(FIVE);
    assert.equal(h.shown(), SHOWN.above);
    h.tick(3999);
    assert.deepEqual(h.motions(), []);
    h.tick(1);
    assert.deepEqual(h.motions(), EXIT);
    h.finish();
    assert.equal(h.shown(), SHOWN.above, 'the old message stays (invisible) through the blank');
    assert.equal(h.opacity().value, 0);
    h.tick(39);
    assert.deepEqual(h.motions(), EXIT);
    h.tick(1);
    assert.deepEqual(h.motions(), [...EXIT, ...ENTER]);
    assert.equal(h.shown(), SHOWN.first);
    assert.equal(h.offset().value, 8, 'enters from 8 px below');
    h.finish();
    assert.equal(h.opacity().value, 1);
    assert.equal(h.offset().value, 0);
    h.tick(3999);
    assert.equal(h.motions().length, 4);
    h.tick(1);
    assert.deepEqual(h.motions().slice(4), EXIT);
  });

  it('a tap moves on, a dot jumps to its message, input during a transition is ignored, and a manual move restarts the dwell', (t) => {
    const h = slotHarness(t);
    h.render(FIVE);
    h.tick(3000);
    h.press('ranking-slot-next');
    assert.deepEqual(h.motions(), EXIT);
    h.press('ranking-slot-next');
    h.press('ranking-slot-dot-change');
    assert.equal(h.motions().length, 2, 'ignored while leaving');
    h.finish();
    h.press('ranking-slot-dot-goal');
    h.tick(40);
    assert.equal(h.shown(), SHOWN.first);
    h.press('ranking-slot-dot-goal');
    assert.equal(h.motions().length, 4, 'ignored while blank and entering');
    h.finish();
    // The automatic dwell from mount (due at 4 s) was dropped; a new one starts after entering.
    h.tick(1000);
    assert.equal(h.motions().length, 4);
    h.tick(2999);
    assert.equal(h.motions().length, 4);
    h.tick(1);
    assert.equal(h.motions().length, 6);
    h.complete();
    assert.equal(h.shown(), SHOWN.tier);
    h.press('ranking-slot-dot-change');
    h.complete();
    assert.equal(h.shown(), SHOWN.change);
    const started = h.motions().length;
    h.press('ranking-slot-dot-change');
    assert.equal(h.motions().length, started, 'the current dot does nothing');
    h.press('ranking-slot-next');
    h.complete();
    assert.equal(h.shown(), SHOWN.above, 'wraps around');
    const dots = FIVE.map((message) => h.node(`ranking-slot-dot-${message.key}`));
    assert.equal(dots.every((dot: any) => {
      const box = flatten(dot.props.style);
      return box.width >= 24 && box.height + dot.props.hitSlop.top + dot.props.hitSlop.bottom >= 24;
    }), true, 'every dot is a 24 px tall target');
    assert.deepEqual(dots.map((dot: any) => flatten(dot.findAllByType('View')[0].props.style).backgroundColor),
      [semantic.text, semantic.border, semantic.border, semantic.border, semantic.border]);
  });

  it('stops while unfocused or in the background and dwells 4 s anew on return', (t) => {
    const h = slotHarness(t);
    h.render(FIVE);
    assert.equal(h.appListeners, 1);
    h.tick(3000);
    h.update({ paused: true });
    h.tick(10_000);
    assert.deepEqual(h.motions(), []);
    assert.equal(h.shown(), SHOWN.above);
    h.update({ paused: false });
    h.tick(3999);
    assert.deepEqual(h.motions(), []);
    h.tick(1);
    assert.deepEqual(h.motions(), EXIT);
    h.complete();
    h.tick(2000);
    h.appState('background');
    h.tick(10_000);
    assert.equal(h.motions().length, 4);
    assert.equal(h.shown(), SHOWN.first);
    h.appState('active');
    h.tick(3999);
    assert.equal(h.motions().length, 4);
    h.tick(1);
    assert.equal(h.motions().length, 6);
  });

  it('Reduced Motion fades only (about 120 ms each way), without movement', (t) => {
    const h = slotHarness(t, true);
    h.render(FIVE);
    assert.equal(h.message().props.style.transform.length, 0);
    h.tick(4000);
    assert.deepEqual(h.motions(), ['opacity 0 120 0.25 true false']);
    h.finish();
    h.tick(40);
    assert.deepEqual(h.motions(), ['opacity 0 120 0.25 true false', 'opacity 1 120 0.875 true false']);
    h.finish();
    assert.equal(h.shown(), SHOWN.first);
    assert.equal(h.message().props.style.transform.length, 0);
  });

  it('a refresh updates figures in place (no transition, same dwell); a vanished message falls back to the first without motion', (t) => {
    const h = slotHarness(t);
    h.render(FIVE);
    h.tick(2000);
    h.update({ messages: FIVE.map((message) => (message.key === 'above' ? { ...message, value: '1,234' } : message)) });
    assert.equal(h.shown(), '↑|바로 위 hana까지|1,234|원');
    assert.equal(h.node('ranking-slot').props.accessibilityLabel.includes('바로 위 hana까지 1,234원'), true);
    h.tick(1999);
    assert.deepEqual(h.motions(), [], 'the dwell was not reset');
    h.tick(1);
    assert.deepEqual(h.motions(), EXIT);
    h.complete();
    assert.equal(h.shown(), SHOWN.first);
    h.update({ messages: FIVE.filter((message) => message.key !== 'first') });
    assert.equal(h.shown(), SHOWN.above);
    assert.equal(h.motions().length, 4, 'no transition');
    assert.equal(h.opacity().value, 1);
    assert.equal(h.has('ranking-slot-dot-first'), false);
    h.tick(3999);
    assert.equal(h.motions().length, 4);
    h.tick(1);
    assert.equal(h.motions().length, 6, 'a fresh dwell for the replaced message');
  });

  it('one message stays still: no dots, no touch target, no timer, no AppState subscription; none renders nothing', (t) => {
    const h = slotHarness(t);
    h.render([FIVE[3]]);
    assert.equal(h.has('ranking-slot'), true);
    assert.equal(h.shown(), SHOWN.goal);
    assert.equal(h.has('ranking-slot-next'), false);
    assert.equal(FIVE.some((message) => h.has(`ranking-slot-dot-${message.key}`)), false);
    assert.equal(h.pending.size, 0);
    assert.equal(h.appListeners, 0);
    h.tick(60_000);
    assert.deepEqual(h.motions(), []);
    h.update({ messages: [] });
    assert.equal(h.renderer.toJSON() === null, true);
  });

  it('leaves no timer, subscription or running animation after unmount', (t) => {
    const h = slotHarness(t);
    h.render(FIVE);
    assert.equal(h.pending.size, 1, 'the dwell timer is tracked');
    h.tick(4000);
    h.finish();
    assert.equal(h.pending.size, 1, 'the blank timer is tracked');
    h.unmount();
    assert.equal(h.pending.size, 0);
    assert.equal(h.appListeners, 0);

    h.render(FIVE);
    h.tick(4000);
    assert.equal(h.ui.animations.filter((animation: any) => animation.value.animation === animation).length, 2);
    h.unmount();
    assert.equal(h.ui.animations.some((animation: any) => animation.value.animation === animation), false);
    assert.equal(h.pending.size, 0);
    h.tick(60_000);
    assert.equal(h.ui.animations.length, 4, 'nothing restarts after unmount');
  });
});

describe('순위 안내 슬롯: 높이와 접근성', () => {
  it('takes the tallest hidden replica as its minimum height and follows re-measurement', (t) => {
    const h = slotHarness(t);
    h.render(FIVE);
    const minHeight = () => flatten(h.node('ranking-slot-stage').props.style).minHeight;
    const layout = (key: string, height: number) => act(() => h.node(`ranking-slot-measure-${key}`).props
      .onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height } } }));
    assert.equal(minHeight() === undefined, true);
    for (const message of FIVE) layout(message.key, message.key === 'tier' ? 75 : 47);
    assert.equal(minHeight(), 75);
    // Larger text: every replica reports again.
    for (const message of FIVE) layout(message.key, message.key === 'change' ? 150 : 94);
    assert.equal(minHeight(), 150);
    const layer = h.node('ranking-slot-measure-above').parent;
    assert.equal(layer.props.pointerEvents, 'none');
    assert.equal(flatten(layer.props.style).opacity, 0);
    assert.equal(layer.props.importantForAccessibility, 'no-hide-descendants');
    assert.equal(layer.findAll((node: any) => typeof node.props.onLayout === 'function').length, 5);
    assert.equal(flatten(h.node('ranking-slot').props.style).minHeight, 64);
  });

  it('reads every message once from the card; moving parts, dots and the touch target are hidden', (t) => {
    const h = slotHarness(t);
    h.render([...FIVE.slice(0, 4), { ...FIVE[4], value: '-44,731', glyph: '▼', direction: 'down',
      detail: { text: '▼ 순위 2계단 하락', spoken: '순위 2계단 하락', direction: 'down' } }]);
    const card = h.node('ranking-slot');
    assert.equal(card.props.accessible, true);
    assert.equal(card.props.accessibilityLabel, FULL_LABEL.replace('+55,269원, 순위 4계단 상승', '-44,731원, 순위 2계단 하락'));
    const hidden = (node: any) => node.props.accessibilityElementsHidden === true
      && node.props.importantForAccessibility === 'no-hide-descendants';
    assert.equal(hidden(h.node('ranking-slot-next')), true);
    assert.equal(hidden(h.node('ranking-slot-dot-above').parent), true);
    assert.equal(card.findAll((node: any) => node.props.accessibilityLiveRegion !== undefined
      || node.props.accessibilityRole === 'alert').length, 0, 'the rotation is never announced');
    h.tick(4000);
    h.complete();
    assert.equal(h.node('ranking-slot').props.accessibilityLabel, card.props.accessibilityLabel);
    // Glyphs are decorative; direction is also in the words (상승/하락), not only the color.
    const glyph = (key: string) => {
      const text = h.node(`ranking-slot-measure-${key}`).findAllByType('Text')[0];
      return { circle: text.parent, text };
    };
    const colors = getFinancialColors('light', 'red_blue');
    const platinum = getHomeTier('platinum', 'light')!;
    assert.equal(hidden(glyph('change').circle), true);
    assert.equal(flatten(glyph('change').text.props.style).color, colors.fall);
    assert.equal(strings(h.node('ranking-slot-measure-change')).join('|'), '▼|어제보다 자산|-44,731|원|▼| 순위 2계단 하락');
    assert.equal(flatten(glyph('tier').circle.props.style).backgroundColor, platinum.palette.backgroundColor);
    assert.equal(flatten(glyph('tier').text.props.style).color, platinum.palette.color);
    assert.equal(flatten(glyph('goal').circle.props.style).backgroundColor, semantic.raised);
    h.update({ messages: FIVE });
    assert.equal(flatten(glyph('change').text.props.style).color, colors.rise);
  });

  it('어제보다: the asset change on the figure line, the rank move on a smaller hidden line with only its mark colored', (t) => {
    const h = slotHarness(t);
    h.render(FIVE);
    const colors = getFinancialColors('light', 'red_blue');
    const line = () => h.node('ranking-slot-measure-change').findAll((node: any) =>
      typeof node.type === 'string' && node.props.testID === 'ranking-slot-detail-change')[0];
    const mark = () => line().children[0];
    const glyphColor = () => flatten(h.node('ranking-slot-measure-change').findAllByType('Text')[0].props.style).color;
    assert.equal(strings(h.node('ranking-slot-measure-change')).join('|'), SHOWN.change);
    assert.deepEqual([flatten(line().props.style).fontSize, flatten(line().props.style).color], [13, semantic.secondary]);
    assert.deepEqual([mark().children.join(''), flatten(mark().props.style).color], ['▲', colors.rise]);
    assert.equal(line().children[1] === ' 순위 4계단 상승', true, 'the words keep the secondary color');
    assert.equal(line().props.accessibilityElementsHidden === true && line().props.importantForAccessibility === 'no-hide-descendants', true);
    assert.equal(glyphColor(), colors.rise);
    // Other messages have no second line; the card centers them in the tallest message's height.
    assert.equal(h.has('ranking-slot-detail-above'), false);
    assert.equal(flatten(h.node('ranking-slot-stage').props.style).justifyContent, 'center');

    // Nothing moved: no direction color on the glyph, the mark or the words, and no 원.
    h.update({ messages: [...FIVE.slice(0, 4), { key: 'change', label: '어제보다 자산', value: '변동 없음', suffix: '',
      glyph: '–', detail: { text: '– 순위 변동 없음', spoken: '순위 변동 없음' } }] });
    assert.equal(strings(h.node('ranking-slot-measure-change')).join('|'), '–|어제보다 자산|변동 없음|–| 순위 변동 없음');
    assert.equal(glyphColor(), semantic.text);
    assert.equal(flatten(mark().props.style).color === undefined, true);
    assert.equal(h.node('ranking-slot').props.accessibilityLabel.endsWith('어제보다 자산 변동 없음, 순위 변동 없음.'), true);
  });

  it('source: ActionPressable only, no setInterval, no number rolling, no live region', () => {
    const source = readFileSync('src/screens/ranking/RankingInsightSlot.tsx', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.match(source, /import ActionPressable from '\.\.\/\.\.\/components\/common\/ActionPressable'/);
    assert.equal(/\bPressable\b/.test(source.replace(/ActionPressable/g, '')), false, 'no raw Pressable');
    assert.equal(/setInterval/.test(source), false);
    assert.equal(/Rolling|Roller|Odometer|AnimatedNumber/.test(source), false);
    assert.equal(/accessibilityLiveRegion|announceForAccessibility/.test(source), false);
  });
});

// ---------------------------------------------------------------------------
// The slot inside the ranking tab (real React Query, real ranking API module,
// fixture transport).

const TODAY = '2026-10-14';
const YESTERDAY = '2026-10-13';
const CAPTURED = '2026-10-14T03:00:00.000Z';
const NEXT_CAPTURED = '2026-10-14T03:05:00.000Z';
const YESTERDAY_CAPTURED = '2026-10-13T14:55:00.000Z';
// Public rows by rank (N = 100): nickname, total asset, daily tier.
const PEOPLE: Record<number, [string, string, string]> = {
  1: ['demiant', '10001962.00000000', 'master'],
  2: ['second', '10001000.00000000', 'master'],
  3: ['third', '10000500.00000000', 'master'],
  23: ['plat', '9972410.00000000', 'platinum'],
  24: ['gold24', '9970000.00000000', 'gold'],
  30: ['hana', '9958658.00000000', 'gold'],
};

function scenario() {
  return {
    seasonStatus: 'active', joined: true, initialCapitalKrw: '10000000.00000000' as string | undefined,
    state: 'available', myState: 'available', capturedAt: CAPTURED,
    myRank: 31, myTotal: '9955269.00000000', myTier: 'gold',
    yesterdaySet: true, yesterdayRank: 35, yesterdayTotal: '9900000.00000000',
    gates: new Map<string, Promise<void>>(), conflicts: new Set<string>(),
  };
}
type Scenario = ReturnType<typeof scenario>;

function answer(s: Scenario, params: URLSearchParams) {
  const limit = Number(params.get('limit'));
  const offset = Number(params.get('offset'));
  const rankType = params.get('rankType') ?? 'daily';
  const rankingDate = params.get('rankingDate') ?? TODAY;
  const capturedAt = rankingDate === YESTERDAY ? YESTERDAY_CAPTURED : s.capturedAt;
  if (params.get('capturedAt') && params.get('capturedAt') !== s.capturedAt) throw conflict();
  if (s.conflicts.has(`${offset}:${limit}:${params.get('capturedAt')}`)) throw conflict();
  const season = { ...availableRankings.season, status: s.seasonStatus };
  const pagination = { limit, offset, total: 100, returned: 0, nextOffset: null };
  if (s.state !== 'available' || (rankingDate === YESTERDAY && !s.yesterdaySet)) {
    return { state: 'unavailable', season, rankType, rankingDate: null, capturedAt: null, rankings: [],
      pagination: { ...pagination, total: 0 }, myRanking: { state: 'unavailable', reason: 'RANKING_UNAVAILABLE', message: '-' } };
  }
  const tiers = (tier: string) => rankType === 'final' ? { provisionalTier: null, finalTier: tier } : { provisionalTier: tier, finalTier: null };
  const rankings = Object.entries(PEOPLE).map(([rank, [nickname, totalAssetKrw, tier]]) => ({
    ...availableRankings.rankings[0], rank: Number(rank), userId: nickname, nickname, seasonParticipantId: `sp-${nickname}`,
    profileImageUrl: null, totalAssetKrw, capturedAt, ...tiers(tier),
  })).filter((row) => row.rank > offset && row.rank <= offset + limit);
  const myRanking = s.myState !== 'available'
    ? { state: s.myState, reason: s.myState === 'not_joined' ? 'SEASON_NOT_JOINED' : 'MY_RANKING_UNAVAILABLE', message: '-' }
    : { ...availableRankings.myRanking, rank: rankingDate === YESTERDAY ? s.yesterdayRank : s.myRank,
      totalAssetKrw: rankingDate === YESTERDAY ? s.yesterdayTotal : s.myTotal, rankingDate, capturedAt, ...tiers(s.myTier) };
  return { state: 'available', season, rankType, rankingDate, capturedAt, rankings,
    pagination: { ...pagination, returned: rankings.length }, myRanking };
}

function conflict() {
  return { response: { status: 409, data: { success: false, error: { code: 'RANKING_SNAPSHOT_CHANGED', message: 'changed' } } } };
}

async function screenHarness(t: TestContext, s: Scenario = scenario()) {
  const ui = interactionHarness();
  ui.native.AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const h: any = { ui, s, focused: true, requests: [] as URLSearchParams[] };
  const transport = { apiClient: { get: async (path: string) => {
    const url = new URL(path, 'https://fixture.invalid');
    if (url.pathname !== '/ranking') throw new Error(`Unexpected read ${path}`);
    h.requests.push(url.searchParams);
    const gate = s.gates.get(`${url.searchParams.get('offset')}:${url.searchParams.get('limit')}:${url.searchParams.get('capturedAt')}`);
    if (gate) await gate;
    return { data: { success: true, data: answer(s, url.searchParams) } };
  } } };
  const api = ui.load('src/features/ranking/api.ts', { '../../services/api/client': transport });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const Screen = ui.load('src/screens/ranking/RankingScreen.tsx', {
    'react-native': { ...ui.native, SafeAreaView: 'SafeAreaView',
      FlatList: ({ ListHeaderComponent, ListEmptyComponent, ListFooterComponent, data, renderItem }: any) =>
        React.createElement('List', null, ListHeaderComponent,
          data.length ? data.map((item: any) => React.createElement(React.Fragment, { key: item.seasonParticipantId }, renderItem({ item })))
            : ListEmptyComponent,
          ListFooterComponent),
    },
    '@tanstack/react-query': query,
    '../../features/ranking/api': api,
    '../../features/season/api': { getCurrentSeason: async () => ({ ...availableRankings.season,
      status: s.seasonStatus, joined: s.joined, initialCapitalKrw: s.initialCapitalKrw }) },
    '../../features/me/api': { getMe: async () => ({ nickname: 'me' }) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate() {} }) },
    '@react-navigation/native': { useIsFocused: () => h.focused },
  }).default;
  const element = () => React.createElement(query.QueryClientProvider, { client },
    React.createElement(Screen, { navigation: { navigate() {} } }));
  h.client = client;
  h.flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
  h.renderer = ui.render(element());
  h.update = async () => { act(() => h.renderer.update(element())); await h.flush(); };
  t.after(() => { act(() => h.renderer.unmount()); client.clear(); });
  h.hosts = (id: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id);
  h.label = () => h.hosts('ranking-slot')[0]?.props.accessibilityLabel ?? 'no slot';
  h.testIds = () => {
    const ids: string[] = [];
    const walk = (node: any) => {
      if (typeof node === 'string') return;
      if (typeof node.type === 'string' && typeof node.props.testID === 'string') ids.push(node.props.testID);
      node.children.forEach(walk);
    };
    walk(h.renderer.root);
    return ids;
  };
  // Row lookups of the slot (limit 1/2), as offset/limit/date/capturedAt/scope/type/season.
  h.sliceReads = () => h.requests.filter((params: URLSearchParams) => ['1', '2'].includes(params.get('limit') ?? ''))
    .map((params: URLSearchParams) => ['offset', 'limit', 'rankingDate', 'capturedAt', 'scope', 'rankType', 'seasonId']
      .map((name) => params.get(name) ?? '-').join('/')).sort();
  h.publicationReads = () => h.requests.filter((params: URLSearchParams) => params.get('limit') === '3').length;
  await h.flush();
  return h;
}

describe('랭킹 탭의 순위 안내 슬롯', () => {
  it('sits between 내 순위 and the tabs with the expected figures from three row reads', async (t) => {
    const h = await screenHarness(t);
    const ids = h.testIds();
    assert.equal(ids.indexOf('ranking-my-card') >= 0 && ids.indexOf('ranking-my-card') < ids.indexOf('ranking-slot'), true);
    assert.equal(ids.indexOf('ranking-slot') < ids.indexOf('ranking-tabs'), true);
    assert.equal(h.label(), FULL_LABEL);
    assert.equal(strings(h.hosts('ranking-slot-message')[0]).join('|'), SHOWN.above);
    assert.deepEqual(h.sliceReads(), [
      `0/1/${YESTERDAY}/-/all/daily/season-1`,
      `22/2/${TODAY}/${CAPTURED}/all/daily/season-1`,
      `29/1/${TODAY}/${CAPTURED}/all/daily/season-1`,
    ]);
    assert.equal(h.publicationReads(), 1, 'the publication is read once, as before');
    // Focus drives the pause.
    const slot = () => h.renderer.root.findAll((node: any) => node.type?.name === 'RankingInsightSlot')[0];
    assert.equal(slot().props.paused, false);
    h.focused = false;
    await h.update();
    assert.equal(slot().props.paused, true);
  });

  it('2위: reuses the publication rows (바로 위 and 1위 are one person, both shown) and reads only yesterday', async (t) => {
    const s = scenario();
    Object.assign(s, { myRank: 2, myTotal: '10001000.00000000', myTier: 'master' });
    const h = await screenHarness(t, s);
    assert.equal(h.label(), '순위 안내. 바로 위 demiant까지 962원. 1위 demiant까지 962원. 수익률 10%까지 999,000원. '
      + '어제보다 자산 +101,000원, 순위 33계단 상승.');
    assert.deepEqual(h.sliceReads(), [`0/1/${YESTERDAY}/-/all/daily/season-1`]);
  });

  it('keeps the last complete messages until a new set is fully read, then swaps at once; a 409 hides only its message', async (t) => {
    const s = scenario();
    const h = await screenHarness(t, s);
    assert.equal(h.label(), FULL_LABEL);
    let release!: () => void;
    s.gates.set(`29:1:${NEXT_CAPTURED}`, new Promise<void>((resolve) => { release = resolve; }));
    s.conflicts.add(`22:2:${NEXT_CAPTURED}`);
    Object.assign(s, { capturedAt: NEXT_CAPTURED, myTotal: '9956269.00000000' });
    await act(async () => {
      await h.client.invalidateQueries({ queryKey: QUERY_KEYS.ranking.list({
        scope: 'all', seasonId: 'season-1', rankType: 'daily', limit: 3, offset: 0 }) });
    });
    await h.flush();
    assert.equal(h.publicationReads(), 2);
    assert.equal(h.label(), FULL_LABEL, 'previous messages stay while the new set is read');
    release();
    await h.flush();
    assert.equal(h.label(), '순위 안내. 바로 위 hana까지 2,389원. 1위 demiant까지 45,693원. '
      + '본전까지 43,731원. 어제보다 자산 +56,269원, 순위 4계단 상승.');
    assert.equal(h.sliceReads().filter((read: string) => read.startsWith(`22/2/${TODAY}/${NEXT_CAPTURED}`)).length, 1, 'no retry of a 409');
    assert.equal(h.sliceReads().filter((read: string) => read.includes(YESTERDAY)).length, 1, "yesterday's set is read once");
    assert.equal(h.hosts('admin-diagnostic-panel').length, 0);
    assert.equal(h.hosts('ranking-item-demiant').length, 1, 'the list follows the new set as before');
  });

  it("without yesterday's set the slot has four messages and no 어제보다", async (t) => {
    const h = await screenHarness(t, Object.assign(scenario(), { yesterdaySet: false }));
    assert.equal(h.label(), '순위 안내. 바로 위 hana까지 3,389원. 1위 demiant까지 46,693원. Platinum 티어까지 17,141원. 본전까지 44,731원.');
    assert.equal(h.hosts('ranking-slot-dot-change').length, 0);
  });

  it('logs nothing unless __DEV__ is true (release builds and tests)', async (t) => {
    const debug = t.mock.method(console, 'debug', () => {});
    const h = await screenHarness(t);
    assert.equal(h.label(), FULL_LABEL);
    assert.equal(debug.mock.callCount(), 0);
  });

  it('development builds log one line per set with every reason; a failed read is fetch_failed', async (t) => {
    const target = globalThis as typeof globalThis & { __DEV__?: boolean };
    const previousDev = target.__DEV__;
    target.__DEV__ = true;
    t.after(() => { if (previousDev === undefined) delete target.__DEV__; else target.__DEV__ = previousDev; });
    const lines: string[] = [];
    t.mock.method(console, 'debug', (...args: unknown[]) => { lines.push(args.join(' ')); });
    const s = Object.assign(scenario(), { yesterdaySet: false });
    const h = await screenHarness(t, s);
    assert.deepEqual(lines, [`[ranking-insight] ${TODAY} ${CAPTURED} #31/100 above=ok first=ok tier=ok goal=ok change=no_previous_set`]);
    h.focused = false;
    await h.update();
    assert.equal(lines.length, 1, 'the same set is not logged again');
    s.conflicts.add(`22:2:${NEXT_CAPTURED}`);
    Object.assign(s, { capturedAt: NEXT_CAPTURED });
    await act(async () => {
      await h.client.invalidateQueries({ queryKey: QUERY_KEYS.ranking.list({
        scope: 'all', seasonId: 'season-1', rankType: 'daily', limit: 3, offset: 0 }) });
    });
    await h.flush();
    assert.deepEqual(lines.slice(1),
      [`[ranking-insight] ${TODAY} ${NEXT_CAPTURED} #31/100 above=ok first=ok tier=fetch_failed goal=ok change=no_previous_set`]);
  });

  it('takes no space and reads nothing when the ranking is final or over, I have not joined, or no ranking exists', async (t) => {
    const variants: Array<[string, Partial<Scenario>]> = [
      ['final (settled)', { seasonStatus: 'settled' }],
      ['ended', { seasonStatus: 'ended' }],
      ['not joined', { joined: false, myState: 'not_joined' }],
      ['my ranking pending', { myState: 'unavailable' }],
      ['no ranking', { state: 'unavailable' }],
    ];
    for (const [name, patch] of variants) {
      const h = await screenHarness(t, Object.assign(scenario(), patch));
      assert.equal(h.hosts('ranking-slot').length, 0, name);
      assert.deepEqual(h.sliceReads(), [], name);
    }
  });
});
