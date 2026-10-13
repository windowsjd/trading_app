import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it, mock } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React } = require('../../../test/interactionTestHarness.cjs');
const { create, act } = require('react-test-renderer');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fillEvents = require('./fillEvents.ts');
// The same guard module instance the notifier loads (native require cache).
const questGuard = require('../quest/questNavigationGuard.ts');
const tracker = require('./fillTracker.ts');

type Row = Record<string, unknown>;
const asset = { id: 'samsung', name: '삼성전자', symbol: '005930' };
const submitted = (orderId: string) => ({ orderId, side: 'buy', orderType: 'limit', status: 'submitted', quantity: '3.000000', asset });
const executed = (orderId: string, extra: Row = {}) => ({ ...submitted(orderId), status: 'executed', executedAt: '2026-10-13T06:40:00.000Z', ...extra });
const seasonAccount = { id: 'season', mode: 'season', status: 'active', season: { seasonStatus: 'active' } };

function notifierHarness() {
  const ui = interactionHarness('android');
  const h: any = {
    accounts: [{ id: 'general', mode: 'general', status: 'active', season: null }, seasonAccount],
    pending: { general: [], season: [] } as Record<string, Row[]>,
    watches: { general: [], season: [] } as Record<string, Row[]>,
    watchEnabled: true,
    details: {} as Record<string, Row>,
    watchDetails: {} as Record<string, Row>,
    reads: [] as string[],
    navigation: [] as unknown[],
    announcements: [] as string[],
    generation: 1,
    ui,
  };
  ui.native.AppState = { currentState: 'active', addEventListener: (_: string, fn: (s: string) => void) => { h.appState = fn; return { remove() {} }; } };
  ui.native.AccessibilityInfo = { announceForAccessibility: (message: string) => h.announcements.push(message) };
  const page = (rows: Row[], tradingAccountId: string) => ({ state: 'available', tradingAccountId, orders: rows,
    pagination: { limit: 100, offset: 0, total: rows.length, returned: rows.length, nextOffset: null } });
  const Notifier = ui.load('src/features/order/OrderFillNotifier.tsx', {
    '../tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ accounts: h.accounts }) },
    '../tradingAccount/accountDisplay': { getAccountDisplay: (account: Row) => ({ title: account.id === 'season' ? '시즌 계정' : '일반모드' }) },
    '../tradingAccount/api': {
      getTradingAccountOrders: async (id: string) => { h.reads.push(`orders:${id}`); return page(h.pending[id], id); },
      getTradingAccountOrder: async (id: string, orderId: string) => {
        h.reads.push(`detail:${id}:${orderId}`);
        if (h.detailGate) await h.detailGate;
        if (h.detailError) throw h.detailError;
        const order = h.details[`${id}:${orderId}`];
        if (!order) throw new Error('network');
        return { order, execution: { state: order.status } };
      },
    },
    '../conditional/conditionalBuyApi': {
      getConditionalBuyOrders: async (id: string) => {
        h.reads.push(`watches:${id}`);
        return { tradingAccountId: id, capabilities: { enabled: h.watchEnabled }, conditionalOrders: h.watches[id],
          pagination: { limit: 100, offset: 0, total: h.watches[id].length, returned: h.watches[id].length, nextOffset: null } };
      },
      getConditionalBuyOrder: async (id: string, watchId: string) => {
        h.reads.push(`watch:${id}:${watchId}`);
        if (!h.watchDetails[`${id}:${watchId}`]) throw new Error('network');
        return { tradingAccountId: id, conditionalOrder: h.watchDetails[`${id}:${watchId}`], duplicate: false };
      },
    },
    '../../services/api/sessionOwnership': { getSessionGeneration: () => h.generation, isCurrentSession: (owner: number) => owner === h.generation },
    '../../app/navigation/navigationRef': { rootNavigationRef: { isReady: () => h.navReady !== false, navigate: (...args: unknown[]) => h.navigation.push(args) } },
    'react-native-safe-area-context': { SafeAreaInsetsContext: React.createContext(null), initialWindowMetrics: { insets: { top: 30, bottom: 0, left: 0, right: 0 } } },
  }).default;
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = () => React.createElement(QueryClientProvider, { client: h.client }, React.createElement(Notifier));
  h.mount = async () => { await act(async () => { h.renderer = create(element()); }); await h.settle(); };
  h.update = async () => { await act(async () => { h.renderer.update(element()); }); await h.settle(); };
  h.settle = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
  h.refresh = async () => { await act(async () => { await h.client.refetchQueries(); }); await h.settle(); };
  h.banner = () => h.renderer.root.findAll((node: any) => node.props.testID === 'order-fill-banner-title' && typeof node.type === 'string')
    .map((node: any) => [node.props.children].flat().join(''));
  h.detail = () => h.renderer.root.findAll((node: any) => node.props.testID === 'order-fill-banner-detail' && typeof node.type === 'string')
    .map((node: any) => [node.props.children].flat().join(''));
  h.finishAnimations = async () => act(async () => { ui.animations.splice(0).forEach((animation: any) => animation.finish()); });
  h.pressHistory = async () => act(async () => h.renderer.root.findAll((node: any) => node.props.testID === 'order-fill-banner-history' && typeof node.type === 'string')[0].props.onPress());
  h.notOpened = () => h.renderer.root.findAll((node: any) => node.props.testID === 'order-fill-banner-not-opened' && typeof node.type === 'string')
    .map((node: any) => [node.props.children].flat().join(''));
  h.detailReads = (orderId: string) => h.reads.filter((read: string) => read.endsWith(`:${orderId}`) && read.startsWith('detail:')).length;
  // Background and back: the app's own re-sync point.
  h.foreground = async () => { await act(async () => h.appState('background')); await h.settle(); await act(async () => h.appState('active')); await h.settle(); };
  h.close = async () => { await act(async () => h.renderer.unmount()); h.client.clear(); };
  return h;
}

