import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it, type TestContext } from 'node:test';
import { availableRankings } from '../../features/ranking/fixtures.ts';
import type { RankingItemDto } from '../../features/ranking/api.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { financial } from '../../theme/financialColors.ts';
import { semantic } from '../../theme/tokens.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const query = require('@tanstack/react-query');

const strings = (node: any): string[] =>
  node.children.flatMap((child: any) => (typeof child === 'string' ? [child] : strings(child)));

/**
 * The real RankingScreen and ranking API module over a fixture server that
 * honours `offset`, `limit` and `anchor=me` the way RankingService does:
 * hidden participants are left out of the public list (their ranks leave
 * gaps), and a pinned `capturedAt` of an older set is refused. The FlatList
 * stand-in renders every row and records the scroll calls the screen makes.
 */
async function harness(t: TestContext, { total, mine = null, hidden = [] }: {
  total: number;
  /** My rank, or null when I have no ranking row (not joined). */
  mine?: number | null;
  /** Ranks of participants hidden from the public list. */
  hidden?: number[];
}) {
  const ui = interactionHarness();
  ui.dimensions = { width: 390, height: 844, fontScale: 1 };
  ui.native.AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const h: any = { reads: [] as URLSearchParams[], scrolls: [] as unknown[][], generation: 1 };
  const capturedAt = () => `2026-05-07T00:1${h.generation}:00.000Z`;
  const person = (rank: number): RankingItemDto => ({
    ...availableRankings.rankings[0], rank, seasonParticipantId: `sp-${rank}`, userId: `user-${rank}`,
    nickname: `trader-${rank}`, profileImageUrl: null, provisionalTier: rank <= 3 ? 'master' : 'silver', finalTier: null,
    returnRate: rank === 2 ? '-0.45' : '1.5', capturedAt: capturedAt(),
  });
  const everyone = Array.from({ length: total }, (_, index) => person(index + 1));
  const publicRows = () => everyone.filter((row) => !hidden.includes(row.rank)).map((row) => ({ ...row, capturedAt: capturedAt() }));
  const answer = (params: URLSearchParams) => {
    if (params.get('capturedAt') && params.get('capturedAt') !== capturedAt()) {
      throw Object.assign(new Error('changed'), { response: { status: 409, data: { success: false, error: { code: 'RANKING_SNAPSHOT_CHANGED' } } } });
    }
    const rows = publicRows();
    const scope = params.get('scope');
    const limit = Number(params.get('limit'));
    const myIndex = mine === null ? -1 : rows.findIndex((row) => row.rank === mine);
    let offset = Number(params.get('offset'));
    if (params.get('anchor') === 'me' && myIndex >= 0) offset = myIndex;
    const list = scope === 'friends' ? rows.slice(0, 2) : scope === 'top10' ? rows.slice(0, 10) : rows;
    const page = list.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      ...structuredClone(availableRankings), capturedAt: capturedAt(),
      season: { ...availableRankings.season, status: 'active' },
      rankings: page,
      pagination: { limit, offset, total: list.length, returned: page.length, nextOffset: next < list.length ? next : null },
      myRanking: myIndex >= 0
        ? { ...availableRankings.myRanking, rank: mine, seasonParticipantId: `sp-${mine}`, returnRate: '1.5', provisionalTier: 'silver', capturedAt: capturedAt() }
        : { state: 'not_joined', reason: 'SEASON_NOT_JOINED', message: '-' },
    };
  };
  const transport = { apiClient: { get: async (path: string) => {
    const url = new URL(path, 'https://fixture.invalid');
    if (url.pathname !== '/ranking') throw new Error(`Unexpected read ${path}`);
    h.reads.push(url.searchParams);
    return { data: { success: true, data: answer(url.searchParams) } };
  } } };
  const api = ui.load('src/features/ranking/api.ts', { '../../services/api/client': transport });
  h.client = new query.QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const fakeList = {
    scrollToOffset: ({ offset }: { offset: number }) => h.scrolls.push(['offset', offset]),
    scrollToEnd: () => h.scrolls.push(['end']),
  };
  const Screen = ui.load('src/screens/ranking/RankingScreen.tsx', {
    'react-native': { ...ui.native, SafeAreaView: 'SafeAreaView',
      FlatList: (props: any) => {
        h.list = props;
        if (props.ref) props.ref.current = fakeList;
        return React.createElement('List', { testID: props.testID }, props.ListHeaderComponent,
          props.data.length ? props.data.map((item: any) => React.createElement(React.Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item })))
            : props.ListEmptyComponent, props.ListFooterComponent);
      },
    },
    '@tanstack/react-query': query,
    '../../features/ranking/api': api,
    // 순위 안내 has its own suites; here it reads nothing.
    '../../features/ranking/useRankingInsights': { useRankingInsights: () => [] },
    '../../features/season/api': { getCurrentSeason: async () => ({ ...availableRankings.season, status: 'active', joined: mine !== null, initialCapitalKrw: '1000000' }) },
    '../../features/me/api': { getMe: async () => ({ nickname: 'me', profileImageUrl: null }) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate() {} }) },
    '@react-navigation/native': { useIsFocused: () => true },
    '../../theme/appearance': { useAppearance: () => ({ mode: 'light', financialPreference: 'red_blue', colors: {} }) },
  }).default;
  h.renderer = ui.render(React.createElement(query.QueryClientProvider, { client: h.client },
    React.createElement(Screen, { navigation: { navigate() {} } })));
  h.flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
  t.after(() => { act(() => h.renderer.unmount()); h.client.clear(); });
  h.hosts = (id: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id);
  h.node = (id: string) => h.hosts(id)[0];
  h.has = (id: string) => h.hosts(id).length > 0;
  h.text = (id: string) => strings(h.node(id)).join('');
  // List reads only (the publication is the scope=all, limit=3 read).
  h.listReads = () => h.reads.filter((params: URLSearchParams) => !(params.get('scope') === 'all' && params.get('limit') === '3'));
  h.publicationReads = () => h.reads.length - h.listReads().length;
  h.ranks = () => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && /^ranking-item-user-\d+$/.test(node.props.testID ?? ''))
    .map((node: any) => Number(node.props.testID.replace('ranking-item-user-', '')));
  h.header = async (height: number) => { await act(async () => h.list.ListHeaderComponent.props.onLayout({ nativeEvent: { layout: { height } } })); };
  h.content = async (height: number) => { await act(async () => h.list.onContentSizeChange(390, height)); };
  h.scroll = async (y: number, height: number, content: number) => {
    await act(async () => h.list.onScroll({ nativeEvent: { contentOffset: { y }, layoutMeasurement: { height }, contentSize: { height: content } } }));
  };
  h.jump = (direction: 'top' | 'bottom') => h.renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === `ranking-jump-${direction}`)[0];
  h.press = async (direction: 'top' | 'bottom') => { await act(async () => h.jump(direction).props.onPress?.()); await h.flush(); };
  h.tab = async (key: 'all' | 'friends' | 'top10') => { await act(async () => h.node(`ranking-tab-${key}`).props.onPress()); await h.flush(); };
  await h.flush();
  return h;
}

