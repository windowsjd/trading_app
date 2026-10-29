import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import ts from 'typescript';
import { availableRankings } from './fixtures.ts';
import type { RankingsResponseDto, UserSeasonSummaryDto } from './api.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const { QueryClient } = require('@tanstack/react-query');
const { renderToStaticMarkup } = require('react-dom/server');
const native = require('react-native-web');
const src = path.join(process.cwd(), 'src');
const compiled = new Map<string, string>();

// The project's Node test runner cannot import TSX or native modules directly.
// Compile the actual screen/dependencies and render with React + RN Web. Only
// I/O hooks are stubbed; row rendering, formatters, states and press handlers run.
function createHarness(scope?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  queryClient.setQueryData(['me'], null);
  after(() => queryClient.clear());
  const modules = new Map<string, any>();
  const mocks = new Map<string, any>();
  const presses: any[] = [];
  const lists: any[] = [];
  const queryOptions: any[] = [];
  const navigations: any[] = [];
  const requests: string[] = [];
  const page: RankingsResponseDto = structuredClone(availableRankings);
  const ready = (data: unknown) => ({
    data, isLoading: false, isError: false, isSuccess: true,
    error: null, refetch: () => Promise.resolve(),
  });
  const season: any = ready({ ...page.season, joined: true });
  const ranking: any = { ...ready({ pages: [page] }), isFetchingNextPage: false };
  const top = ready(page);
  const queries = new Map<string, any>();
  const navigation = { navigate: (...args: any[]) => navigations.push(args) };
  const mockLocal = (file: string, value: any) => mocks.set(path.join(src, file), value);

  if (scope) mocks.set('react', { ...React, useState: (initial: unknown) => initial === 'all' ? [scope, () => {}] : React.useState(initial) });
  mocks.set('react-native', {
    ...native,
    Pressable: (props: any) => {
      // Label lookups inspect the resting content, including render-prop layers.
      presses.push({ ...props, children: typeof props.children === 'function' ? props.children({ pressed: false }) : props.children });
      return React.createElement(native.Pressable, props);
    },
    FlatList: (props: any) => {
      lists.push(props);
      return React.createElement(native.FlatList, props);
    },
  });
  mocks.set('@react-navigation/native', { useFocusEffect: () => {}, useIsFocused: () => true, NavigationContext: React.createContext(undefined) });
  // SVG is a native host boundary; browser tests exercise its actual renderer.
  mocks.set('react-native-svg', { default: 'svg', Path: 'path', Defs: 'defs', LinearGradient: 'linearGradient', RadialGradient: 'radialGradient', Rect: 'rect', Stop: 'stop', __esModule: true });
  mocks.set('@tanstack/react-query', {
    useQuery: (options: any) => {
      queryOptions.push(options);
      if (options.queryKey[0] === 'season') return season;
      if (options.queryKey[0] === 'ranking' && options.queryKey[7] === 3) return top;
      return queries.get(options.queryKey.slice(0, 3).join('/'))
        ?? queries.get(options.queryKey[0]) ?? ready(undefined);
    },
    useInfiniteQuery: (options: any) => {
      queryOptions.push(options);
      return ranking;
    },
    useQueryClient: () => queryClient,
  });
  mockLocal('app/navigation/navigationHooks', { useRootNavigation: () => navigation });
  mockLocal('services/api/client', {
    apiClient: { get: async (url: string) => {
      requests.push(url);
      return { data: { success: true, data: url.includes('season-summary') ? queries.get('ranking')?.data : page } };
    } },
  });

  function load(filename: string): any {
    if (mocks.has(filename)) return mocks.get(filename);
    const file = [filename, `${filename}.ts`, `${filename}.tsx`, path.join(filename, 'index.ts')]
      .find((candidate) => existsSync(candidate) && /\.[jt]sx?$/.test(candidate));
    assert.ok(file, `Test module not found: ${filename}`);
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    if (!compiled.has(file)) {
      compiled.set(file, ts.transpileModule(readFileSync(file, 'utf8'), {
        fileName: file,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
        },
      }).outputText);
    }
    const localRequire = (id: string) => {
      if (mocks.has(id)) return mocks.get(id);
      if (id.endsWith('.json')) return require(path.resolve(path.dirname(file), id));
      if (id.endsWith('.png')) return { uri: path.resolve(path.dirname(file), id) };
      if (id.endsWith('/theme/native')) return mocks.get('react-native');
      if (id.endsWith('/theme/safeArea')) return { SafeAreaView: native.SafeAreaView };
      if (id.endsWith('/theme/appearance')) return { useAppearance: () => ({ mode: 'light', colors: {} }) };
      return id.startsWith('.') ? load(path.resolve(path.dirname(file), id)) : require(id);
    };
    new Function('require', 'module', 'exports', compiled.get(file)!)(localRequire, module, module.exports);
    return module.exports;
  }

  function render(screen = 'ranking/RankingScreen', props = {}) {
    presses.length = 0;
    lists.length = 0;
    const Screen = load(path.join(src, 'screens', screen)).default;
    return renderToStaticMarkup(React.createElement(Screen, { navigation, ...props }));
  }

  return { page, season, ranking, top, queries, ready, render, load, mockLocal,
    presses, lists, queryOptions, navigations, requests };
}

