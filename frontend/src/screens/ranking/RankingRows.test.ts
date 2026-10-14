import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it, type TestContext } from 'node:test';
import { availableRankings } from '../../features/ranking/fixtures.ts';
import type { RankingItemDto } from '../../features/ranking/api.ts';
import { semantic } from '../../theme/tokens.ts';
import { getHomeTier } from '../home/tierPresentation.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const query = require('@tanstack/react-query');

type Mode = 'light' | 'dark';
const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master'] as const;
const strings = (node: any): string[] =>
  node.children.flatMap((child: any) => (typeof child === 'string' ? [child] : strings(child)));
const hidden = (node: any) => node.props.accessibilityElementsHidden === true
  && node.props.importantForAccessibility === 'no-hide-descendants' && node.props['aria-hidden'] === true;
const hostParent = (node: any) => {
  let parent = node.parent;
  while (parent && typeof parent.type !== 'string') parent = parent.parent;
  return parent;
};

function person(index: number, tier: string | null, patch: Partial<RankingItemDto> = {}): RankingItemDto {
  return {
    ...availableRankings.rankings[0], rank: index + 1, seasonParticipantId: `sp-${index}`, userId: `user-${index}`,
    nickname: `trader-${index}`, profileImageUrl: null, provisionalTier: tier, finalTier: null, returnRate: '1.5',
    ...patch,
  };
}

/**
 * The real RankingScreen and ranking API module over a fixture transport. The
 * publication (limit 3) names my participant; `friends` answers its own rows.
 */
async function rowsHarness(t: TestContext, { rows, friends = rows, mine = null, mode = 'light', settled = false }: {
  rows: RankingItemDto[];
  friends?: RankingItemDto[];
  /** My seasonParticipantId, or null when I have not joined. */
  mine?: string | null;
  mode?: Mode;
  settled?: boolean;
}) {
  const ui = interactionHarness();
  ui.dimensions = { width: 390, height: 844, fontScale: 1 };
  ui.native.AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const rankType = settled ? 'final' : 'daily';
  const tiers = (tier: string | null) => settled ? { provisionalTier: null, finalTier: tier } : { provisionalTier: tier, finalTier: null };
  const shape = (item: RankingItemDto) => ({ ...item, ...tiers(item.provisionalTier ?? item.finalTier) });
  const myRow = rows.find((item) => item.seasonParticipantId === mine);
  const answer = (params: URLSearchParams) => {
    const list = (params.get('scope') === 'friends' ? friends : rows).map(shape);
    const limit = Number(params.get('limit'));
    return {
      ...structuredClone(availableRankings), rankType,
      season: { ...availableRankings.season, status: settled ? 'settled' : 'active' },
      rankings: list.slice(0, limit),
      pagination: { limit, offset: 0, total: list.length, returned: Math.min(limit, list.length), nextOffset: null },
      myRanking: mine === null
        ? { state: 'not_joined', reason: 'SEASON_NOT_JOINED', message: '-' }
        : { ...availableRankings.myRanking, seasonParticipantId: mine, rank: myRow?.rank ?? 99,
          ...tiers(myRow?.provisionalTier ?? 'silver') },
    };
  };
  const transport = { apiClient: { get: async (path: string) => {
    const url = new URL(path, 'https://fixture.invalid');
    if (url.pathname !== '/ranking') throw new Error(`Unexpected read ${path}`);
    return { data: { success: true, data: answer(url.searchParams) } };
  } } };
  const api = ui.load('src/features/ranking/api.ts', { '../../services/api/client': transport });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const Screen = ui.load('src/screens/ranking/RankingScreen.tsx', {
    'react-native': { ...ui.native, SafeAreaView: 'SafeAreaView',
      FlatList: ({ ListHeaderComponent, ListEmptyComponent, data, renderItem }: any) =>
        React.createElement('List', null, ListHeaderComponent,
          data.length ? data.map((item: any) => React.createElement(React.Fragment, { key: item.seasonParticipantId }, renderItem({ item })))
            : ListEmptyComponent),
    },
    '@tanstack/react-query': query,
    '../../features/ranking/api': api,
    '../../features/season/api': { getCurrentSeason: async () => ({ ...availableRankings.season,
      status: settled ? 'settled' : 'active', joined: mine !== null, initialCapitalKrw: '1000000' }) },
    '../../features/me/api': { getMe: async () => ({ nickname: 'me', profileImageUrl: null }) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate() {} }) },
    '@react-navigation/native': { useIsFocused: () => true },
    '../../theme/appearance': { useAppearance: () => ({ mode, financialPreference: 'red_blue', colors: {} }) },
  }).default;
  const { tierForeground } = ui.load('src/screens/home/TierCard.tsx');
  const h: any = { ui, tierForeground };
  h.renderer = ui.render(React.createElement(query.QueryClientProvider, { client },
    React.createElement(Screen, { navigation: { navigate() {} } })));
  h.flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
  t.after(() => { act(() => h.renderer.unmount()); client.clear(); });
  h.hosts = (id: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id);
  h.hostsStarting = (prefix: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string'
    && typeof node.props.testID === 'string' && node.props.testID.startsWith(prefix));
  h.has = (id: string) => h.hosts(id).length > 0;
  h.node = (id: string) => h.hosts(id)[0];
  h.label = (userId: string) => h.node(`ranking-figures-${userId}`).props.accessibilityLabel;
  await h.flush();
  return h;
}

