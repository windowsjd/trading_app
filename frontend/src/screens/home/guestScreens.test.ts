import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
// The same module instances the screens load (the harness requires them natively).
const guestState = require(resolve('src/features/auth/guestBrowsing.ts'));
const { GuestExitContext } = require(resolve('src/components/guest/guestExit.ts'));

const flush = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 30)); }); };
const unauthorized = () => Object.assign(new Error('401'), { isAxiosError: true, response: { status: 401, data: { error: { code: 'UNAUTHORIZED' } } } });
const hotAsset = (i: number) => ({
  id: `hot-${i}`, name: `시장 종목 ${i}`, symbol: `S${i}`, market: 'TEST', assetType: 'domestic_stock',
  priceCurrency: 'KRW', settlementCurrency: 'KRW', turnover: String(1000 - i), isActive: true, marketStatus: 'open', tradable: true,
  price: { state: 'available', priceCurrency: 'KRW', currentPrice: '100', changeRate: '1' },
});

/** Every plain string drawn in a Text (or passed as a notice title), for copy checks. */
function copy(renderer: any) {
  const strings: string[] = [];
  for (const node of renderer.root.findAll((n: any) => typeof n.type === 'string')) {
    if (node.type === 'Text') for (const child of [node.props.children].flat()) if (typeof child === 'string') strings.push(child);
    if (typeof node.props.title === 'string') strings.push(node.props.title);
    if (typeof node.props.label === 'string') strings.push(node.props.label);
  }
  return strings;
}

function harness() {
  const h: any = interactionHarness();
  h.native.SafeAreaView = 'SafeAreaView';
  h.requests = [];
  h.navigation = [];
  h.exits = [];
  h.common = {
    '../../components/common/CTAButton': { __esModule: true, default: 'CTA' },
    '../common/CTAButton': { __esModule: true, default: 'CTA' },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate: (...args: unknown[]) => h.navigation.push(args) }) },
    '../../components/common/SegmentedControl': { __esModule: true, default: 'Segments' },
    '../../features/market/AssetLogo': { __esModule: true, default: 'AssetLogo' },
    ...Object.fromEntries(['ErrorState', 'InlineEmptyState', 'SectionSkeleton', 'AdminDiagnosticPanel']
      .map((name) => ['../../components/states/' + name, { __esModule: true, default: name }])),
  };
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  h.mount = (Screen: unknown) => {
    const exit = { signIn: () => h.exits.push('signIn'), signUp: () => h.exits.push('signUp') };
    h.renderer = h.render(React.createElement(QueryClientProvider, { client: h.client },
      React.createElement(GuestExitContext.Provider, { value: exit }, React.createElement(Screen as never, {}))));
    return h.renderer;
  };
  h.byTestId = (id: string) => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id);
  h.press = (id: string) => act(() => h.byTestId(id)[0].props.onPress());
  h.close = () => { act(() => h.renderer.unmount()); h.client.clear(); };
  return h;
}

function guestHome(hot: (params: { assetType: string }) => Promise<unknown>) {
  const h = harness();
  const hero = h.load('src/screens/home/HomeAssetHero.tsx', h.common);
  const holdings = h.load('src/screens/home/HomeHoldings.tsx', {
    ...h.common,
    // Guest Home never reads an account: every account boundary refuses.
    '../../features/tradingAccount/api': { getTradingAccountPositions: async () => { throw new Error('holdings read'); } },
    '../../features/futures/useFuturesHoldings': { useFuturesHoldings: () => { throw new Error('futures read'); } },
    '../../components/tradingAccount/PositionAssetRow': { __esModule: true, default: 'PositionRow' },
    '../../components/tradingAccount/FuturesPositionRow': { __esModule: true, default: 'FuturesRow' },
  });
  const hotMarket = h.load('src/screens/home/HomeHotMarket.tsx', {
    ...h.common,
    '../../features/market/api': { getAssets: async (params: { assetType: string }) => { h.requests.push(params); return hot(params); } },
  });
  const Screen = h.load('src/screens/home/GuestHomeScreen.tsx', {
    ...h.common, './HomeAssetHero': hero, './HomeHoldings': holdings, './HomeHotMarket': hotMarket,
  }).default;
  h.mount(Screen);
  return h;
}