describe('real-fill banner', () => {
  it('ignores past fills and open orders at first read, then announces a later execution once', async (t) => {
    const h = notifierHarness();
    h.pending.general = [submitted('o1')];
    await h.mount(); t.after(h.close);
    assert.deepEqual(h.banner(), []);
    h.pending.general = [];
    h.details['general:o1'] = executed('o1');
    await h.refresh();
    assert.deepEqual(h.banner(), ['삼성전자 매수 체결 완료']);
    assert.deepEqual(h.detail(), ['일반모드 · 체결 수량 3']);
    assert.deepEqual(h.announcements, ['삼성전자 매수 체결 완료. 일반모드 · 체결 수량 3']);
    const detailReads = h.reads.filter((read: string) => read.startsWith('detail:')).length;
    await h.refresh();
    await h.update();
    assert.equal(h.reads.filter((read: string) => read.startsWith('detail:')).length, detailReads, 'no re-resolve on refetch/re-render');
    assert.equal(h.banner().length, 1);
  });

  it('finds an old limit order among many open ones (complete set, not a first page)', async (t) => {
    const h = notifierHarness();
    h.pending.general = Array.from({ length: 60 }, (_, i) => submitted(`o${i}`));
    await h.mount(); t.after(h.close);
    h.pending.general = h.pending.general.slice(1);
    h.details['general:o0'] = executed('o0');
    await h.refresh();
    assert.deepEqual(h.banner(), ['삼성전자 매수 체결 완료']);
    assert.deepEqual(h.reads.filter((read: string) => read.startsWith('detail:')), ['detail:general:o0']);
  });

  it('stays silent for a cancel, a LOC that closed above the limit or expired, and an unreadable result', async (t) => {
    const h = notifierHarness();
    h.pending.general = [submitted('c1'), submitted('loc-unfilled'), submitted('loc-expired'), submitted('unknown')];
    await h.mount(); t.after(h.close);
    h.pending.general = [];
    h.details['general:c1'] = { ...submitted('c1'), status: 'canceled', cancelReason: 'user_canceled' };
    h.details['general:loc-unfilled'] = { ...submitted('loc-unfilled'), status: 'canceled', limitOnClose: { status: 'unfilled' } };
    h.details['general:loc-expired'] = { ...submitted('loc-expired'), status: 'canceled', limitOnClose: { status: 'expired' } };
    await h.refresh();
    assert.deepEqual(h.banner(), []);
  });

  it('says LOC for a confirmed close fill', async (t) => {
    const h = notifierHarness();
    h.pending.general = [submitted('loc-1')];
    await h.mount(); t.after(h.close);
    h.pending.general = [];
    h.details['general:loc-1'] = executed('loc-1', { limitOnClose: { status: 'filled', closePrice: '69000' } });
    await h.refresh();
    assert.deepEqual(h.banner(), ['삼성전자 LOC 매수 체결 완료']);
  });

  it('follows a Conditional BUY to its linked order: triggered is silent, the order fill is announced', async (t) => {
    const h = notifierHarness();
    h.watches.general = [{ id: 'w1', state: 'watching' }, { id: 'w2', state: 'watching' }];
    await h.mount(); t.after(h.close);
    // w1 triggered (still live): nothing. w2 left the live list: its order executed.
    h.watches.general = [{ id: 'w1', state: 'triggered' }];
    h.watchDetails['general:w2'] = { id: 'w2', state: 'filled', order: { orderId: 'o-c', status: 'executed' } };
    h.details['general:o-c'] = executed('o-c', { orderType: 'market' });
    await h.refresh();
    assert.deepEqual(h.banner(), ['삼성전자 매수 체결 완료']);
    assert.deepEqual(h.detail(), ['일반모드 · 조건주문 · 체결 수량 3']);
    assert.equal(h.reads.includes('watch:general:w1'), false);
  });

  it('a watch that placed a limit order is announced only when that order fills', async (t) => {
    const h = notifierHarness();
    h.watches.general = [{ id: 'w3', state: 'watching' }];
    await h.mount(); t.after(h.close);
    h.watches.general = [];
    h.watchDetails['general:w3'] = { id: 'w3', state: 'order_pending', order: { orderId: 'o-l', status: 'submitted' } };
    h.pending.general = [submitted('o-l')];
    await h.refresh();
    assert.deepEqual(h.banner(), []);
    h.pending.general = [];
    h.details['general:o-l'] = executed('o-l');
    await h.refresh();
    assert.deepEqual(h.detail(), ['일반모드 · 조건주문 · 체결 수량 3']);
  });

  it("opens the history of the order's own account, not the selected one", async (t) => {
    const h = notifierHarness();
    h.pending.season = [submitted('s1')];
    await h.mount(); t.after(h.close);
    h.pending.season = [];
    h.details['season:s1'] = executed('s1', { side: 'sell' });
    await h.refresh();
    assert.deepEqual(h.banner(), ['삼성전자 매도 체결 완료']);
    assert.deepEqual(h.detail(), ['시즌 계정 · 체결 수량 3']);
    await act(async () => h.renderer.root.findAll((node: any) => node.props.testID === 'order-fill-banner-history' && typeof node.type === 'string')[0].props.onPress());
    assert.deepEqual(h.navigation, [['TradeHistory', { accountId: 'season' }]]);
    await h.finishAnimations();
    assert.deepEqual(h.banner(), [], 'the banner leaves after the action');
  });

  it('shows several fills one at a time', async (t) => {
    const h = notifierHarness();
    h.pending.general = [submitted('a'), submitted('b')];
    await h.mount(); t.after(h.close);
    h.pending.general = [];
    h.details['general:a'] = executed('a');
    h.details['general:b'] = executed('b', { side: 'sell' });
    await h.refresh();
    assert.equal(h.banner().length, 1);
    const first = h.banner()[0];
    await act(async () => h.renderer.root.findAll((node: any) => node.props.testID === 'order-fill-banner-history' && typeof node.type === 'string')[0].props.onPress());
    await h.finishAnimations();
    assert.equal(h.banner().length, 1);
    assert.notEqual(h.banner()[0], first);
  });

  it("accepts hand-offs only for the signed-in user's accounts and drops everything on a session change", async (t) => {
    const h = notifierHarness();
    await h.mount(); t.after(h.close);
    await act(async () => fillEvents.emitOrderFillEvent({ kind: 'filled', accountId: 'someone-else', order: executed('x1') }));
    assert.deepEqual(h.banner(), []);
    await act(async () => fillEvents.emitOrderFillEvent({ kind: 'filled', accountId: 'general', order: executed('x2') }));
    await act(async () => fillEvents.emitOrderFillEvent({ kind: 'filled', accountId: 'general', order: executed('x2') }));
    assert.equal(h.banner().length, 1, 'a repeated hand-off is the same fill');
    h.generation += 1;
    h.accounts = [];
    await h.update();
    assert.deepEqual(h.banner(), [], "a new session never shows the previous user's fill");
  });

  it('pauses reads in the background and re-reads on return', async (t) => {
    const h = notifierHarness();
    h.pending.general = [submitted('o1')];
    await h.mount(); t.after(h.close);
    await act(async () => h.appState('background'));
    await h.settle();
    h.pending.general = [];
    h.details['general:o1'] = executed('o1');
    const before = h.reads.length;
    await h.settle();
    assert.equal(h.reads.length, before);
    await act(async () => h.appState('active'));
    await h.settle();
    assert.deepEqual(h.banner(), ['삼성전자 매수 체결 완료']);
  });
});

