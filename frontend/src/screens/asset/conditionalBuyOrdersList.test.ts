import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React } = require('../../../test/interactionTestHarness.cjs');
const { create, act } = require('react-test-renderer');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');

/**
 * The account's Conditional BUY list against a server that applies the real
 * `state=open|ended` filters: an old row the user can still cancel must never
 * hide behind newer ended rows, each open row keeps its own cancel path, and
 * a failed read is never shown as "no orders".
 */
type Row = Record<string, any>;
const OPEN = new Set(['watching', 'triggered', 'order_pending']);
let clock = Date.parse('2026-10-01T00:00:00.000Z');
function row(id: string, state: string, extra: Row = {}): Row {
  clock += 60_000;
  return {
    id, assetId: 'samsung', asset: { id: 'samsung', symbol: '005930', name: '삼성전자', market: 'KRX', assetType: 'domestic_stock' },
    side: 'buy', triggerCondition: 'at_or_below', triggerPrice: '69000.00000000', executionType: state === 'order_pending' ? 'limit' : 'market',
    limitPrice: state === 'order_pending' ? '68500.00000000' : null, quantity: '2.00000000', amount: null, currencyCode: 'KRW',
    status: OPEN.has(state) && state !== 'order_pending' ? state : 'ordered', state,
    trigger: state === 'watching' ? null : { triggeredAt: '2026-10-13T01:00:00.000Z', snapshotId: 's', evidence: null },
    order: state === 'order_pending' ? { orderId: `o-${id}`, orderType: 'limit', status: 'submitted', limitPrice: '68500.00000000', reservedAmount: '137137.00000000' } : null,
    attemptCount: 0, lastAttemptAt: null, failureCode: null, terminalReason: state === 'canceled' ? 'user_canceled' : null,
    createdAt: new Date(clock).toISOString(), endedAt: null, updatedAt: new Date(clock).toISOString(), ...extra,
  };
}