const contiguous = (ranks: number[], from: number, to: number) =>
  ranks.length === to - from + 1 && ranks.every((rank, index) => rank === from + index);

describe('전체 탭: 내 순위에서 시작', () => {
  it('opens at my row (650 of 1,000) without reading the 649 rows above it first', async (t) => {
    const h = await harness(t, { total: 1000, mine: 650 });
    let reads = h.listReads();
    assert.equal(reads.length, 1);
    assert.deepEqual([reads[0].get('scope'), reads[0].get('anchor'), reads[0].get('limit')], ['all', 'me', '50']);
    assert.equal(contiguous(h.ranks(), 650, 699), true, 'my row is the first row of the list');
    assert.equal(h.has('ranking-me-ring'), true);
    assert.deepEqual(h.list.maintainVisibleContentPosition, { minIndexForVisible: 0 });
    // Nothing above loads before my row is placed.
    await h.scroll(0, 700, 4000);
    await h.flush();
    assert.equal(h.listReads().length, 1);

    // Laid out: my row moves to the top of the screen (the header scrolls away), then the page above loads.
    await h.header(500);
    await h.content(4000);
    assert.deepEqual(h.scrolls, [['offset', 16 + 500 - 8]]);
    await h.flush();
    reads = h.listReads();
    assert.equal(reads.length, 2);
    assert.deepEqual([reads[1].get('offset'), reads[1].get('limit'), reads[1].has('anchor')], ['599', '50', false]);
    assert.equal(reads[1].get('capturedAt'), reads[0].get('capturedAt') ?? h.reads[0].get('capturedAt'));
    assert.equal(contiguous(h.ranks(), 600, 699), true, 'ascending, no gap or duplicate');

    // The rows in view were kept in place natively (the list now sits ~50 rows lower): scrolling up to
    // within two screens of the loaded top asks for one more page above — once, until scrolled up again.
    await h.scroll(4800, 700, 9000);
    await h.scroll(1300, 700, 9000);
    await h.scroll(1300, 700, 9000);
    await h.flush();
    reads = h.listReads();
    assert.equal(reads.length, 3, 'one page at a time');
    assert.deepEqual([reads[2].get('offset'), reads[2].get('limit')], ['549', '50']);
    assert.equal(contiguous(h.ranks(), 550, 699), true);
    // Where the list could not keep its place, it would still be near the top: no page without a new upward scroll.
    await h.scroll(1300, 700, 13000);
    await h.flush();
    assert.equal(h.listReads().length, 3, 'no reading upward on its own');
    await h.scroll(1200, 700, 13000);
    await h.flush();
    assert.deepEqual(h.listReads().map((params: URLSearchParams) => params.get('offset')).slice(-1), ['499']);
    assert.equal(h.listReads().every((params: URLSearchParams) => params.get('anchor') === 'me' || Number(params.get('offset')) >= 499), true,
      'nothing above the loaded stretch was read');
  });

  it('starts at my public position, not rank − 1, when participants above me are hidden', async (t) => {
    const h = await harness(t, { total: 1000, mine: 650, hidden: [3, 100, 200] });
    assert.equal(h.ranks()[0], 650);
    await h.header(500);
    await h.content(4000);
    await h.flush();
    const above = h.listReads()[1];
    // My row is the 647th public row (offset 646, where rank − 1 would say 649): the page above is 596–645.
    assert.deepEqual([above.get('offset'), above.get('limit')], ['596', '50']);
    const ranks = h.ranks();
    assert.equal(contiguous(ranks, 600, 699), true, 'ranks 600–649 above my row, all public');
    assert.equal(ranks.indexOf(650), 50);
  });

  it('rank 1 and the last rank open normally; without a ranking the list starts at rank 1', async (t) => {
    const first = await harness(t, { total: 300, mine: 1 });
    await first.header(500);
    await first.content(4000);
    await first.flush();
    assert.equal(first.listReads().length, 1, 'nothing above rank 1');
    assert.deepEqual(first.scrolls, [['offset', 0]]);
    assert.equal(first.ranks()[0], 1);

    const last = await harness(t, { total: 1000, mine: 1000 });
    assert.deepEqual(last.ranks(), [1000]);
    await last.header(500);
    await last.content(900);
    await last.flush();
    assert.deepEqual(last.listReads().map((params: URLSearchParams) => params.get('offset')), ['0', '949']);
    assert.equal(contiguous(last.ranks(), 950, 1000), true);

    const unjoined = await harness(t, { total: 300, mine: null });
    const read = unjoined.listReads()[0];
    assert.deepEqual([read.has('anchor'), read.get('offset')], [false, '0']);
    assert.equal(unjoined.ranks()[0], 1);
    await unjoined.content(4000);
    await unjoined.flush();
    assert.equal(unjoined.listReads().length, 1, 'no rows above rank 1 are asked for');
  });
});