describe('unresolved fill reads (detail read failures)', () => {
  it('a real fill whose detail read keeps failing is not forgotten: it is announced once the server answers', async (t) => {
    const h = notifierHarness();
    h.pending.general = [submitted('o1')];
    await h.mount(); t.after(h.close);
    h.pending.general = [];
    // The order executed, but its detail read fails: unknown, not a cancel.
    await h.refresh();
    assert.equal(h.detailReads('o1'), 1);
    assert.deepEqual(h.banner(), []);
    // List re-reads do not hammer the detail read before its backoff.
    await h.refresh();
    await h.refresh();
    assert.equal(h.detailReads('o1'), 1);
    // Three more failed checks (past the old 3-attempt bound) at re-sync points.
    for (const expected of [2, 3, 4]) {
      await h.foreground();
      assert.equal(h.detailReads('o1'), expected);
      assert.deepEqual(h.banner(), []);
    }
    h.details['general:o1'] = executed('o1');
    await h.foreground();
    assert.deepEqual(h.banner(), ['삼성전자 매수 체결 완료']);
    await h.foreground();
    await h.refresh();
    assert.equal(h.detailReads('o1'), 5, 'answered: never read again');
    assert.equal(h.banner().length, 1);
  });

  it('retries on its own foreground backoff timer, and never in the background', async (t) => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T06:00:00.000Z') });
    const realSetTimeout = globalThis.setTimeout;
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if ((ms ?? 0) === tracker.FILL_RETRY_BASE_MS || (ms ?? 0) === 2 * tracker.FILL_RETRY_BASE_MS) {
        scheduled.push({ fn, ms: ms ?? 0 });
        return 0;
      }
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout;
    t.after(() => { globalThis.setTimeout = realSetTimeout; mock.timers.reset(); });
    const h = notifierHarness();
    h.pending.general = [submitted('o1')];
    await h.mount(); t.after(h.close);
    h.pending.general = [];
    // The mocked clock is frozen: move it so the re-read is a new read.
    mock.timers.tick(10);
    await h.refresh();
    assert.equal(h.detailReads('o1'), 1);
    assert.deepEqual(scheduled.map((entry) => entry.ms), [tracker.FILL_RETRY_BASE_MS], 'one timer, 15 s');
    mock.timers.tick(tracker.FILL_RETRY_BASE_MS);
    await act(async () => scheduled.shift()!.fn());
    await h.settle();
    assert.equal(h.detailReads('o1'), 2);
    assert.deepEqual(scheduled.map((entry) => entry.ms), [2 * tracker.FILL_RETRY_BASE_MS], 'backs off to 30 s');
    // In the background the timer is cleared and nothing is read.
    await act(async () => h.appState('background'));
    await h.settle();
    const before = h.reads.length;
    mock.timers.tick(10 * tracker.FILL_RETRY_BASE_MS);
    await h.settle();
    assert.equal(h.reads.length, before);
    h.details['general:o1'] = executed('o1');
    await act(async () => h.appState('active'));
    await h.settle();
    assert.deepEqual(h.banner(), ['삼성전자 매수 체결 완료']);
    assert.equal(h.detailReads('o1'), 3);
  });

  it('one detail read at a time per order, so one announcement', async (t) => {
    const h = notifierHarness();
    h.pending.general = [submitted('o1')];
    await h.mount(); t.after(h.close);
    h.pending.general = [];
    await h.refresh();
    let release!: () => void;
    h.detailGate = new Promise<void>((resolve) => { release = resolve; });
    h.details['general:o1'] = executed('o1');
    await act(async () => h.appState('background'));
    await act(async () => h.appState('active'));
    await act(async () => h.appState('background'));
    await act(async () => h.appState('active'));
    await h.settle();
    assert.equal(h.detailReads('o1'), 2, 'the second wake found the read still running');
    h.detailGate = null;
    await act(async () => release());
    await h.settle();
    assert.deepEqual(h.banner(), ['삼성전자 매수 체결 완료']);
  });

  it('a definite refusal (404) stops asking and announces nothing', async (t) => {
    const h = notifierHarness();
    h.pending.general = [submitted('o1')];
    await h.mount(); t.after(h.close);
    h.pending.general = [];
    h.detailError = { isAxiosError: true, response: { status: 404, data: { error: { code: 'ORDER_NOT_FOUND' } } } };
    await h.refresh();
    h.detailError = null;
    h.details['general:o1'] = executed('o1');
    await h.foreground();
    assert.equal(h.detailReads('o1'), 1);
    assert.deepEqual(h.banner(), []);
  });

  it('a failed watch read is kept too; its linked order fill is announced as conditional', async (t) => {
    const h = notifierHarness();
    h.watches.general = [{ id: 'w1', state: 'watching' }];
    await h.mount(); t.after(h.close);
    h.watches.general = [];
    await h.refresh();
    assert.equal(h.reads.filter((read: string) => read === 'watch:general:w1').length, 1);
    h.watchDetails['general:w1'] = { id: 'w1', state: 'filled', order: { orderId: 'o-c', status: 'executed' } };
    h.details['general:o-c'] = executed('o-c', { orderType: 'market' });
    await h.foreground();
    assert.deepEqual(h.banner(), ['삼성전자 매수 체결 완료']);
    assert.deepEqual(h.detail(), ['일반모드 · 조건주문 · 체결 수량 3']);
  });

  it('watching and triggered stay silent even when re-checked', async (t) => {
    const h = notifierHarness();
    h.watches.general = [{ id: 'w1', state: 'watching' }];
    await h.mount(); t.after(h.close);
    h.watches.general = [];
    await h.refresh();
    h.watchDetails['general:w1'] = { id: 'w1', state: 'triggered', order: null };
    await h.foreground();
    assert.deepEqual(h.banner(), []);
  });

  it("a session change drops the previous user's unresolved targets", async (t) => {
    const h = notifierHarness();
    h.pending.general = [submitted('o1')];
    await h.mount(); t.after(h.close);
    h.pending.general = [];
    await h.refresh();
    assert.equal(h.detailReads('o1'), 1);
    h.generation += 1;
    await h.update();
    h.details['general:o1'] = executed('o1');
    await h.foreground();
    assert.equal(h.detailReads('o1'), 1, 'the new session never re-reads it');
    assert.deepEqual(h.banner(), []);
  });
});