function listHarness() {
  const ui = interactionHarness('android');
  const h: any = {
    rows: { general: [], season: [] } as Record<string, Row[]>,
    enabled: true,
    reads: [] as Row[],
    cancels: [] as string[],
    alerts: [] as Row[],
    diagnostics: [] as unknown[],
    failOpen: null as unknown,
    failEnded: null as ((offset: number) => unknown) | null,
    gates: {} as Record<string, Promise<void>>,
    cancelError: null as unknown,
    plansEnabled: false,
    plans: [] as Row[],
    ui,
  };
  ui.native.Alert = { alert: (title: string, message: string, buttons: Row[]) => h.alerts.push({ title, message, buttons }) };
  ui.native.AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const Diagnostic = ({ error }: { error: unknown }) => { h.diagnostics.push(error); return React.createElement('AdminDiagnostic'); };
  const List = ui.load('src/screens/asset/ConditionalBuyOrdersList.tsx', {
    '../../features/conditional/conditionalBuyApi': {
      getConditionalBuyOrders: async (accountId: string, params: Row) => {
        h.reads.push({ accountId, ...params });
        if (h.gates[accountId]) await h.gates[accountId];
        if (params.state === 'open' && h.failOpen?.(params.offset)) throw h.failOpen(params.offset);
        if (params.state === 'ended' && h.failEnded?.(params.offset)) throw h.failEnded(params.offset);
        // Newest first, as the server orders them.
        const all = [...h.rows[accountId]].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const rows = all.filter((r) => params.state === 'open' ? OPEN.has(r.state) : !OPEN.has(r.state));
        const offset = params.offset ?? 0, limit = params.limit ?? 30;
        const page = rows.slice(offset, offset + limit);
        return {
          tradingAccountId: accountId,
          capabilities: { enabled: h.enabled, canCreate: h.enabled, canCancel: true, canUseLimit: h.enabled, markets: ['KRX'], maxLivePerAccount: 20 },
          conditionalOrders: page,
          pagination: { limit, offset, total: rows.length, returned: page.length, nextOffset: offset + page.length < rows.length ? offset + page.length : null },
        };
      },
      cancelConditionalBuyOrder: async (accountId: string, id: string) => {
        h.cancels.push(`watch:${accountId}:${id}`);
        const target = h.rows[accountId].find((r: Row) => r.id === id);
        target.state = 'canceled';
        return { tradingAccountId: accountId, conditionalOrder: target, duplicate: false };
      },
    },
    '../../features/tradingAccount/api': {
      cancelTradingAccountOrder: async (accountId: string, orderId: string) => {
        h.cancels.push(`order:${accountId}:${orderId}`);
        if (h.cancelError) throw h.cancelError;
        const target = h.rows[accountId].find((r: Row) => r.order?.orderId === orderId);
        target.state = 'order_canceled';
        target.order = { ...target.order, status: 'canceled', cancelReason: 'user_canceled' };
        return { tradingAccountId: accountId };
      },
    },
    '../../components/states/AdminDiagnosticPanel': { default: Diagnostic, __esModule: true },
    './AdminDiagnosticPanel': { default: Diagnostic, __esModule: true },
    // 손절가/익절가 plans of live watches: closed and empty unless a test opens them.
    '../../features/conditional/entryTpSlApi': {
      getAccountEntryTpSlPlans: async (accountId: string) => ({ tradingAccountId: accountId,
        capabilities: { spot: { enabled: h.plansEnabled, canCreate: h.plansEnabled }, futures: { enabled: false, canCreate: false }, canCancel: true, maxPendingPerAccount: 30, maxPerEntry: 10 },
        entry: null, plans: h.plans, pagination: { limit: 100, offset: 0, total: h.plans.length, returned: h.plans.length, nextOffset: null } }),
      getEntryTpSlPlans: async () => { throw new Error('the sheet is not opened here'); },
      createEntryTpSlPlans: async () => { throw new Error('not used here'); },
      cancelEntryTpSlPlan: async () => { throw new Error('not used here'); },
    },
    // A row's 손절가/익절가 sheet reads the account context (learning gates).
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({
      accounts: [], selectedAccountId: h.accountId, selectedAccount: null, isLoading: false }) },
  }).default;
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  h.accountId = 'general';
  const element = () => React.createElement(QueryClientProvider, { client: h.client },
    React.createElement(List, { accountId: h.accountId, isFocused: true, seasonUi: false }));
  h.settle = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
  h.mount = async () => { await act(async () => { h.renderer = create(element()); }); await h.settle(); };
  h.update = async () => { await act(async () => { h.renderer.update(element()); }); await h.settle(); };
  h.close = async () => { await act(async () => h.renderer.unmount()); h.client.clear(); };
  h.hosts = (predicate: (id: string) => boolean) => h.renderer.root.findAll((node: any) => typeof node.type === 'string'
    && typeof node.props.testID === 'string' && predicate(node.props.testID));
  h.has = (testID: string) => h.hosts((id: string) => id === testID).length > 0;
  /** Row ids in one section, in display order. */
  h.section = (section: 'open' | 'ended') => {
    const box = h.hosts((id: string) => id === `conditional-orders-${section}`)[0];
    if (!box) return null;
    return box.findAll((node: any) => typeof node.type === 'string' && /^conditional-order-[^-]+(?:-[^-]+)*$/u.test(node.props.testID ?? '')
      && !/-(state|cancel)$/u.test(node.props.testID)).map((node: any) => node.props.testID.slice('conditional-order-'.length));
  };
  h.textOf = (testID: string) => h.hosts((id: string) => id === testID).map((node: any) => [node.props.children].flat().join(''))[0] ?? null;
  h.json = () => JSON.stringify(h.renderer.toJSON());
  h.press = async (testID: string) => { await act(async () => h.hosts((id: string) => id === testID)[0].props.onPress()); await h.settle(); };
  /** Confirms the last Alert with 취소하기. */
  h.confirm = async () => {
    const alert = h.alerts[h.alerts.length - 1];
    await act(async () => alert.buttons.find((button: Row) => button.text === '취소하기').onPress());
    await h.settle();
  };
  return h;
}