describe('전체 탭: 맨위로·맨아래로', () => {
  it('맨위로 reads only the first page and shows the top; 맨아래로 reads only the last page and shows the last row', async (t) => {
    const h = await harness(t, { total: 1000, mine: 650 });
    await h.header(500);
    await h.content(4000);
    await h.flush();
    await h.scroll(1200, 700, 8000);
    const before = h.listReads().length;

    await h.press('top');
    let reads = h.listReads().slice(before);
    assert.deepEqual(reads.map((params: URLSearchParams) => [params.get('offset'), params.get('limit'), params.has('anchor')]), [['0', '50', false]]);
    assert.equal(h.scrolls.some((call: unknown[]) => call[0] === 'offset' && call[1] === 0), true);
    assert.equal(contiguous(h.ranks(), 1, 50), true, 'the header, then rank 1');
    assert.equal(h.has('ranking-tabs'), true);

    const afterTop = h.listReads().length;
    await h.press('bottom');
    await h.content(5000);
    await h.flush();
    reads = h.listReads().slice(afterTop);
    assert.deepEqual(reads.map((params: URLSearchParams) => params.get('offset')), ['950', '900'], 'the last page, then the one above it');
    assert.deepEqual(h.scrolls.at(-1), ['offset', 5000 - 700], 'the measured end of the list');
    assert.equal(h.ranks().at(-1), 1000);
    assert.equal(h.listReads().filter((params: URLSearchParams) => Number(params.get('offset')) > 50 && Number(params.get('offset')) < 549).length, 0,
      'nothing between the ends was downloaded');
  });

  it('are disabled only at the real top or bottom of the ranking, never at a loaded page\'s edge', async (t) => {
    const h = await harness(t, { total: 1000, mine: 650 });
    await h.header(500);
    await h.content(4000);
    await h.flush();
    // The top of what is loaded is rank 600, not rank 1.
    await h.scroll(0, 700, 8000);
    assert.deepEqual([h.jump('top').props.disabled, h.jump('bottom').props.disabled], [false, false]);
    await h.press('top');
    await h.scroll(0, 700, 4000);
    assert.deepEqual([h.jump('top').props.disabled, h.jump('bottom').props.disabled], [true, false]);
    await h.press('bottom');
    await h.content(5000);
    await h.flush();
    await h.scroll(4300, 700, 5000);
    assert.deepEqual([h.jump('top').props.disabled, h.jump('bottom').props.disabled], [false, true]);
    // A disabled button does nothing.
    const reads = h.reads.length;
    assert.equal(h.jump('bottom').props.onPress === undefined, true);
    await h.press('bottom');
    assert.equal(h.reads.length, reads);

    const few = await harness(t, { total: 5, mine: 3 });
    await few.header(500);
    await few.content(900);
    await few.flush();
    await few.scroll(0, 1200, 900);
    assert.deepEqual([few.jump('top').props.disabled, few.jump('bottom').props.disabled], [true, true], 'nothing to scroll');
  });

  it('are small round icon buttons without text, named for screen readers, above the bottom edge', async (t) => {
    const h = await harness(t, { total: 300, mine: 120 });
    for (const [direction, label] of [['top', '맨위로'], ['bottom', '맨아래로']] as const) {
      const button = h.jump(direction);
      const style = flatten(button.props.style);
      assert.deepEqual([style.width, style.height, style.borderRadius], [36, 36, 18]);
      assert.equal(style.width + 2 * button.props.hitSlop >= 44, true, 'touch target');
      assert.equal(button.props.accessibilityLabel, label);
      assert.equal(button.props.accessibilityRole, 'button');
      assert.equal(button.findAll((node: any) => node.type === 'Text').length, 0, 'icon only');
      assert.equal(button.findAll((node: any) => node.type === 'Svg').length, 1);
    }
    // The list ends above the pair, so its last row is never under them.
    assert.equal(flatten(h.list.contentContainerStyle).paddingBottom >= 16 + 36 * 2 + 8, true);
  });
});

