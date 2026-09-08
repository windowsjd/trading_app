import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { availableRankings } from './fixtures.ts';
import type { RankingsResponseDto, UserSeasonSummaryDto } from './api.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const native = require('react-native-web');
const src = path.join(process.cwd(), 'src');
const compiled = new Map<string, string>();

// The project's Node test runner cannot import TSX or native modules directly.
// Compile the actual screen/dependencies and render with React + RN Web. Only
// I/O hooks are stubbed; row rendering, formatters, states and press handlers run.
function createHarness() {
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
  const queries = new Map<string, any>();
  const navigation = { navigate: (...args: any[]) => navigations.push(args) };
  const mockLocal = (file: string, value: any) => mocks.set(path.join(src, file), value);

  mocks.set('react-native', {
    ...native,
    Pressable: (props: any) => {
      presses.push(props);
      return React.createElement(native.Pressable, props);
    },
    FlatList: (props: any) => {
      lists.push(props);
      return React.createElement(native.FlatList, props);
    },
  });
  mocks.set('@tanstack/react-query', {
    useQuery: (options: any) => {
      queryOptions.push(options);
      if (options.queryKey[0] === 'season') return season;
      return queries.get(options.queryKey.slice(0, 3).join('/'))
        ?? queries.get(options.queryKey[0]) ?? ready(undefined);
    },
    useInfiniteQuery: (options: any) => {
      queryOptions.push(options);
      return ranking;
    },
    useQueryClient: () => ({ resetQueries: () => Promise.resolve() }),
  });
  mockLocal('app/navigation/navigationHooks', { useRootNavigation: () => navigation });
  mockLocal('services/api/client', {
    apiClient: { get: async (url: string) => {
      requests.push(url);
      return { data: { success: true, data: page } };
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

  return { page, season, ranking, queries, ready, render, load, mockLocal,
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
    const html = h.render();
    assert.match(html, /trader-1/);
    assert.match(html, /trader-2/);
    assert.match(html, /#1/);
    assert.match(html, /#2/);
    assert.match(html, /10%/);
    assert.match(html, /999,999/);
    assert.match(html, /master/);
    assert.match(html, /silver/);
  });

  it('opens the existing summary with userId from both podium and list presses', () => {
    const h = createHarness();
    h.render();
    const { TEST_IDS } = h.load(path.join(src, 'constants/testIds'));
    const podium = h.presses.filter((p) => !p.testID);
    assert.equal(podium.length, 2);
    for (const [index, item] of h.page.rankings.entries()) {
      podium[index].onPress();
      h.presses.find((p) => p.testID === TEST_IDS.ranking.item(item.userId)).onPress();
      assert.deepEqual(h.navigations.slice(-2), [
        ['UserSeasonSummary', { userId: item.userId }],
        ['UserSeasonSummary', { userId: item.userId }],
      ]);
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
    h.ranking.isError = true;
    h.ranking.error = apiError();
    h.ranking.data = undefined;
    let retries = 0;
    h.ranking.refetch = h.season.refetch = () => { retries += 1; };
    assert.match(h.render(), /랭킹을 불러오지 못했습니다/);
    h.presses[0].onPress();
    assert.equal(retries, 2);
  });

  it('keeps the existing loading and missing/current-season error states', () => {
    const h = createHarness();
    h.ranking.isLoading = true;
    assert.match(h.render(), /랭킹을 불러오는 중입니다/);
    h.ranking.isLoading = false;
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
    assert.match(html, /diamond/);
    assert.doesNotMatch(html, /master|silver/);
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
  it('returns the wire payload directly and preserves default scope limits', async () => {
    const h = createHarness();
    const { getRankings } = h.load(path.join(src, 'features/ranking/api'));
    for (const scope of ['all', 'near_me', 'top10']) {
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
      offset: 50, rankType: 'daily', rankingDate: h.page.rankingDate, capturedAt: h.page.capturedAt,
    });
    await options.queryFn({ pageParam: next });
    const params = new URL(h.requests.at(-1)!, 'https://fixture.invalid').searchParams;
    assert.equal(params.get('offset'), '50');
    assert.equal(params.get('capturedAt'), h.page.capturedAt);
    assert.equal(params.get('rankingDate'), h.page.rankingDate);
    assert.equal(params.get('rankType'), 'daily');
  });

  it('retains daily polling and disables it for final or settled rankings', () => {
    const h = createHarness();
    h.render();
    const options = h.queryOptions.find((q) => q.getNextPageParam);
    assert.equal(options.refetchInterval({ state: { data: h.ranking.data } }), 60_000);
    h.page.rankType = 'final';
    assert.equal(options.refetchInterval({ state: { data: h.ranking.data } }), false);
    h.page.rankType = 'daily';
    h.season.data.status = 'settled';
    assert.equal(options.refetchInterval({ state: { data: h.ranking.data } }), false);
  });

  it('passes API failures to React Query without inventing an empty response', async () => {
    const h = createHarness();
    const error = apiError();
    h.mockLocal('services/api/client', { apiClient: { get: async () => { throw error; } } });
    const { getRankings } = h.load(path.join(src, 'features/ranking/api'));
    await assert.rejects(getRankings({ scope: 'all' }), (caught) => caught === error);
  });
});

const summaryFixture: UserSeasonSummaryDto = {
  state: 'available',
  user: { id: 'user-2', nickname: 'trader-2' },
  season: {
    id: 'season-1', status: 'active', rank: 2, provisionalTier: 'silver', finalTier: null,
    percentile: '100.00000000', returnRate: '9.00000000', totalAssetKrw: '999998.00000000', totalFillCount: 4,
  },
  allocation: { cashKrwValue: '999998.00000000', domesticStockValueKrw: '0', usStockValueKrw: '0', cryptoValueKrw: '0' },
  topPositions: [],
};

describe('existing user season summary', () => {
  it('renders nested summary user and requests the selected user endpoint', async () => {
    const h = createHarness();
    h.queries.set('ranking', h.ready(summaryFixture));
    const html = h.render('ranking/UserSeasonSummaryScreen', { route: { params: { userId: 'user-2' } } });
    assert.match(html, /trader-2/);
    assert.match(html, /silver/);
    assert.match(html, /999,998/);
    await h.queryOptions[0].queryFn();
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
  h.mockLocal('features/auth/useLogout', { useLogout: () => () => Promise.resolve() });
  h.mockLocal('components/charts', { DonutChart: () => null, LineChart: () => null });
  h.queries.set('me', h.ready({ nickname: 'trader-2', email: 'trader-2@example.com' }));
  h.queries.set('record', h.ready({ items: [] }));
  h.queries.set('ranking', h.ready(h.page));
  h.queries.set('tradingAccount', h.ready({ state: 'available', sectionErrors: [], summary: null, allocation: {}, wallets: [], positions: [], points: [] }));
  return account;
}

describe('other ranking consumers', () => {
  for (const screen of ['my/MyScreen', 'home/SeasonAccountHome']) {
    it(`${screen} preserves available/final/absent rank display and selected season requests`, async () => {
      const h = createHarness();
      const account = prepareAccountScreens(h);
      const props = { account };
      assert.match(h.render(screen, props), /#2/);
      assert.match(h.render(screen, props), /silver/);
      account.season.seasonStatus = 'settled';
      h.page.myRanking = { ...availableRankings.myRanking, provisionalTier: null, finalTier: 'diamond' };
      assert.match(h.render(screen, props), /diamond/);
      const options = h.queryOptions.filter((q) => q.queryKey[0] === 'ranking').at(-1);
      assert.equal(options.enabled, true);
      await options.queryFn();
      const params = new URL(h.requests.at(-1)!, 'https://fixture.invalid').searchParams;
      assert.equal(params.get('seasonId'), 'season-1');
      assert.equal(params.get('rankType'), 'final');
      assert.equal(params.get('scope'), 'near_me');
      assert.equal(params.get('limit'), '1');
      for (const state of [notJoined, unavailable]) {
        h.page.myRanking = state;
        const html = h.render(screen, props);
        assert.doesNotMatch(html, /#2|silver|diamond/);
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