/** 32 newer ended rows over three old open rows. */
function oldOpenBehindHistory(h: any, accountId = 'general') {
  const old = [row('w-old', 'watching'), row('t-old', 'triggered'), row('p-old', 'order_pending')];
  const ended = Array.from({ length: 32 }, (_, i) => row(`e${i}`, ['filled', 'canceled', 'failed', 'order_canceled'][i % 4],
    i % 4 === 0 ? { order: { orderId: `oe${i}`, status: 'executed', executedAt: '2026-10-13T02:00:00.000Z', executedPrice: '68000.00000000' } } : {}));
  h.rows[accountId] = [...old, ...ended];
}

describe('Conditional BUY list: 손절가/익절가 of live watches', () => {
  it('watching and order-pending rows offer it; one plan set per watch, also counted on the order it created; ended rows never', async (t) => {
    const h = listHarness();
    h.plansEnabled = true;
    h.rows.general = [row('w1', 'watching'), row('p1', 'order_pending'), row('f1', 'filled', { order: { orderId: 'of1', status: 'executed', executedAt: '2026-10-13T02:00:00.000Z', executedPrice: '68000.00000000' } })];
    h.plans = [
      { id: 'tp', entryType: 'spot_conditional_buy', entryId: 'w1', childOrderId: null, kind: 'take_profit', status: 'pending' },
      { id: 'sl', entryType: 'spot_conditional_buy', entryId: 'p1', childOrderId: 'o-p1', kind: 'stop_loss', status: 'pending' },
    ];
    await h.mount(); t.after(h.close);
    assert.equal(h.has('conditional-order-w1-tp-sl'), true);
    assert.equal(h.textOf('conditional-order-w1-tp-sl-summary'), '익절 1건');
    assert.equal(h.has('conditional-order-p1-tp-sl'), true);
    assert.equal(h.textOf('conditional-order-p1-tp-sl-summary'), '손절 1건');
    assert.equal(h.has('conditional-order-f1-tp-sl'), false, 'a filled watch takes no new plan');
  });
});