describe('친구·TOP10 탭은 그대로', () => {
  it('keep their lists, without an anchor, jumps or a kept position; 전체 reopens at my row', async (t) => {
    const h = await harness(t, { total: 300, mine: 120 });
    for (const tab of ['friends', 'top10'] as const) {
      await h.tab(tab);
      const read = h.listReads().at(-1);
      assert.deepEqual([read.get('scope'), read.has('anchor'), read.get('offset')], [tab, false, '0']);
      assert.equal(h.list.maintainVisibleContentPosition === undefined && h.list.onScroll === undefined, true);
      assert.equal(h.renderer.root.findAll((node: any) => String(node.props?.testID ?? '').startsWith('ranking-jump-')).length, 0);
      assert.equal(h.ranks()[0], 1);
    }
    await h.tab('all');
    const read = h.listReads().at(-1);
    assert.deepEqual([read.get('scope'), read.get('anchor')], ['all', 'me']);
    assert.equal(h.ranks()[0], 120);
    await h.header(500);
    await h.content(4000);
    assert.deepEqual(h.scrolls.at(-1), ['offset', 508]);
  });

  it('a new ranking set reopens 전체 at my row in that set, never mixing the two', async (t) => {
    const h = await harness(t, { total: 300, mine: 120 });
    await h.header(500);
    await h.content(4000);
    await h.flush();
    h.generation = 2;
    const before = h.listReads().length;
    await act(async () => { await h.client.invalidateQueries({ queryKey: QUERY_KEYS.ranking.list({
      scope: 'all', seasonId: availableRankings.season.id, rankType: 'daily', limit: 3, offset: 0,
    }) }); });
    await h.flush();
    const reads = h.listReads().slice(before);
    assert.equal(reads[0].get('anchor'), 'me');
    assert.equal(reads.every((params: URLSearchParams) => params.get('capturedAt') === '2026-05-07T00:12:00.000Z'), true);
    await h.header(500);
    await h.content(4000);
    await h.flush();
    assert.equal(contiguous(h.ranks(), 70, 169), true, 'one set, my row and the page above it');
  });
});