describe('내역 보기 and the beginner guide', () => {
  async function filled(t: any, accountId = 'season') {
    const h = notifierHarness();
    h.pending[accountId] = [submitted('s1')];
    await h.mount(); t.after(h.close);
    h.pending[accountId] = [];
    h.details[`${accountId}:s1`] = executed('s1');
    await h.refresh();
    assert.equal(h.banner().length, 1);
    return h;
  }

  it('an active guide holds the move: no navigation, the guide is told, the banner stays and says why', async (t) => {
    const h = await filled(t);
    let held = 0;
    const onBlocked = () => { held += 1; };
    questGuard.setQuestNavigationGuard(onBlocked, 'limitBuy');
    t.after(() => questGuard.setQuestNavigationGuard(onBlocked, null));
    await h.pressHistory();
    await h.settle();
    assert.deepEqual(h.navigation, []);
    assert.equal(held, 1, 'the guide shows its 안내 종료 notice');
    assert.deepEqual(h.notOpened(), ['학습 안내 중이라 거래 내역을 열지 않았어요. 안내를 종료한 뒤 다시 눌러 주세요.']);
    assert.deepEqual(h.announcements.slice(-1), ['학습 안내 중이라 거래 내역을 열지 않았어요. 안내를 종료한 뒤 다시 눌러 주세요.']);
    await h.finishAnimations();
    assert.deepEqual(h.banner(), ['삼성전자 매수 체결 완료'], 'not dismissed as if it had opened');
    // 안내 종료 lifts the guard; the same banner now opens the order's own account.
    questGuard.setQuestNavigationGuard(onBlocked, null);
    await h.pressHistory();
    assert.deepEqual(h.navigation, [['TradeHistory', { accountId: 'season' }]]);
    await h.finishAnimations();
    assert.deepEqual(h.banner(), []);
  });

  it('navigation that is not ready yet is reported, not treated as opened', async (t) => {
    const h = await filled(t, 'general');
    h.navReady = false;
    await h.pressHistory();
    assert.deepEqual(h.navigation, []);
    assert.deepEqual(h.notOpened(), ['지금은 거래 내역을 열 수 없어요. 잠시 후 다시 눌러 주세요.']);
    await h.finishAnimations();
    assert.equal(h.banner().length, 1);
    h.navReady = true;
    await h.pressHistory();
    assert.deepEqual(h.navigation, [['TradeHistory', { accountId: 'general' }]]);
  });
});

