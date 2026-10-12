import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it, mock } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React } = require('../../../test/interactionTestHarness.cjs');
const { create, act } = require('react-test-renderer');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fillEvents = require('./fillEvents.ts');

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
        return { tradingAccountId: id, conditionalOrder: h.watchDetails[`${id}:${watchId}`], duplicate: false };
      },
    },
    '../../services/api/sessionOwnership': { getSessionGeneration: () => h.generation, isCurrentSession: (owner: number) => owner === h.generation },
    '../../app/navigation/navigationRef': { rootNavigationRef: { isReady: () => true, navigate: (...args: unknown[]) => h.navigation.push(args) } },
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
});