function apiError(code = 'INTERNAL_SERVER_ERROR') {
  return { response: { status: 500, data: { success: false, error: { code, message: 'Test error' } } } };
}

const notJoined = {
  state: 'not_joined', reason: 'SEASON_NOT_JOINED',
  message: 'My ranking is available after joining the season.',
} as const;
const unavailable = {
  state: 'unavailable', reason: 'MY_RANKING_UNAVAILABLE',
  message: 'My ranking is unavailable until season rankings are generated.',
} as const;

describe('ranking wire response rendering', () => {
  it('renders real flat ranking rows and available myRanking', () => {
    const h = createHarness();
    h.queries.set('me', h.ready({ id: 'self', nickname: '내 닉네임', profileImageUrl: 'https://example.test/me.png' }));
    const html = h.render();
    assert.match(html, /ranking-my-avatar-image/);
    assert.match(html, /ranking-avatar-user-1-image/);
    assert.match(html, /ranking-avatar-user-2-fallback/);
    // The list itself shows the top rankers; there is no separate podium card.
    assert.equal(/ranking-top3|ranking-top-|상위 랭커/.test(html), false, 'podium card removed');
    // 내 순위 shows my ranking's return rate and total assets; the list rows keep theirs.
    assert.match(html, /data-testid="ranking-my-return"[^>]*>\+9%</);
    assert.match(html, /data-testid="ranking-my-total"[^>]*>999,998원</);
    assert.match(html, /aria-label="수익률 \+9%, 총자산 999,998원"/);
    assert.equal(/ranking-return-user-1/.test(html) && /ranking-return-user-2/.test(html), true, 'list rows keep return rates');
    assert.equal(/ranking-total-user-1/.test(html), true, 'list rows keep total assets');
    assert.match(html, /trader-1/);
    assert.match(html, /trader-2/);
    assert.match(html, /#1/);
    assert.match(html, /#2/);
    assert.match(html, /10%/);
    assert.match(html, /999,999/);
    // Every row is the same plain card; its tier is a small emblem and name
    // (master is shown as Whale), never raw text. The Home emblem (its ids) and
    // the original card artwork stay on 내 순위 only.
    assert.doesNotMatch(html, /ranking-tier-background-/);
    assert.match(html, /data-testid="ranking-row-tier-user-1"/);
    assert.match(html, /data-testid="ranking-row-tier-user-2"/);
    assert.match(html, />Whale</);
    assert.equal(html.match(/data-testid="home-emblem-/g)?.length, 1, 'only my card keeps an emblem');
    assert.match(html, /home-emblem-silver/);
    assert.match(html, /home-tier-background-silver-light/);
    assert.match(html, /aria-label="Whale 티어, 수익률 \+10%, 총자산 999,999원"/, 'the tier is announced, not only colored');
    assert.doesNotMatch(html, /퍼센타일|등급 |>master<|>silver</);
  });

  it('opens the existing summary with userId from list presses (no podium presses remain)', () => {
    const h = createHarness();
    h.render();
    const { TEST_IDS } = h.load(path.join(src, 'constants/testIds'));
    assert.equal(h.presses.filter((p) => p.testID?.startsWith('ranking-top-')).length, 0);
    for (const item of h.page.rankings) {
      h.presses.find((p) => p.testID === TEST_IDS.ranking.item(item.userId)).onPress();
      assert.deepEqual(h.navigations.at(-1), ['UserSeasonSummary', { userId: item.userId }]);
    }
  });

  it('renders several users with unique participant keys, including overlapping pages', (t) => {
    const h = createHarness();
    const third = { ...h.page.rankings[1], rank: 3, seasonParticipantId: 'sp-3', userId: 'user-3' };
    h.ranking.data.pages.push({ ...h.page, rankings: [h.page.rankings[1], third] });
    const errors = t.mock.method(console, 'error', () => {});
    h.render();
    const list = h.lists[0];
    assert.equal(list.data.length, 3);
    assert.deepEqual(list.data.map(list.keyExtractor), ['sp-1', 'sp-2', 'sp-3']);
    assert.equal(h.presses.filter((p) => p.testID?.startsWith('ranking-item-')).length, 3);
    assert.deepEqual(errors.mock.calls, []);
  });

  it('preserves zero-row and snapshot-waiting states', () => {
    const h = createHarness();
    h.page.rankings = [];
    h.page.pagination = { limit: 50, offset: 0, total: 0, returned: 0, nextOffset: null };
    assert.match(h.render(), /아직 랭킹 데이터가 없습니다/);
    h.page.state = 'unavailable';
    h.page.rankingDate = null;
    h.page.capturedAt = null;
    h.page.myRanking = unavailable;
    assert.match(h.render(), /랭킹 생성 대기 중입니다/);
  });

  it('keeps the join guide and navigation for non-participants', () => {
    const h = createHarness();
    h.page.myRanking = notJoined;
    h.season.data.joined = false;
    assert.match(h.render(), /아직 이번 시즌에 참가하지 않았습니다/);
    h.presses.find((p) => renderToStaticMarkup(p.children).includes('시즌 참가하기')).onPress();
    assert.deepEqual(h.navigations, [['SeasonJoin']]);
  });

  it('keeps joining accessible when the leaderboard is empty or not generated yet', () => {
    const h = createHarness();
    h.page.myRanking = notJoined;
    h.page.rankings = [];
    h.season.data.joined = false;
    for (const state of ['available', 'unavailable'] as const) {
      h.page.state = state;
      assert.match(h.render(), /시즌 참가하기/);
      h.presses[0].onPress();
    }
    assert.deepEqual(h.navigations, [['SeasonJoin'], ['SeasonJoin']]);
  });

  it('keeps public rows visible while myRanking is unavailable or hidden', () => {
    const h = createHarness();
    for (const reason of ['MY_RANKING_UNAVAILABLE', 'RANKING_HIDDEN', 'PARTICIPANT_EXCLUDED']) {
      h.page.myRanking = { ...unavailable, reason };
      const html = h.render();
      assert.match(html, /내 랭킹 생성 대기 중입니다/);
      assert.match(html, /trader-1/);
    }
  });

  it('shows ErrorState and retries both queries on request failure', () => {
    const h = createHarness();
    h.top.isError = true;
    h.top.error = apiError();
    h.top.data = undefined;
    let retries = 0;
    h.top.refetch = h.season.refetch = async () => { retries += 1; };
    assert.match(h.render(), /랭킹을 불러오지 못했습니다/);
    h.presses[0].onPress();
    assert.equal(retries, 2);
  });

  it('keeps the existing loading and missing/current-season error states', () => {
    const h = createHarness();
    h.top.isLoading = true;
    assert.match(h.render(), /랭킹을 불러오는 중입니다/);
    h.top.isLoading = false;
    h.season.data = undefined;
    assert.match(h.render(), /랭킹을 불러오지 못했습니다/);
    h.season.isError = true;
    assert.match(h.render(), /랭킹을 불러오지 못했습니다/);
  });

  it('renders final tiers without requiring provisional tiers or a tier alias', () => {
    const h = createHarness();
    h.page.rankType = 'final';
    h.page.rankings = h.page.rankings.map((row) => ({ ...row, provisionalTier: null, finalTier: 'diamond' }));
    h.page.myRanking = { ...availableRankings.myRanking, provisionalTier: null, finalTier: 'diamond' };
    const html = h.render();
    assert.match(html, /최종 랭킹 확정/);
    assert.match(html, /home-emblem-diamond/);
    // Both rows name the final tier on their tier line; the card caption names it too.
    assert.equal(html.match(/data-testid="ranking-row-emblem-image-user-[12]"/g)?.length, 2);
    assert.equal(html.match(/>Diamond</g)?.length, 3);
    assert.match(html, /data-testid="ranking-my-return"[^>]*>\+9%</);
    assert.doesNotMatch(html, /home-emblem-whale|home-emblem-silver|>Whale<|>Silver<|ranking-tier-background-/);
  });

  it('draws every row as the same plain card with its tier line; unknown tiers have none, and no row has a Home emblem', () => {
    const h = createHarness();
    const tiers = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', null, 'grandmaster'];
    h.page.rankings = tiers.map((tier, index) => ({
      ...availableRankings.rankings[0], rank: index + 1, seasonParticipantId: `sp-${index}`, userId: `user-${index}`,
      provisionalTier: tier, finalTier: null, returnRate: index % 2 ? '-3.5' : '7.25',
    }));
    const html = h.render();
    const row = (index: number) => {
      const start = html.indexOf(`data-testid="ranking-item-user-${index}"`);
      const end = html.indexOf('data-testid="ranking-item-user-', start + 1);
      return html.slice(start, end === -1 ? undefined : end);
    };
    for (const [index, visual] of ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'whale'].entries()) {
      assert.equal(row(index).includes(`data-testid="ranking-row-tier-user-${index}"`), true, visual);
      assert.equal(/ranking-tier-background-|home-emblem-|home-tier-image/.test(row(index)), false, `${visual} row has no art or Home emblem`);
      // myRanking is sp-2 in this fixture: that (gold) row is mine and its label starts with 내 순위.
      const mine = index === 2 ? '내 순위, ' : '';
      assert.equal(row(index).includes(`aria-label="${mine}${visual === 'whale' ? 'Whale' : visual[0].toUpperCase() + visual.slice(1)} 티어, 수익률`), true);
    }
    for (const index of [6, 7]) {
      assert.equal(/ranking-row-tier-|ranking-tier-background-|home-emblem-/.test(row(index)), false, 'no invented tier');
      assert.equal(row(index).includes('aria-label="수익률 '), true);
    }
    // Rise/fall meaning and both figures stay on every row.
    assert.equal(/ranking-return-user-1"[^>]*>-3\.5%</.test(html) && /ranking-return-user-0"[^>]*>\+7\.25%</.test(html), true);
    assert.equal(html.match(/data-testid="ranking-total-user-/g)?.length, tiers.length);
  });

  it('renders long nicknames and financial text without a line truncation limit', () => {
    const h = createHarness();
    const nickname = '아주긴닉네임LongNickname'.repeat(8);
    h.page.rankings[0] = { ...h.page.rankings[0], nickname, rank: 123456, returnRate: '-12345.67890000' };
    const html = h.render();
    assert.ok(html.includes(nickname));
    assert.match(html, /#123456/);
    assert.match(html, /-12345\.68%/);
    assert.doesNotMatch(html, /-webkit-line-clamp/);
  });
});

describe('ranking API and query contract', () => {
  for (const scope of ['all', 'friends', 'top10']) {
    it(`${scope} keeps the canonical publication independently of the scoped list`, async () => {
      const h = createHarness(scope);
      const friend = { ...h.page.rankings[0], userId: 'friend-outside-top3', seasonParticipantId: 'friend-sp', rank: 42, nickname: '친구42' };
      h.ranking.data = { pages: [{ ...h.page, rankings: [friend] }] };
      const html = h.render();
      // The publication read (limit 3) still pins every scope; it is not drawn.
      assert.equal(h.queryOptions.some(q => q.queryKey[0] === 'ranking' && q.queryKey[7] === 3), true);
      assert.equal(/ranking-top-/.test(html), false);
      assert.match(html, /ranking-item-friend-outside-top3/);
      const list = h.queryOptions.find(q => q.getNextPageParam);
      await list.queryFn({ pageParam: list.initialPageParam });
      const params = new URL(h.requests.at(-1)!, 'https://fixture.invalid').searchParams;
      for (const [key, value] of Object.entries({ scope, seasonId: h.page.season!.id, rankType: h.page.rankType,
        rankingDate: h.page.rankingDate, capturedAt: h.page.capturedAt })) assert.equal(params.get(key), value);
      h.ranking.data = undefined;
      h.ranking.isLoading = true;
      assert.equal(/ranking-my-card/.test(h.render()), true, 'my standing remains during tab loading');
      h.ranking.isLoading = false;
      h.ranking.isError = true;
      assert.equal(/ranking-my-card/.test(h.render()), true, 'my standing remains on a scoped list failure');
    });
  }

  it('requests the settled season final publication explicitly', async () => {
    const h = createHarness('friends');
    h.season.data.status = 'settled';
    h.page.rankType = 'final';
    h.render();
    const top = h.queryOptions.find(q => q.queryKey[7] === 3);
    await top.queryFn();
    const params = new URL(h.requests.at(-1)!, 'https://fixture.invalid').searchParams;
    assert.equal(params.get('scope'), 'all');
    assert.equal(params.get('limit'), '3');
    assert.equal(params.get('rankType'), 'final');
    assert.equal(params.get('seasonId'), h.page.season!.id);
  });

  it('returns the wire payload directly and preserves default scope limits', async () => {
    const h = createHarness();
    const { getRankings } = h.load(path.join(src, 'features/ranking/api'));
    for (const scope of ['all', 'friends', 'top10']) {
      assert.strictEqual(await getRankings({ scope }), h.page);
      const url = new URL(h.requests.at(-1)!, 'https://fixture.invalid');
      assert.equal(url.pathname, '/ranking');
      assert.equal(url.searchParams.get('scope'), scope);
      assert.equal(url.searchParams.get('limit'), scope === 'top10' ? '10' : '50');
      assert.equal(url.searchParams.get('offset'), '0');
    }
  });

  it('pins subsequent pages to server pagination and snapshot metadata', async () => {
    const h = createHarness();
    h.render();
    const options = h.queryOptions.find((q) => q.getNextPageParam);
    assert.equal(options.getNextPageParam(h.page), undefined);
    h.page.pagination.nextOffset = 50;
    const next = options.getNextPageParam(h.page);
    assert.deepEqual(next, {
      offset: 50, limit: 50, rankType: 'daily', rankingDate: h.page.rankingDate, capturedAt: h.page.capturedAt,
    });
    await options.queryFn({ pageParam: next });
    const params = new URL(h.requests.at(-1)!, 'https://fixture.invalid').searchParams;
    assert.equal(params.get('offset'), '50');
    assert.equal(params.get('limit'), '50');
    assert.equal(params.has('anchor'), false, 'only the first page of a 전체 stretch is anchored');
    assert.equal(params.get('capturedAt'), h.page.capturedAt);
    assert.equal(params.get('rankingDate'), h.page.rankingDate);
    assert.equal(params.get('rankType'), 'daily');
  });

  it('retains daily polling and disables it for final or settled rankings', () => {
    const h = createHarness();
    h.render();
    const options = h.queryOptions.find((q) => q.queryKey[7] === 3);
    assert.equal(options.refetchInterval({ state: { data: h.page } }), 60_000);
    h.page.rankType = 'final';
    assert.equal(options.refetchInterval({ state: { data: h.page } }), false);
    h.page.rankType = 'daily';
    h.season.data.status = 'settled';
    assert.equal(options.refetchInterval({ state: { data: h.page } }), false);
  });

  it('passes API failures to React Query without inventing an empty response', async () => {
    const h = createHarness();
    const error = apiError();
    h.mockLocal('services/api/client', { apiClient: { get: async () => { throw error; } } });
    const { getRankings } = h.load(path.join(src, 'features/ranking/api'));
    await assert.rejects(getRankings({ scope: 'all' }), (caught) => caught === error);
  });
});

const completedSpot = { kind: 'spot' as const, assetId: 'asset-samsung', symbol: '005930', name: 'Samsung Electronics', market: 'KRX',
  assetType: 'domestic_stock', currencyCode: 'KRW' as const, buyAmount: '1061060.00000000', realizedPnl: '62815.00000005', returnRate: '5.92002337' };
const completedFutures = { kind: 'futures' as const, assetId: 'asset-btc', symbol: 'BTCUSDT', name: 'Bitcoin', market: 'BINANCE', direction: 'short' as const,
  currencyCode: 'USD' as const, entryMargin: '63.33333334', realizedPnl: '24.64500000', returnRate: '38.91315789' };
const summaryFixture: UserSeasonSummaryDto = {
  state: 'available',
  user: { id: 'user-2', nickname: 'trader-2', profileImageUrl: null },
  season: {
    id: 'season-1', name: '시즌 1', maxDrawdown: '0', status: 'active', rank: 2, provisionalTier: 'silver', finalTier: null,
    percentile: '100.00000000', returnRate: '9.00000000', totalAssetKrw: '999998.00000000', totalFillCount: 4,
  },
  portfolioAccess: 'available',
  portfolio: { valuationState: 'available', allocation: { cashKrwValue: '999998.00000000', domesticStockValueKrw: '0', usStockValueKrw: '0', cryptoValueKrw: '0' }, holdings: [], futures: { evaluatedAt: new Date().toISOString(), positions: [] }, history: [] },
};

describe('existing user season summary', () => {
  it('renders nested summary user and requests the selected user endpoint', async () => {
    const h = createHarness();
    h.queries.set('ranking', h.ready(summaryFixture));
    const html = h.render('ranking/UserSeasonSummaryScreen', { route: { params: { userId: 'user-2' } } });
    assert.match(html, /trader-2/);
    assert.match(html, /home-emblem-silver/);
    assert.match(html, />Silver</);
    assert.doesNotMatch(html, /퍼센타일|등급 silver/);
    assert.match(html, /999,998/);
    await h.queryOptions[0].queryFn({});
    assert.equal(h.requests[0], '/users/user-2/season-summary');
  });

  it('handles a null current season without a render exception', () => {
    const h = createHarness();
    h.queries.set('ranking', h.ready({ ...summaryFixture, state: 'unavailable', season: null }));
    assert.match(h.render('ranking/UserSeasonSummaryScreen', { route: { params: { userId: 'user-2' } } }), /현재 시즌 정보가 없습니다/);
  });

  it('recognizes the backend USER_NOT_FOUND response and generic request errors', () => {
    const h = createHarness();
    const query = { ...h.ready(undefined), isError: true, error: apiError('USER_NOT_FOUND') };
    h.queries.set('ranking', query);
    const props = { route: { params: { userId: 'user-2' } } };
    assert.match(h.render('ranking/UserSeasonSummaryScreen', props), /해당 유저 정보를 찾을 수 없습니다/);
    query.error = apiError();
    assert.match(h.render('ranking/UserSeasonSummaryScreen', props), /유저 정보를 불러오지 못했습니다/);
  });
});

function prepareAccountScreens(h: ReturnType<typeof createHarness>) {
  const account = {
    id: 'account-2', mode: 'season', status: 'active',
    season: { seasonId: 'season-1', seasonName: 'Season 1', seasonStatus: 'active', participantStatus: 'active' },
  };
  h.mockLocal('features/tradingAccount/TradingAccountContext', { useTradingAccount: () => ({ selectedAccount: account, isLoading: false }) });
  h.mockLocal('components/tradingAccount/AccountSwitcher', { __esModule: true, default: ({ children, homeVisual, homeVisualCaption }: any) => React.createElement(React.Fragment, null, children, homeVisual, homeVisualCaption) });
  h.mockLocal('components/tradingAccount/AccountSetupPanel', { __esModule: true, default: () => null });
  h.mockLocal('features/auth/useLogout', { useLogout: () => () => Promise.resolve() });
  h.mockLocal('components/charts', { DonutChart: () => null, LineChart: () => null });
  // MY's photo/nickname editor (native picker, mutations) has its own tests.
  h.mockLocal('screens/my/MyProfileEditor', { __esModule: true, default: () => null });
  h.queries.set('me', h.ready({ nickname: 'trader-2', email: 'trader-2@example.com' }));
  h.queries.set('record', h.ready({
    items: [],
    pagination: { limit: 20, offset: 0, total: 0, returned: 0, nextOffset: null },
  }));
  h.queries.set('ranking', h.ready(h.page));
  h.queries.set('tradingAccount', h.ready({ state: 'available', sectionErrors: [], summary: null, allocation: {}, wallets: [], positions: [], pagination: { total: 0 }, points: [] }));
  return account;
}

describe('other ranking consumers', () => {
  for (const screen of ['my/MyScreen', 'home/HomeScreen']) {
    it(`${screen} preserves available/final/absent rank or tier display and selected season requests`, async () => {
      const h = createHarness();
      const account = prepareAccountScreens(h);
      const props = { account };
      // Home's account box no longer repeats the rank (the Ranking tab shows it).
      assert.equal(/#2/.test(h.render(screen, props)), !screen.startsWith('home/'));
      assert.match(h.render(screen, props), screen.startsWith('home/') ? /Silver/ : /silver/);
      h.page.myRanking = { ...availableRankings.myRanking, provisionalTier: 'master', finalTier: null };
      assert.match(h.render(screen, props), screen.startsWith('home/') ? /Whale/ : /master/);
      if (screen.startsWith('my/')) assert.doesNotMatch(h.render(screen, props), /Whale/);
      account.season.seasonStatus = 'settled';
      h.page.myRanking = { ...availableRankings.myRanking, provisionalTier: null, finalTier: 'diamond' };
      assert.match(h.render(screen, props), screen.startsWith('home/') ? /Diamond/ : /diamond/);
      const options = h.queryOptions.filter((q) => q.queryKey[0] === 'ranking').at(-1);
      assert.equal(options.enabled, true);
      await options.queryFn();
      const params = new URL(h.requests.at(-1)!, 'https://fixture.invalid').searchParams;
      assert.equal(params.get('seasonId'), 'season-1');
      assert.equal(params.get('rankType'), 'final');
      assert.equal(params.get('scope'), 'all');
      assert.equal(params.get('limit'), '1');
      for (const state of [notJoined, unavailable]) {
        h.page.myRanking = state;
        const html = h.render(screen, props);
        assert.doesNotMatch(html, /#2|silver|diamond/i);
      }
    });

    it(`${screen} still surfaces ranking integrity errors`, () => {
      const h = createHarness();
      const account = prepareAccountScreens(h);
      h.queries.set('ranking', { ...h.ready(undefined), isError: true, error: apiError('SEASON_RANKING_SCOPE_MISMATCH') });
      assert.match(h.render(screen, { account }), /데이터를 안전하게 표시할 수 없습니다/);
    });

    it(`${screen} does not crash on an ordinary ranking request failure`, () => {
      const h = createHarness();
      const account = prepareAccountScreens(h);
      h.queries.set('ranking', { ...h.ready(undefined), isError: true, error: apiError() });
      const html = h.render(screen, { account });
      assert.doesNotMatch(html, /#2|silver/);
      if (screen.startsWith('home/')) assert.match(html, /랭킹 정보를 불러오지 못했습니다/);
      else assert.match(html, /현재 순위/);
    });
  }

  it('MyScreen keeps ranking disabled for a general account', () => {
    const h = createHarness();
    const account = prepareAccountScreens(h);
    account.mode = 'general';
    assert.match(h.render('my/MyScreen'), /일반 투자 계정에는 시즌 등급과 순위가 없습니다/);
    const options = h.queryOptions.find((q) => q.queryKey[0] === 'ranking');
    assert.equal(options.enabled, false);
  });
});


describe('friend portfolio reads (no polling)', () => {
  it('reads on entry/return only: no interval, focused-only, never kept, and no MDD line', () => {
    const h = createHarness();
    h.queries.set('ranking', h.ready(summaryFixture));
    const html = h.render('ranking/UserSeasonSummaryScreen', { route: { params: { userId: 'user-2' } } });
    const options = h.queryOptions.find((q) => q.queryKey[0] === 'ranking');
    assert.deepEqual([options.refetchInterval, options.enabled, options.gcTime, options.staleTime, options.refetchOnMount],
      [undefined, true, 0, 0, 'always']);
    assert.doesNotMatch(html, /최대 낙폭/);
    assert.match(html, /수익률/);
    assert.match(html, /총 자산 999,998원/);
  });

  it('shows futures values as of the server\'s evaluation, labelled, however long ago that read was', () => {
    const h = createHarness();
    const data = structuredClone(summaryFixture);
    // Evaluated long before the device's now: still that read's values, never a flip to 평가 대기.
    const evaluatedAt = '2026-10-20T03:04:05.000Z';
    data.portfolio!.futures = { evaluatedAt, positions: [{ assetId: 'f-btc', symbol: 'BTCUSDT', name: 'Bitcoin', market: 'USDⓈ-M 무기한',
      direction: 'long', marginMode: 'isolated', leverage: '5', markNotional: '1234.5', roi: '12.5', markUnrealizedPnl: '25',
      markState: 'fresh', markEvidence: { effectiveAt: '2026-10-20T03:04:04.000Z', capturedAt: '2026-10-20T03:04:04.500Z' } }] } as any;
    h.queries.set('ranking', h.ready(data));
    const html = h.render('ranking/UserSeasonSummaryScreen', { route: { params: { userId: 'user-2' } } });
    assert.match(html, /2026-10-20 12:04 조회 시점 기준 평가입니다/);
    assert.match(html, /포지션 규모 \$1,234\.5"/);
    assert.match(html, /\+\$25 \(\+12\.5%\)/);
    assert.doesNotMatch(html, /평가 대기/);
    // Evidence that was already stale at that evaluation stays unavailable.
    data.portfolio!.futures.positions[0].markEvidence = { effectiveAt: '2026-10-20T03:03:00.000Z', capturedAt: '2026-10-20T03:03:00.000Z' } as any;
    h.queries.set('ranking', h.ready(data));
    assert.match(h.render('ranking/UserSeasonSummaryScreen', { route: { params: { userId: 'user-2' } } }), /평가 대기/);
  });
});

describe('friend portfolio access rendering', () => {
  it('keeps competition info but never renders cached private holdings', () => {
    for (const [access, message] of [['private', '비공개'], ['not_friend', '친구 요청을 수락한']] as const) {
      const h = createHarness();
      const data = structuredClone(summaryFixture);
      data.portfolioAccess = access;
      data.portfolio!.holdings = [{ assetId: 'private-asset', name: 'PRIVATE_HOLDING', symbol: 'SECRET', assetType: 'crypto', market: 'BINANCE', quantity: '0.00000001', valuation: { state: 'unavailable' }, weight: '30' }];
      data.portfolio!.completedTrades = { items: [{ ...completedSpot, name: 'PRIVATE_DONE', symbol: 'DONE1', market: 'NASDAQ' }], hasMore: false };
      h.queries.set('ranking', h.ready(data));
      const html = h.render('ranking/UserSeasonSummaryScreen', { route: { params: { userId: 'user-2' } } });
      assert.ok(html.includes(message));
      assert.match(html, /trader-2|999,998/);
      assert.doesNotMatch(html, /PRIVATE_HOLDING|SECRET|자산 배분|PRIVATE_DONE|거래 완료 종목/);
    }
  });
  it('shows completed trades and holdings (no 30-day history), and suppresses them during permission refresh', () => {
    const h = createHarness();
    const data = structuredClone(summaryFixture);
    data.portfolio!.holdings = [{ assetId: 'a', name: '보유종목', symbol: 'BTCUSDT', assetType: 'crypto', market: 'BINANCE', quantity: '0.00000001', valuation: { state: 'unavailable' }, weight: null }];
    // An older field the server still sends: no longer drawn.
    data.portfolio!.history = [{ date: '2026-09-29', totalAssetKrw: '1000000', returnRate: '1' }];
    data.portfolio!.completedTrades = { items: [completedFutures, completedSpot], hasMore: false };
    h.queries.set('ranking', h.ready(data));
    const render = () => h.render('ranking/UserSeasonSummaryScreen', { route: { params: { userId: 'user-2' } } });
    const html = render();
    assert.match(html, /0.00000001 BTC/);
    assert.match(html, /비중 확인 불가/);
    assert.doesNotMatch(html, /최근 30일|2026-09-29/);
    assert.match(html, /거래 완료 종목/);
    // Newest first, as the server orders them: the Short lifetime (선물 with its S box), then the Korean stock.
    assert.ok(html.indexOf('숏(Short)') < html.indexOf('삼성전자'));
    assert.match(html, /aria-label="숏\(Short\)"[^>]*>(<[^>]+>)*S</);
    assert.doesNotMatch(html, /SHORT|LONG/);
    assert.match(html, /진입 증거금 \$63\.33/);
    assert.match(html, /실현 손익 \+\$24\.65 · 수익률 \+38\.91%/);
    assert.match(html, /현물/);
    assert.match(html, /\(005930\)/);
    assert.match(html, /매수 금액 1,061,060원/);
    assert.match(html, /실현 손익 \+62,815원 · 수익률 \+5\.92%/);
    assert.match(html, /수수료가 반영돼요/);
    assert.doesNotMatch(html, /최근 \d+개만/);
    h.queries.set('ranking', { ...h.ready(data), isFetching: true });
    assert.doesNotMatch(render(), /0.00000001 BTC|거래 완료 종목|삼성전자/);
    h.queries.set('ranking', { ...h.ready(data), isError: true });
    assert.doesNotMatch(render(), /0.00000001 BTC|거래 완료 종목|삼성전자/);
  });

  it('completed trades: a loss, no basis, none yet, more than listed, and a server without them', () => {
    const h = createHarness();
    const render = (completedTrades?: unknown) => {
      const data = structuredClone(summaryFixture);
      if (completedTrades) (data.portfolio as any).completedTrades = completedTrades;
      h.queries.set('ranking', h.ready(data));
      return h.render('ranking/UserSeasonSummaryScreen', { route: { params: { userId: 'user-2' } } });
    };
    const loss = render({ items: [{ ...completedSpot, symbol: 'AAPL', name: 'Apple', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD',
      buyAmount: '200.5', realizedPnl: '-12.345', returnRate: '-6.15710723' }, { ...completedFutures, entryMargin: '0', returnRate: null }], hasMore: true });
    assert.match(loss, /애플/, 'the same Korean name as a held US stock');
    assert.match(loss, /매수 금액 \$200\.5</);
    assert.match(loss, /실현 손익 -\$12\.35 · 수익률 -6\.16%/);
    assert.match(loss, /진입 증거금 \$0</);
    assert.match(loss, /수익률 -(?!\d)/, 'no basis: no rate, never a fake 0%');
    assert.match(loss, /최근 2개만 보여드려요/);
    assert.match(render({ items: [], hasMore: false }), /아직 모두 정리한 종목이 없어요/);
    const legacy = render();
    assert.doesNotMatch(legacy, /거래 완료 종목|최근 30일/);
  });
});


it('friend ranking empty state keeps the tabs and opens friend discovery', () => {
  const h = createHarness('friends');
  h.page.rankings = [];
  const html = h.render();
  assert.match(html, /현재 시즌 랭킹에 표시할 친구가 없습니다/);
  assert.match(html, /친구 찾기/);
  assert.doesNotMatch(html, /내 주변/);
  const { TEST_IDS } = h.load(path.join(src, 'constants/testIds'));
  assert.ok(h.presses.some((press) => press.testID === TEST_IDS.ranking.tabFriends));
  const cta = h.presses.find((press) => renderToStaticMarkup(press.children).includes('친구 찾기'));
  cta.onPress();
  assert.deepEqual(h.navigations.at(-1), ['MyTab', { screen: 'Friends' }]);
});
