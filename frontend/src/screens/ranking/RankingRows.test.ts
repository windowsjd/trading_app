import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it, type TestContext } from 'node:test';
import { availableRankings } from '../../features/ranking/fixtures.ts';
import type { RankingItemDto } from '../../features/ranking/api.ts';
import { financial } from '../../theme/financialColors.ts';
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

/** A return rate patch; `null` is an unavailable rate. */
const rate = (returnRate: string | null) => ({ returnRate } as unknown as Partial<RankingItemDto>);

function person(index: number, tier: string | null, patch: Partial<RankingItemDto> = {}): RankingItemDto {
  return {
    ...availableRankings.rankings[0], rank: index + 1, seasonParticipantId: `sp-${index}`, userId: `user-${index}`,
    nickname: `trader-${index}`, profileImageUrl: null, provisionalTier: tier, finalTier: null, returnRate: '1.5',
    ...patch,
  };
}

/**
 * The real RankingScreen and ranking API module over a fixture transport. The
 * publication (limit 3) names my participant with my row's figures (`myFigures`
 * overrides them, `myState` replaces my ranking); `friends` answers its own rows.
 */
async function rowsHarness(t: TestContext, {
  rows, friends = rows, mine = null, mode = 'light', settled = false, palette = 'red_blue', fontScale = 1, myFigures, myState,
}: {
  rows: RankingItemDto[];
  friends?: RankingItemDto[];
  /** My seasonParticipantId, or null when I have not joined. */
  mine?: string | null;
  mode?: Mode;
  settled?: boolean;
  palette?: 'red_blue' | 'green_red';
  fontScale?: number;
  myFigures?: { returnRate?: string | null; totalAssetKrw?: string | null };
  myState?: 'unavailable';
}) {
  const ui = interactionHarness();
  ui.dimensions = { width: 390, height: 844, fontScale };
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
        : myState ? { state: myState, reason: 'MY_RANKING_UNAVAILABLE', message: '-' }
        : { ...availableRankings.myRanking, seasonParticipantId: mine, rank: myRow?.rank ?? 99,
          ...(myRow ? { returnRate: myRow.returnRate, totalAssetKrw: myRow.totalAssetKrw } : {}), ...myFigures,
          ...tiers(myRow ? myRow.provisionalTier : 'silver') },
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
    '../../theme/appearance': { useAppearance: () => ({ mode, financialPreference: palette, colors: {} }) },
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
        // The card's secondary text color on every tier; no halo for artwork.
        const style = flatten(name.props.style);
        assert.deepEqual([style.fontSize, style.fontWeight, style.color, style.textShadowColor ?? 'none'],
          [12, '600', semantic.secondary, 'none'], `${mode} ${tier}`);
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

  it('a row without a known tier has no tier line', async (t) => {
    const h = await rowsHarness(t, { rows: [person(0, 'master'), person(1, null), person(2, 'grandmaster')] });
    for (const index of [1, 2]) {
      assert.equal(h.has(`ranking-row-tier-user-${index}`) || h.has(`ranking-row-emblem-user-${index}`), false);
      assert.equal(h.label(`user-${index}`), '수익률 +1.5%, 총자산 999,999원');
    }
    assert.equal(h.has('ranking-row-tier-user-0'), true);
  });
});