describe('banner timing', () => {
  it('leaves by itself after the visible time and skips motion under Reduced Motion', () => {
    const ui = interactionHarness('android');
    ui.native.AccessibilityInfo = { announceForAccessibility: () => {} };
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const done: string[] = [];
      for (const reduced of [false, true]) {
        ui.reduced = reduced;
        ui.animations.length = 0;
        const Banner = ui.load('src/features/order/OrderFillBanner.tsx', {
          'react-native-safe-area-context': { SafeAreaInsetsContext: React.createContext(null), initialWindowMetrics: null },
        });
        const notice = { id: `a:${reduced}`, accountId: 'a', orderId: 'o', title: '비트코인 매수 체결 완료', detail: null };
        let renderer: any;
        act(() => { renderer = create(React.createElement(Banner.default, { notice, onDone: () => done.push(notice.id), onOpenHistory: () => {} })); });
        assert.equal(ui.animations.length, reduced ? 0 : 1);
        act(() => { mock.timers.tick(Banner.FILL_BANNER_VISIBLE_MS - 1); });
        assert.deepEqual(done.filter((id) => id === notice.id), []);
        act(() => { mock.timers.tick(1); });
        if (!reduced) act(() => ui.animations.forEach((animation: any) => animation.finish()));
        assert.deepEqual(done.filter((id) => id === notice.id), [notice.id]);
        act(() => renderer.unmount());
      }
    } finally {
      mock.timers.reset();
    }
  });

  it('a held 내역 보기 keeps the banner past its usual time, then it leaves', () => {
    const ui = interactionHarness('android');
    ui.native.AccessibilityInfo = { announceForAccessibility: () => {} };
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const done: string[] = [];
      const Banner = ui.load('src/features/order/OrderFillBanner.tsx', {
        'react-native-safe-area-context': { SafeAreaInsetsContext: React.createContext(null), initialWindowMetrics: null },
      });
      const notice = { id: 'a:held', accountId: 'a', orderId: 'o', title: '비트코인 매수 체결 완료', detail: null };
      let renderer: any;
      act(() => { renderer = create(React.createElement(Banner.default, { notice, onDone: () => done.push(notice.id), onOpenHistory: () => 'held' })); });
      act(() => { mock.timers.tick(1000); });
      act(() => renderer.root.findAll((node: any) => node.props.testID === 'order-fill-banner-history' && typeof node.type === 'string')[0].props.onPress());
      act(() => { mock.timers.tick(Banner.FILL_BANNER_VISIBLE_MS); });
      act(() => ui.animations.forEach((animation: any) => animation.finish()));
      assert.deepEqual(done, [], 'still showing the reason');
      act(() => { mock.timers.tick(Banner.FILL_BANNER_HELD_MS - Banner.FILL_BANNER_VISIBLE_MS); });
      act(() => ui.animations.forEach((animation: any) => animation.finish()));
      assert.deepEqual(done, [notice.id]);
      act(() => renderer.unmount());
    } finally {
      mock.timers.reset();
    }
  });
});