describe('TOP 3 시상대', () => {
  it('shows ranks 1·2·3 of the whole ranking as 2 · 1 · 3, from the publication, on every tab', async (t) => {
    const h = await harness(t, { total: 300, mine: 2 });
    const publicationReads = h.publicationReads();
    for (const tab of ['all', 'friends', 'top10'] as const) {
      if (tab !== 'all') await h.tab(tab);
      const ids = h.renderer.root.findAll((node: any) => typeof node.type === 'string' && /^ranking-podium-\d$/.test(node.props.testID ?? ''))
        .map((node: any) => node.props.testID);
      assert.deepEqual(ids, ['ranking-podium-2', 'ranking-podium-1', 'ranking-podium-3'], tab);
      assert.deepEqual([1, 2, 3].map((place) => h.text(`ranking-podium-${place}-name`)), ['trader-1', 'trader-2', 'trader-3']);
      // 나 by participant id: I am 2nd.
      assert.deepEqual([1, 2, 3].map((place) => h.has(`ranking-podium-${place}-me`)), [false, true, false]);
    }
    assert.equal(h.publicationReads(), publicationReads, 'no read of its own');
  });

  it('follows the design: card, avatars and rings, crown, stands and numbers', async (t) => {
    const h = await harness(t, { total: 300, mine: 50 });
    const card = flatten(h.node('ranking-podium').props.style);
    assert.deepEqual([card.backgroundColor, card.borderColor, card.borderWidth, card.borderRadius, card.overflow,
      card.paddingTop, card.paddingHorizontal, card.paddingBottom], [semantic.surface, semantic.border, 1, 16, 'hidden', 22, 10, 0]);
    const spec = { 1: [56, 64, '#D6A935', 30, 36, '#7D5A0B', 8], 2: [48, 50, '#AEB6C3', 26, 32, '#566171', 6], 3: [48, 40, '#CF9566', 24, 30, '#80491F', 4] } as const;
    for (const place of [1, 2, 3] as const) {
      const [avatar, stand, ring, size, line, color, pad] = spec[place];
      // The list's own avatar (its default silhouette without a photo), on the spec's background, no border.
      const photo = h.node(`ranking-podium-${place}-avatar`);
      assert.deepEqual([photo.type, photo.props.size, flatten(photo.props.frameStyle).backgroundColor, flatten(photo.props.frameStyle).borderWidth],
        ['ProfileAvatar', avatar, '#E6E9EE', 0]);
      const column = h.node(`ranking-podium-${place}`);
      const rings = column.findAll((node: any) => node.type === 'View' && flatten(node.props.style).borderColor === ring);
      assert.equal(rings.length, 1, `place ${place} ring`);
      assert.deepEqual([flatten(rings[0].props.style).top, flatten(rings[0].props.style).borderWidth], [-4, 2]);
      assert.equal(flatten(h.node(`ranking-podium-${place}-stand`).props.style).minHeight, stand);
      const number = h.node(`ranking-podium-${place}-stand`).findAll((node: any) => node.type === 'Text')[0];
      const numberStyle = flatten(number.props.style);
      assert.deepEqual([strings(number).join(''), numberStyle.fontSize, numberStyle.lineHeight, numberStyle.color, numberStyle.fontWeight, numberStyle.paddingTop],
        [String(place), size, line, color, '800', pad]);
    }
    const crowns = h.hosts('ranking-podium-crown');
    assert.equal(crowns.length, 1);
    assert.equal(h.node('ranking-podium-1').findAll((node: any) => node.props?.testID === 'ranking-podium-crown').length > 0, true);
    assert.deepEqual([crowns[0].props.width, crowns[0].props.height, flatten(crowns[0].props.style).left, flatten(crowns[0].props.style).top], [26, 16, 15, -18]);
    assert.equal(crowns[0].findAll((node: any) => node.type === 'Path')[0].props.d, 'M2 14L1 4l6 4.5L13 1l6 7.5L25 4l-1 10z');
  });

  it('uses the list\'s figures, colors and tiers, and ellipsizes only the nickname', async (t) => {
    const h = await harness(t, { total: 300, mine: 50 });
    assert.equal(h.text('ranking-podium-1-return'), '+1.5%');
    assert.equal(h.text('ranking-podium-2-return'), '-0.45%');
    assert.equal(flatten(h.node('ranking-podium-1-return').props.style).color, financial.rise);
    assert.equal(flatten(h.node('ranking-podium-2-return').props.style).color, financial.fall);
    assert.equal(h.text('ranking-podium-1-tier'), 'Whale');
    assert.equal(h.has('ranking-podium-1-emblem'), true);
    assert.deepEqual([h.node('ranking-podium-1-name').props.numberOfLines, h.node('ranking-podium-1-name').props.ellipsizeMode], [1, 'tail']);
    assert.equal(h.node('ranking-podium-1-return').props.numberOfLines, undefined);
    assert.equal(h.has('ranking-podium-1-me') || h.has('ranking-podium-2-me') || h.has('ranking-podium-3-me'), false, 'I am 50th');
  });

  it('is a display-only block between 순위 안내 and the tabs, read in 1 · 2 · 3 order', async (t) => {
    const h = await harness(t, { total: 300, mine: 50 });
    const podium = h.node('ranking-podium');
    assert.equal(podium.findAll((node: any) => node.type === 'Pressable' || typeof node.props?.onPress === 'function').length, 0);
    assert.match(podium.props.accessibilityLabel, /^1위 trader-1, 수익률 \+1\.5%, Whale 티어\. 2위 trader-2, .*\. 3위 trader-3/);
    const ids = h.renderer.root.findAll((node: any) => typeof node.type === 'string' && typeof node.props.testID === 'string')
      .map((node: any) => node.props.testID);
    assert.equal(ids.indexOf('ranking-my-rank') < ids.indexOf('ranking-podium'), true);
    assert.equal(ids.indexOf('ranking-podium') < ids.indexOf('ranking-tabs'), true);
    assert.deepEqual([flatten(podium.props.style).marginTop, flatten(podium.props.style).marginBottom], [4, 16]);
    // The list keeps its own 1–3 rows.
    await h.tab('top10');
    assert.deepEqual(h.ranks().slice(0, 3), [1, 2, 3]);
  });

  it('draws nothing unless ranks 1, 2 and 3 are all confirmed', async (t) => {
    for (const [total, hidden] of [[2, []], [1, []], [0, []], [10, [3]]] as const) {
      const h = await harness(t, { total, mine: null, hidden: [...hidden] });
      assert.equal(h.has('ranking-podium'), false, `${total} / hidden ${hidden.join(',')}`);
    }
  });
});