describe('랭킹 목록 행: 티어 줄', () => {
  it('every known tier gets an emblem and its name under the nickname, in its own ids, hidden from screen readers', async (t) => {
    for (const mode of ['light', 'dark'] as const) {
      const h = await rowsHarness(t, { rows: TIERS.map((tier, index) => person(index, tier)), mode });
      const slots: string[] = [];
      for (const [index, tier] of TIERS.entries()) {
        const presentation = getHomeTier(tier, mode)!;
        const line = h.node(`ranking-row-tier-user-${index}`);
        const name = line.findAll((node: any) => node.type === 'Text')[0];
        assert.equal(strings(line).join(''), tier === 'master' ? 'Whale' : presentation.name, `${mode} ${tier}`);
        assert.equal(hidden(line), true, 'the figures label already names the tier');
        const emblem = h.node(`ranking-row-emblem-user-${index}`);
        assert.equal(line.findAll((node: any) => node === emblem).length, 1, 'the emblem sits on the tier line');
        assert.equal(h.has(`ranking-row-emblem-image-user-${index}`), true);
        // Same color and halo as the row's other text on this tier.
        const foreground = h.tierForeground(presentation, mode);
        const style = flatten(name.props.style);
        assert.deepEqual([style.fontSize, style.fontWeight, style.color, style.textShadowColor ?? 'none'],
          [12, '600', foreground.color, foreground.textShadowColor ?? 'none'], `${mode} ${tier}`);
        // One fixed slot: the tier line is as tall on every tier, names start at one x.
        const slot = flatten(hostParent(emblem).props.style);
        const box = flatten(emblem.props.style);
        assert.equal(box.width <= slot.width && box.height <= slot.height, true, `${tier} fits its slot`);
        slots.push(`${slot.width}x${slot.height}`);
        assert.equal(h.node(`ranking-avatar-user-${index}`).props.size, 40);
      }
      assert.equal(new Set(slots).size, 1, 'one slot size for all six tiers');
      assert.equal(h.hostsStarting('home-emblem-').length + h.hostsStarting('home-tier-image').length, 0,
        'no Home emblem ids in rows (and no 내 순위 card emblem without a joined season)');
      assert.equal(h.has('ranking-me-chip') || h.has('ranking-me-ring'), false);
    }
  });

  it('a row without a known tier has no tier line and no artwork', async (t) => {
    const h = await rowsHarness(t, { rows: [person(0, 'master'), person(1, null), person(2, 'grandmaster')] });
    for (const index of [1, 2]) {
      assert.equal(h.has(`ranking-row-tier-user-${index}`) || h.has(`ranking-row-emblem-user-${index}`), false);
      assert.equal(h.node(`ranking-item-user-${index}`).props.underlay === null, true, 'the plain card stays');
      assert.equal(h.label(`user-${index}`), '수익률 +1.5%, 총자산 999,999원');
    }
    assert.equal(h.has('ranking-row-tier-user-0'), true);
  });
});