describe('랭킹 목록 행: 일반 카드', () => {
  const tiers = [...TIERS, null, 'grandmaster'];

  it('every tier, known or not, is the same plain card in both modes, with no artwork', async (t) => {
    for (const mode of ['light', 'dark'] as const) {
      const h = await rowsHarness(t, { rows: tiers.map((tier, index) => person(index, tier)), mode });
      const styles = tiers.map((_, index) => flatten(h.node(`ranking-item-user-${index}`).props.style));
      assert.deepEqual([styles[0].backgroundColor, styles[0].borderColor, styles[0].borderWidth, styles[0].borderRadius],
        [semantic.surface, semantic.border, 1, 14], mode);
      for (const [index, style] of styles.entries()) assert.deepEqual(style, styles[0], `${mode} ${tiers[index]}`);
      assert.equal(tiers.every((_, index) => h.node(`ranking-item-user-${index}`).props.underlay === undefined), true, 'no row art');
      assert.equal(h.hostsStarting('ranking-tier-background-').length, 0, 'no tier background ids');
      // Without a joined season there is no 내 순위 art either: nothing on the screen draws SVG.
      assert.equal(h.renderer.root.findAll((node: any) => node.type === 'Svg').length, 0, 'no SVG art');
    }
  });

  it('text keeps the screen colors: no tier color or halo; the return rate takes the financial role colors', async (t) => {
    // Role tokens: the theme resolves them for the mode and the user's palette, as on every screen.
    const rates = ['7.25', '-3.5', '0', null];
    for (const mode of ['light', 'dark'] as const) {
      for (const tier of ['master', 'gold', null]) {
        const h = await rowsHarness(t, { rows: rates.map((returnRate, index) => person(index, tier, rate(returnRate))), mode });
        for (const [index, expected] of [financial.rise, financial.fall, semantic.text, semantic.text].entries()) {
          const rate = h.node(`ranking-return-user-${index}`);
          assert.equal(flatten(rate.props.style).color, expected, `${mode} ${tier} ${rates[index]}`);
          // Rank, nickname, (hidden) chip slot, tier name and total.
          for (const text of h.node(`ranking-item-user-${index}`).findAll((node: any) => node.type === 'Text')) {
            if (text === rate) continue;
            const style = flatten(text.props.style);
            assert.equal(style.textShadowColor === undefined && style.textShadowRadius === undefined, true, 'no halo');
            assert.equal([undefined, semantic.secondary].includes(style.color), true, `${mode} ${tier}: ${strings(text).join('')}`);
          }
        }
        assert.deepEqual(['+7.25%', '-3.5%', '0%', '-'].map((_, index) => strings(h.node(`ranking-return-user-${index}`)).join('')),
          ['+7.25%', '-3.5%', '0%', '-']);
      }
    }
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

  it('the chip is one solid pill on every tier (text color, surface letter); 11/700, capped at 1.3×', async (t) => {
    for (const mode of ['light', 'dark'] as const) {
      for (const tier of [...TIERS, null, 'grandmaster']) {
        const h = await rowsHarness(t, { rows: [person(0, 'master'), person(1, tier)], mine: 'sp-1', mode });
        const chip = h.node('ranking-me-chip');
        const text = chip.findAll((node: any) => node.type === 'Text')[0];
        const ink = flatten(text.props.style);
        assert.deepEqual(
          [flatten(chip.props.style).backgroundColor, ink.color, ink.fontSize, ink.fontWeight, text.props.maxFontSizeMultiplier],
          [semantic.text, semantic.surface, 11, '700', 1.3], `${mode} ${tier}`);
        assert.equal(ink.textShadowColor === undefined, true, 'no halo on the solid pill');
      }
    }
  });

  it('the ring sits 3 outside the card on every tier, 2 wide, concentric, colored by mode, without moving the row', async (t) => {
    for (const [mode, color] of [['light', '#B8860B'], ['dark', '#F2C14E']] as const) {
      for (const tier of ['master', 'gold', null]) {
        const h = await rowsHarness(t, { rows: [person(0, 'master'), person(1, tier)], mine: 'sp-1', mode });
        const ring = flatten(h.node('ranking-me-ring').props.style);
        // Absolute offsets start inside the card's 1px border, so it is added back.
        assert.equal(flatten(h.node('ranking-item-user-1').props.style).borderWidth, 1);
        assert.deepEqual([ring.position, ring.top, ring.left, ring.right, ring.bottom], ['absolute', -6, -6, -6, -6], `${mode} ${tier}`);
        assert.deepEqual([ring.borderWidth, ring.borderRadius, ring.borderColor], [2, 19, color], `${mode} ${tier}`);
        assert.equal(ring.backgroundColor === undefined, true, 'the card shows through');
        // The row's own style is the same as anyone's: no margin, padding or size change.
        const others = await rowsHarness(t, { rows: [person(0, 'master'), person(1, tier)], mine: 'sp-9', mode });
        assert.deepEqual(flatten(h.node('ranking-item-user-1').props.style), flatten(others.node('ranking-item-user-1').props.style));
      }
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

describe('내 순위 카드: 왼쪽 정보, 오른쪽 티어 엠블럼', () => {
  const rows = TIERS.map((tier, index) => person(index, tier));
  const text = (h: any, id: string) => strings(h.node(id)).join('');
  /** The left column's three groups and the card's two columns, in render order. */
  const layout = (h: any) => {
    const figures = h.node('ranking-my-figures');
    const column = hostParent(figures);
    const card = h.node('ranking-my-card');
    const has = (node: any, id: string) => node.findAll((child: any) => child.props.testID === id).length > 0;
    const emblem = h.hostsStarting('home-emblem-')[0];
    return {
      groups: column.children.map((group: any) => has(group, 'ranking-my-avatar') ? 'profile'
        : has(group, 'ranking-my-rank') ? 'rank' : group === figures ? 'figures' : 'other'),
      rankGroup: strings(hostParent(h.node('ranking-my-rank'))),
      figures: figures.children.map((pair: any) => strings(pair)),
      // Info is TierCard's left column; the emblem column holds the emblem and the tier name.
      columns: card.children.filter((child: any) => typeof child.type === 'string')
        .map((child: any) => child === hostParent(column) ? 'info' : emblem && has(child, emblem.props.testID) ? 'emblem' : 'other'),
      emblemColumn: emblem ? hostParent(emblem) : null,
      leftTexts: column.findAll((node: any) => node.type === 'Text'),
      // Every box of the column: how it places its content horizontally.
      boxes: [column, ...column.findAll((node: any) => node.type === 'View')].map((node: any) => {
        const style = flatten(node.props.style);
        return { direction: style.flexDirection ?? 'column', main: style.justifyContent, cross: style.alignItems };
      }),
    };
  };

  it('reads top to bottom on the left: profile, 내 순위 and the rank, then 수익률 and 총자산; the emblem and tier name on the right', async (t) => {
    for (const mode of ['light', 'dark'] as const) {
      const h = await rowsHarness(t, { rows, mine: 'sp-2', mode, myFigures: { returnRate: '4.5', totalAssetKrw: '10450000.00000000' } });
      const card = layout(h);
      assert.deepEqual(card.groups, ['profile', 'rank', 'figures'], mode);
      assert.deepEqual(card.rankGroup, ['내 순위', '#3']);
      assert.deepEqual(card.figures, [['수익률', '+4.5%'], ['총자산', '10,450,000원']]);
      assert.deepEqual(card.columns, ['info', 'emblem'], 'two columns: information, then the emblem');
      assert.equal(card.emblemColumn.findAll((node: any) => node.props.testID === 'ranking-my-tier').length > 0, true);
      assert.deepEqual([text(h, 'ranking-my-tier'), h.hostsStarting('home-emblem-').length, h.has('home-emblem-gold')], ['Gold', 1, true]);
      assert.equal(h.has(`home-tier-background-gold-${mode}`), true, "the tier's card art stays");
      // Left aligned: nothing in the information column is centered or pushed right.
      assert.equal(card.leftTexts.every((node: any) => [undefined, 'left'].includes(flatten(node.props.style).textAlign)), true);
      assert.deepEqual(card.boxes.filter(({ direction, main, cross }: any) => direction === 'row'
        ? ![undefined, 'flex-start'].includes(main) : ![undefined, 'stretch', 'flex-start'].includes(cross)).length, 0);
      assert.equal(h.node('ranking-my-avatar').props.size, 36);
      assert.equal(strings(hostParent(h.node('ranking-my-avatar'))).join(''), 'me');
    }
  });

  it("shows my ranking row's figures in the list's words, for the daily and the final ranking", async (t) => {
    const h = await rowsHarness(t, { rows, mine: 'sp-2' });
    // Without an override my row and my card read the same response fields.
    assert.deepEqual([text(h, 'ranking-my-return'), text(h, 'ranking-my-total')],
      [text(h, 'ranking-return-user-2'), text(h, 'ranking-total-user-2')]);
    assert.deepEqual([text(h, 'ranking-my-return'), text(h, 'ranking-my-total')], ['+1.5%', '999,999원']);
    for (const settled of [false, true]) {
      const final = await rowsHarness(t, { rows, mine: 'sp-3', settled, myFigures: {
        returnRate: '-12.34560000', totalAssetKrw: '1234567890123456.00000000' } });
      assert.deepEqual([text(final, 'ranking-my-return'), text(final, 'ranking-my-total')], ['-12.35%', '1,234,567,890,123,456원']);
      const figures = final.node('ranking-my-figures');
      assert.deepEqual([figures.props.accessible, figures.props.accessibilityLabel], [true, '수익률 -12.35%, 총자산 1,234,567,890,123,456원']);
      assert.deepEqual([final.has('ranking-my-settled'), text(final, 'ranking-my-rank'), text(final, 'ranking-my-tier')],
        [settled, '#4', 'Platinum'], settled ? 'final' : 'daily');
      if (settled) assert.deepEqual(layout(final).rankGroup, ['내 순위', '#4', '최종 랭킹 확정']);
    }
  });

  it('never invents figures: unavailable values read "-", and other states keep their own cards without figures', async (t) => {
    const missing = await rowsHarness(t, { rows, mine: 'sp-2', myFigures: { returnRate: null, totalAssetKrw: null } });
    assert.deepEqual([text(missing, 'ranking-my-return'), text(missing, 'ranking-my-total')], ['-', '-']);
    assert.equal(missing.node('ranking-my-figures').props.accessibilityLabel, '수익률 -, 총자산 -');
    const notJoined = await rowsHarness(t, { rows });
    const pending = await rowsHarness(t, { rows, mine: 'sp-2', myState: 'unavailable' });
    for (const [h, words] of [[notJoined, '아직 이번 시즌에 참가하지 않았습니다.'], [pending, '내 랭킹 생성 대기 중입니다.']] as const) {
      assert.equal(h.renderer.root.findAll((node: any) => node.type === 'Text' && strings(node).join('') === words).length > 0, true);
      assert.equal(h.has('ranking-my-figures') || h.has('ranking-my-return') || h.has('ranking-my-total'), false, words);
    }
  });

  it('an unknown tier keeps the same column on the plain card, in the role colors', async (t) => {
    for (const tier of [null, 'grandmaster']) {
      for (const [returnRate, expected] of [['4.5', financial.rise], ['-3', financial.fall], ['0', semantic.text], [null, semantic.text]] as const) {
        const h = await rowsHarness(t, { rows: [person(0, 'master'), person(1, tier, rate(returnRate))], mine: 'sp-1' });
        const card = layout(h);
        assert.deepEqual([card.groups, card.figures.map((pair: string[]) => pair[0])], [['profile', 'rank', 'figures'], ['수익률', '총자산']]);
        assert.deepEqual([h.hostsStarting('home-emblem-').length, h.hostsStarting('home-tier-background-').length], [0, 0]);
        assert.deepEqual([flatten(h.node('ranking-my-card').props.style).backgroundColor, flatten(h.node('ranking-my-return').props.style).color],
          [semantic.surface, expected], `${tier} ${returnRate}`);
        assert.equal(flatten(h.node('ranking-my-total').props.style).color, undefined, 'the text color');
      }
    }
  });

  it("on tier art the rate keeps the user's direction hue (shaded for the art); zero and unavailable take the tier's foreground", async (t) => {
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const dominant = (hex: string) => ['red', 'green', 'blue'][rgb(hex).indexOf(Math.max(...rgb(hex)))];
    const hues = { red_blue: { up: 'red', down: 'blue' }, green_red: { up: 'green', down: 'red' } } as const;
    for (const palette of ['red_blue', 'green_red'] as const) {
      for (const mode of ['light', 'dark'] as const) {
        for (const tier of TIERS) {
          // Zero and unavailable do not depend on the palette.
          const cases = [['4.5', 'up'], ['-3', 'down'], ...(palette === 'red_blue' ? [['0', null], [null, null]] : [])] as const;
          for (const [returnRate, direction] of cases) {
            const h = await rowsHarness(t, { rows: [person(0, 'master'), person(1, tier, rate(returnRate))], mine: 'sp-1', mode, palette });
            const foreground = h.tierForeground(getHomeTier(tier, mode), mode);
            const ink = flatten(h.node('ranking-my-return').props.style);
            const where = `${palette} ${mode} ${tier} ${returnRate}`;
            if (direction) assert.equal(dominant(ink.color), hues[palette][direction], where);
            else assert.equal(ink.color, foreground.color, where);
            // The same halo as the card's other text on this art.
            assert.equal(ink.textShadowColor ?? 'none', foreground.textShadowColor ?? 'none', where);
            assert.deepEqual([flatten(h.node('ranking-my-total').props.style).color, flatten(h.node('ranking-my-rank').props.style).color],
              [foreground.color, foreground.color], where);
          }
        }
      }
    }
  });

  it('large text keeps the emblem above the information (TierCard), in the same order', async (t) => {
    const h = await rowsHarness(t, { rows, mine: 'sp-2', fontScale: 2 });
    const card = layout(h);
    assert.deepEqual([card.columns, card.groups], [['emblem', 'info'], ['profile', 'rank', 'figures']]);
    const figure = flatten(h.node('ranking-my-figures').children[0].props.style);
    // A value wraps under its label rather than past the card.
    assert.deepEqual([figure.flexDirection, figure.flexWrap, flatten(h.node('ranking-my-total').props.style).flexShrink], ['row', 'wrap', 1]);
  });

  it('최종 랭킹 확정 sits under the rank; on Whale in Light (dark art) it takes the foreground instead of the error red', async (t) => {
    for (const mode of ['light', 'dark'] as const) {
      for (const tier of TIERS) {
        const h = await rowsHarness(t, { rows: [person(0, 'master'), person(1, tier)], mine: 'sp-1', mode, settled: true });
        const settled = flatten(h.node('ranking-my-settled').props.style);
        const foreground = h.tierForeground(getHomeTier(tier, mode), mode);
        assert.deepEqual([settled.color, settled.fontWeight], [tier === 'master' && mode === 'light' ? foreground.color : semantic.error, '800'],
          `${mode} ${tier}`);
      }
    }
  });
});