describe('Conditional BUY list: open rows are complete, ended history pages', () => {
  it('old watching/triggered/order_pending rows behind 32 newer ended rows are all listed and cancelable', async (t) => {
    const h = listHarness();
    oldOpenBehindHistory(h);
    await h.mount(); t.after(h.close);
    assert.deepEqual(h.section('open'), ['p-old', 't-old', 'w-old']);
    assert.equal(h.textOf('conditional-order-w-old-state'), '감시 중');
    assert.equal(h.textOf('conditional-order-t-old-state'), '조건 충족 · 주문 처리 중');
    assert.equal(h.textOf('conditional-order-p-old-state'), '주문 접수 · 체결 대기');
    assert.equal(h.section('ended')!.length, 30, 'first history page');
    assert.equal(h.section('ended')!.some((id: string) => id.endsWith('-old')), false);
    assert.equal(h.has('conditional-order-e0-cancel'), false, 'ended rows are read-only');
    // One open read, one history page: nothing more until asked.
    assert.deepEqual(h.reads.map((read: Row) => `${read.state}:${read.offset}:${read.limit}`), ['open:0:100', 'ended:0:30']);
    await h.press('conditional-orders-more');
    assert.equal(h.section('ended')!.length, 32);
    assert.equal(h.has('conditional-orders-more'), false);
    assert.equal(h.reads.filter((read: Row) => read.state === 'ended').length, 2);

    // Each state keeps its own cancel path.
    await h.press('conditional-order-w-old-cancel');
    await h.confirm();
    await h.press('conditional-order-t-old-cancel');
    await h.confirm();
    await h.press('conditional-order-p-old-cancel');
    assert.equal(h.alerts[h.alerts.length - 1].title, '연결된 지정가 주문 취소');
    await h.confirm();
    assert.deepEqual(h.cancels, ['watch:general:w-old', 'watch:general:t-old', 'order:general:o-p-old']);
    assert.deepEqual(h.section('open'), []);
    assert.equal(h.json().includes('진행 중인 조건주문이 없습니다.'), true);
    // They now read as history, with the server's final state.
    assert.equal(h.section('ended')!.includes('p-old'), true);
    assert.equal(h.textOf('conditional-order-p-old-state'), '연결 주문 취소');
  });

  it('a cancel that lost to a fill: reviewed copy, original error kept for admins, the server state shown', async (t) => {
    const h = listHarness();
    h.rows.general = [row('p1', 'order_pending')];
    await h.mount(); t.after(h.close);
    const conflict = { isAxiosError: true, response: { status: 409, data: { error: { code: 'ORDER_NOT_CANCELABLE', message: 'raw server text' } } } };
    h.cancelError = conflict;
    // The matcher filled it meanwhile.
    h.rows.general[0].state = 'filled';
    h.rows.general[0].order = { ...h.rows.general[0].order, status: 'executed', executedAt: '2026-10-13T02:00:00.000Z', executedPrice: '68500.00000000' };
    await h.press('conditional-order-p1-cancel');
    await h.confirm();
    assert.equal(h.textOf('conditional-orders-cancel-error'), '이미 체결되었거나 취소할 수 없는 주문입니다.');
    assert.equal(h.json().includes('raw server text'), false);
    assert.equal(h.diagnostics.some((error: unknown) => error === conflict), true, 'the admin panel gets the original error');
    assert.deepEqual(h.section('open'), []);
    assert.deepEqual(h.section('ended'), ['p1']);
    assert.equal(h.textOf('conditional-order-p1-state'), '체결 완료');
  });

  it('a failed open read is an error with retry, never "no orders"; so is a failed later page', async (t) => {
    const h = listHarness();
    h.rows.general = Array.from({ length: 150 }, (_, i) => row(`w${i}`, 'watching'));
    h.failOpen = (offset: number) => offset === 100 ? new Error('socket hang up') : null;
    await h.mount(); t.after(h.close);
    assert.equal(h.has('conditional-orders-retry'), true);
    assert.equal(h.has('conditional-orders-list'), false, 'no partial list');
    assert.equal(h.json().includes('조건주문이 없습니다'), false);
    h.failOpen = null;
    await h.press('conditional-orders-retry');
    assert.equal(h.section('open')!.length, 150);
  });

  it('a failed history page keeps what loaded and offers the page again', async (t) => {
    const h = listHarness();
    oldOpenBehindHistory(h);
    h.failEnded = (offset: number) => offset === 30 ? new Error('timeout') : null;
    await h.mount(); t.after(h.close);
    await h.press('conditional-orders-more');
    assert.equal(h.section('ended')!.length, 30);
    assert.equal(h.has('conditional-orders-more-error'), true);
    assert.equal(h.has('conditional-orders-more'), true);
    h.failEnded = null;
    await h.press('conditional-orders-more');
    assert.equal(h.section('ended')!.length, 32);
    assert.equal(h.has('conditional-orders-more-error'), false);
  });

  it('a failed first history page is an error, not an empty history', async (t) => {
    const h = listHarness();
    h.rows.general = [row('w1', 'watching')];
    h.failEnded = () => new Error('timeout');
    await h.mount(); t.after(h.close);
    assert.deepEqual(h.section('open'), ['w1']);
    assert.equal(h.has('conditional-orders-ended-error'), true);
    assert.equal(h.json().includes('종료된 조건주문이 없습니다.'), false);
  });

  it('with new registrations switched off, existing orders are still listed and canceled', async (t) => {
    const h = listHarness();
    h.enabled = false;
    oldOpenBehindHistory(h);
    await h.mount(); t.after(h.close);
    assert.equal(h.has('conditional-orders-disabled'), true);
    assert.deepEqual(h.section('open'), ['p-old', 't-old', 'w-old']);
    await h.press('conditional-order-w-old-cancel');
    await h.confirm();
    assert.deepEqual(h.cancels, ['watch:general:w-old']);
  });

  it("a late answer for the previous account is never shown in the new account's list", async (t) => {
    const h = listHarness();
    h.rows.general = [row('g-old', 'watching')];
    h.rows.season = [row('s-old', 'order_pending')];
    let release!: () => void;
    h.gates.general = new Promise<void>((resolve) => { release = resolve; });
    await h.mount(); t.after(h.close);
    h.accountId = 'season';
    await h.update();
    await act(async () => release());
    await h.settle();
    assert.deepEqual(h.section('open'), ['s-old']);
    assert.equal(h.json().includes('g-old'), false);
    await h.press('conditional-order-s-old-cancel');
    await h.confirm();
    assert.deepEqual(h.cancels, ['order:season:o-s-old']);
  });
});