describe('랭킹 목록 행: 내 행', () => {
  const rows = TIERS.map((tier, index) => person(index, tier));

  it('only my row gets one 나 chip, one ring and a label starting with 내 순위; other labels are unchanged', async (t) => {
    const others = await rowsHarness(t, { rows, mine: 'sp-99' });
    const h = await rowsHarness(t, { rows, mine: 'sp-2' });
    assert.equal(h.hosts('ranking-me-chip').length, 1);
    assert.equal(h.hosts('ranking-me-ring').length, 1);
    const myRow = h.node('ranking-item-user-2');
    assert.equal(myRow.findAll((node: any) => node.props.testID === 'ranking-me-chip' && typeof node.type === 'string').length, 1);
    assert.equal(myRow.findAll((node: any) => node.props.testID === 'ranking-me-ring' && typeof node.type === 'string').length, 1);
    for (const [index] of TIERS.entries()) {
      const label = others.label(`user-${index}`);
      assert.equal(h.label(`user-${index}`), index === 2 ? `내 순위, ${label}` : label);
    }
    assert.equal(h.label('user-2'), '내 순위, Gold 티어, 수익률 +1.5%, 총자산 999,999원');
    // The chip and the ring are decoration: hidden from screen readers, the ring never takes a touch.
    assert.equal(hidden(h.node('ranking-me-chip')) && hidden(h.node('ranking-me-ring')), true);
    assert.equal(h.node('ranking-me-ring').props.pointerEvents, 'none');
    assert.equal(strings(h.node('ranking-me-chip')).join(''), '나');
    // Every row keeps the chip's slot: invisible, unnamed and hidden elsewhere, so marking mine reflows nothing.
    const slotLineOf = (index: number) => {
      const name = h.node(`ranking-item-user-${index}`).findAll((node: any) => node.type === 'Text'
        && strings(node).join('') === `trader-${index}`)[0];
      return hostParent(name).children.find((child: any) => child.type === 'View');
    };
    const slotOf = (index: number) => slotLineOf(index).children[0];
    for (const index of [0, 1, 3, 4, 5]) {
      const slot = slotOf(index);
      assert.deepEqual([flatten(slot.props.style).opacity, slot.props.testID === undefined, hidden(slot), strings(slot).join('')],
        [0, true, true, '나'], `row ${index}`);
      // The same box as my chip's: it takes the same room on the nickname line.
      assert.deepEqual(flatten(slotLineOf(index).props.style), flatten(slotLineOf(2).props.style), `row ${index}`);
      const { backgroundColor: _mine, ...myBox } = flatten(slotOf(2).props.style);
      const { opacity: _hidden, ...box } = flatten(slot.props.style);
      assert.deepEqual(box, myBox, `row ${index}`);
    }
    assert.deepEqual([slotOf(2).props.testID, flatten(slotOf(2).props.style).opacity === undefined], ['ranking-me-chip', true]);
  });

  it('the chip inverts the tier colors (text/surface for an unknown tier); 11/700, capped at 1.3×', async (t) => {
    for (const mode of ['light', 'dark'] as const) {
      for (const tier of [...TIERS, null, 'grandmaster']) {
        const h = await rowsHarness(t, { rows: [person(0, 'master'), person(1, tier)], mine: 'sp-1', mode });
        const presentation = getHomeTier(tier, mode);
        const chip = h.node('ranking-me-chip');
        const text = chip.findAll((node: any) => node.type === 'Text')[0];
        const ink = flatten(text.props.style);
        assert.deepEqual(
          [flatten(chip.props.style).backgroundColor, ink.color, ink.fontSize, ink.fontWeight, text.props.maxFontSizeMultiplier],
          [presentation?.palette.color ?? semantic.text, presentation?.palette.backgroundColor ?? semantic.surface, 11, '700', 1.3],
          `${mode} ${tier}`);
        assert.equal(ink.textShadowColor === undefined, true, 'no halo on the solid pill');
      }
    }
  });

  it('the ring sits 3 outside the card, 2 wide, concentric, colored by mode, without moving the row', async (t) => {
    for (const [mode, color] of [['light', '#B8860B'], ['dark', '#F2C14E']] as const) {
      const art = await rowsHarness(t, { rows: [person(0, 'master'), person(1, 'gold')], mine: 'sp-1', mode });
      const plain = await rowsHarness(t, { rows: [person(0, 'master'), person(1, null)], mine: 'sp-1', mode });
      const ring = (h: any) => flatten(h.node('ranking-me-ring').props.style);
      // Absolute offsets start inside the border: the plain card's 1px border is added back.
      assert.deepEqual([ring(art).position, ring(art).top, ring(art).left, ring(art).right, ring(art).bottom],
        ['absolute', -5, -5, -5, -5]);
      assert.deepEqual([ring(plain).top, ring(plain).left, ring(plain).right, ring(plain).bottom], [-6, -6, -6, -6]);
      assert.equal(flatten(plain.node('ranking-item-user-1').props.style).borderWidth, 1);
      for (const h of [art, plain]) {
        assert.deepEqual([ring(h).borderWidth, ring(h).borderRadius, ring(h).borderColor], [2, 19, color], mode);
        assert.equal(ring(h).backgroundColor === undefined, true, 'the card shows through');
      }
      // The row's own style is the same as anyone's: no margin, padding or size change.
      const others = await rowsHarness(t, { rows: [person(0, 'master'), person(1, 'gold')], mine: 'sp-9', mode });
      assert.deepEqual(flatten(art.node('ranking-item-user-1').props.style), flatten(others.node('ranking-item-user-1').props.style));
    }
  });

  it('a list without my row (friends) shows no chip or ring; the final ranking still finds my row', async (t) => {
    const h = await rowsHarness(t, { rows, friends: [rows[0], rows[4]], mine: 'sp-2' });
    assert.equal(h.has('ranking-me-chip'), true);
    await act(async () => h.node('ranking-tab-friends').props.onPress());
    await h.flush();
    assert.equal(h.has('ranking-item-user-4'), true);
    assert.equal(h.has('ranking-item-user-2') || h.has('ranking-me-chip') || h.has('ranking-me-ring'), false);
    assert.equal(h.label('user-4').startsWith('내 순위'), false);

    const settled = await rowsHarness(t, { rows, mine: 'sp-3', settled: true });
    assert.equal(settled.hosts('ranking-me-chip').length, 1);
    assert.equal(settled.node('ranking-item-user-3').findAll((node: any) => node.props.testID === 'ranking-me-ring').length > 0, true);
    assert.equal(settled.label('user-3'), '내 순위, Platinum 티어, 수익률 +1.5%, 총자산 999,999원');
    assert.equal(strings(settled.node('ranking-row-tier-user-3')).join(''), 'Platinum', 'the final tier is shown');
  });

  it('keeps the chip with a long nickname: the nickname shrinks and wraps, the chip never does', async (t) => {
    const nickname = '아주긴닉네임LongNickname'.repeat(8);
    const h = await rowsHarness(t, { rows: [person(0, 'master'), person(1, 'silver', { nickname })], mine: 'sp-1' });
    const chipLine = hostParent(h.node('ranking-me-chip'));
    const nameLine = hostParent(chipLine);
    const name = nameLine.children.find((child: any) => child.type === 'Text');
    assert.equal(strings(name).join(''), nickname);
    assert.equal(name.props.numberOfLines === undefined, true, 'no line limit on the nickname');
    assert.deepEqual([flatten(name.props.style).flexShrink, flatten(chipLine.props.style).flexShrink], [1, 0]);
    assert.equal(flatten(nameLine.props.style).flexDirection, 'row', 'the chip ends the nickname line');
    assert.equal(nameLine.children.at(-1) === chipLine, true);
    // The chip sits on the nickname's first line: its slot is one (scaled) nickname line tall.
    assert.deepEqual([flatten(nameLine.props.style).alignItems, flatten(chipLine.props.style).height,
      flatten(name.props.style).lineHeight], ['flex-start', 22, 22]);
  });
});