describe('guest Home (로그인 없이 둘러보기)', () => {
  afterEach(() => guestState.setGuestBrowsing(false));

  it("keeps Home's frame with a sign-in hero, a holdings notice and live HOT data — nothing account-scoped", async (t) => {
    guestState.setGuestBrowsing(true);
    const h = guestHome(async () => ({ assets: [0, 1, 2, 3, 4].map(hotAsset), pagination: { nextOffset: null } }));
    t.after(h.close);
    await flush();
    const text = copy(h.renderer);

    for (const line of ['총 자산', '로그인 후 나의 자산을 확인하세요', '가상투자를 시작하고 총자산과 수익률을 관리해 보세요.',
      '보유종목 및 포지션', '로그인하면 보유 중인 종목과 포지션을 확인할 수 있습니다.', 'HOT 🔥', '거래대금 TOP 5']) {
      assert.equal(text.includes(line), true, line);
    }
    // No banner, no stand-in numbers, no account identity.
    assert.equal(text.some((line) => line.includes('비회원')), false);
    // The asset overview (hero + holdings) carries no figure at all: no
    // 0원, 0% or sample holding stands in for an account that does not exist.
    const overview = [...h.byTestId('home-guest-hero'), ...h.byTestId('home-guest-holdings')]
      .flatMap((node: any) => copy({ root: node }));
    assert.equal(overview.length > 0, true);
    assert.equal(overview.some((line: string) => /\d/.test(line)), false);
    for (const id of ['home-total-asset', 'home-unrealized-pnl', 'home-summary-card', 'home-nickname', 'home-holdings']) {
      assert.equal(h.byTestId(id).length, 0, id);
    }
    for (const host of ['AccountSwitcher', 'ProfileAvatar', 'Trend', 'PositionRow', 'FuturesRow']) {
      assert.equal(h.renderer.root.findAll((n: any) => n.type === host).length, 0, host);
    }
    // The hero keeps the label's place: 총 자산 heads the same summary column.
    assert.equal(h.byTestId('home-guest-hero').length, 1);
    assert.deepEqual(h.requests.map((params: any) => [params.assetType, params.limit, params.sortBy]), [['domestic_stock', 5, 'turnover']]);
    assert.equal(h.renderer.root.findAll((n: any) => n.type === 'Pressable' && /^home-hot-item-/.test(n.props.testID ?? '')).length, 5);

    h.press('home-hot-item-hot-0');
    const [route, params] = h.navigation[0];
    assert.equal(route, 'MainTabs');
    assert.deepEqual([params.screen, params.params.screen, params.params.params.assetId, params.params.params.returnTab],
      ['MarketTab', 'AssetDetail', 'hot-0', 'HomeTab']);
  });

  it('로그인 and 회원가입 lead out of browsing from the hero', async (t) => {
    guestState.setGuestBrowsing(true);
    const h = guestHome(async () => ({ assets: [], pagination: { nextOffset: null } }));
    t.after(h.close);
    await flush();
    const login = h.byTestId('home-guest-hero-login');
    assert.equal(login.length, 1);
    assert.equal(login[0].type, 'CTA');
    assert.equal(login[0].props.label, '로그인');
    h.press('home-guest-hero-login');
    h.press('home-guest-hero-signup');
    assert.deepEqual(h.exits, ['signIn', 'signUp']);
  });

  it('a HOT market the server keeps from guests is a sign-in notice, read once, not an error', async (t) => {
    guestState.setGuestBrowsing(true);
    const h = guestHome(async () => { throw unauthorized(); });
    t.after(h.close);
    await flush();
    const notice = h.byTestId('home-hot-sign-in');
    assert.equal(notice.length, 1);
    assert.equal(notice[0].props.title, '로그인하면 국내주식 거래대금 TOP 5를 확인할 수 있습니다.');
    assert.equal(h.renderer.root.findAll((n: any) => n.type === 'ErrorState').length, 0);
    assert.equal(h.requests.length, 1, 'a refused market is not retried');
  });
});

describe('guest Wallet and 투자모드', () => {
  it('지갑 explains what an account holds and reads nothing', (t) => {
    const h = harness();
    const Screen = h.load('src/screens/wallet/GuestWalletScreen.tsx', h.common).default;
    h.mount(Screen);
    t.after(h.close);
    const text = copy(h.renderer);
    assert.equal(text.includes('지갑은 로그인 후 이용할 수 있습니다'), true);
    assert.equal(text.some((line) => line.includes('원화·달러 잔액과 환전, 이체, 거래 원장')), true);
    h.press('guest-wallet-login');
    h.press('guest-wallet-signup');
    assert.deepEqual(h.exits, ['signIn', 'signUp']);
  });

  it('투자모드 introduces the three modes; 시작하기 asks for sign-in and creates nothing', (t) => {
    const h = harness();
    const sheetMocks = {
      ...h.common,
      '../common/ScreenSheetHost': { SheetPortal: ({ children }: { children: unknown }) => children },
      '../common/InlineBottomSheet': {
        __esModule: true,
        default: ({ visible, title, testID, children }: any) => visible ? React.createElement('Sheet', { testID, title }, children) : null,
      },
    };
    const Screen = h.load('src/screens/entry/GuestModesScreen.tsx', sheetMocks).default;
    h.mount(Screen);
    t.after(h.close);
    const text = copy(h.renderer);
    for (const [title, description] of [
      ['시즌모드', '정해진 기간 동안 다른 참가자들과 가상투자 수익률을 경쟁합니다.'],
      ['일반모드', '나의 가상자산을 자유롭게 운용하고 투자 성과를 관리합니다.'],
      ['초보모드', '투자의 기초를 배우고 단계별 퀘스트를 수행합니다.'],
    ]) {
      assert.equal(text.includes(title), true, title);
      assert.equal(text.includes(description), true, description);
    }
    assert.equal(h.byTestId('guest-mode-sign-in').length, 0, 'no sheet before a press');

    h.press('guest-mode-season-start');
    const sheet = h.byTestId('guest-mode-sign-in');
    assert.equal(sheet.length, 1);
    assert.equal(sheet[0].props.title, '로그인이 필요합니다');
    assert.equal(copy(h.renderer).some((line) => line.startsWith('시즌모드는 로그인 후 시작할 수 있습니다.')), true);
    h.press('guest-mode-sign-in-signup');
    assert.deepEqual(h.exits, ['signUp']);
  });

  it('the screens import no account, wallet or order transport', () => {
    const { readFileSync } = require('node:fs');
    for (const file of ['src/screens/home/GuestHomeScreen.tsx', 'src/screens/wallet/GuestWalletScreen.tsx',
      'src/screens/entry/GuestModesScreen.tsx', 'src/components/guest/GuestSignIn.tsx', 'src/components/guest/GuestSignInSheet.tsx']) {
      const source = readFileSync(resolve(file), 'utf8');
      assert.doesNotMatch(source, /tradingAccount\/api|wallet\/api|order\/api|futures\/api|services\/api\/client|useTradingAccount/, file);
    }
  });
});
