import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React } = require('../../../test/interactionTestHarness.cjs');
const { create, act } = require('react-test-renderer');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');

/**
 * The account's SELL intents of one family against a server applying the
 * real `state=open|ended` + `kind` filters: an old live stop-loss never hides
 * behind newer ended rows, each row keeps the target apart from what can or
 * did really sell, and each open row keeps its own cancel path.
 */
type Row = Record<string, any>;
const OPEN = new Set(['watching', 'triggered', 'order_pending']);
let clock = Date.parse('2026-10-01T00:00:00.000Z');
function row(id: string, state: string, kind = 'stop_loss', extra: Row = {}): Row {
  clock += 60_000;
  return {
    id, assetId: 'samsung', asset: { id: 'samsung', symbol: '005930', name: '삼성전자', market: 'KRX', assetType: 'domestic_stock' },
    side: 'sell', kind, positionId: 'p1', triggerCondition: kind === 'take_profit' ? 'at_or_above' : 'at_or_below',
    triggerPrice: '69000.00000000', executionType: state === 'order_pending' ? 'limit' : 'market',
    limitPrice: state === 'order_pending' ? '68500.00000000' : null, quantity: '10.00000000', currencyCode: 'KRW',
    status: OPEN.has(state) && state !== 'order_pending' ? state : 'ordered', state, position: null,
    executionAvailableQuantity: null, quantityLimited: false,
    trigger: state === 'watching' ? null : { triggeredAt: '2026-10-13T01:00:00.000Z', snapshotId: 's', evidence: null },
    order: state === 'order_pending' ? { orderId: `o-${id}`, orderType: 'limit', status: 'submitted', quantity: '4.00000000', limitPrice: '68500.00000000', reservedQuantity: '4.00000000' } : null,
    attemptCount: 0, lastAttemptAt: null, failureCode: null, terminalReason: null,
    createdAt: new Date(clock).toISOString(), endedAt: null, updatedAt: new Date(clock).toISOString(), ...extra,
  };
}

function listHarness(family: 'condition' | 'protection') {
  const ui = interactionHarness('android');
  const h: any = { rows: [] as Row[], reads: [] as Row[], cancels: [] as string[], alerts: [] as Row[], enabled: true, ui };
  ui.native.Alert = { alert: (title: string, message: string, buttons: Row[]) => h.alerts.push({ title, message, buttons }) };
  ui.native.AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const matches = (r: Row, kind?: string) => !kind || (kind === 'condition' ? r.kind === 'condition' : r.kind !== 'condition');
  const List = ui.load('src/screens/asset/ConditionalSellOrdersList.tsx', {
    '../../features/conditional/conditionalSellApi': {
      getConditionalSellOrders: async (accountId: string, params: Row) => {
        h.reads.push({ accountId, ...params });
        const all = [...h.rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const rows = all.filter((r) => matches(r, params.kind) && (params.state === 'open' ? OPEN.has(r.state) : !OPEN.has(r.state)));
        const offset = params.offset ?? 0, limit = params.limit ?? 30;
        const page = rows.slice(offset, offset + limit);
        return {
          tradingAccountId: accountId,
          capabilities: { enabled: h.enabled, condition: { enabled: h.enabled, canCreate: h.enabled, canUseLimit: true },
            protection: { enabled: h.enabled, canCreate: h.enabled, canUseLimit: true }, canCancel: true, markets: ['KRX'], maxLivePerAccount: 30 },
          conditionalOrders: page,
          pagination: { limit, offset, total: rows.length, returned: page.length, nextOffset: offset + page.length < rows.length ? offset + page.length : null },
        };
      },
      cancelConditionalSellOrder: async (accountId: string, id: string) => {
        h.cancels.push(`intent:${accountId}:${id}`);
        const target = h.rows.find((r: Row) => r.id === id);
        target.state = 'canceled';
        target.status = 'canceled';
        target.terminalReason = 'user_canceled';
        return { tradingAccountId: accountId, conditionalOrder: target, duplicate: false };
      },
    },
    '../../features/tradingAccount/api': {
      cancelTradingAccountOrder: async (accountId: string, orderId: string) => {
        h.cancels.push(`order:${accountId}:${orderId}`);
        const target = h.rows.find((r: Row) => r.order?.orderId === orderId);
        target.state = 'order_canceled';
        target.order = { ...target.order, status: 'canceled', cancelReason: 'user_canceled' };
        return { tradingAccountId: accountId };
      },
    },
    '../../components/states/AdminDiagnosticPanel': { default: () => React.createElement('AdminDiagnostic'), __esModule: true },
    './AdminDiagnosticPanel': { default: () => React.createElement('AdminDiagnostic'), __esModule: true },
  }).default;
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = () => React.createElement(QueryClientProvider, { client: h.client },
    React.createElement(List, { accountId: 'general', family, isFocused: true, seasonUi: false }));
  h.settle = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
  h.mount = async () => { await act(async () => { h.renderer = create(element()); }); await h.settle(); };
  h.close = async () => { await act(async () => h.renderer.unmount()); h.client.clear(); };
  h.hosts = (predicate: (id: string) => boolean) => h.renderer.root.findAll((node: any) => typeof node.type === 'string'
    && typeof node.props.testID === 'string' && predicate(node.props.testID));
  h.has = (testID: string) => h.hosts((id: string) => id === testID).length > 0;
  h.section = (section: 'open' | 'ended') => {
    const box = h.hosts((id: string) => id === `sell-orders-${family}-${section}`)[0];
    if (!box) return null;
    return box.findAll((node: any) => typeof node.type === 'string' && /^sell-order-[^-]+$/u.test(node.props.testID ?? ''))
      .map((node: any) => node.props.testID.slice('sell-order-'.length));
  };
  h.textOf = (testID: string) => h.hosts((id: string) => id === testID).map((node: any) => [node.props.children].flat().join(''))[0] ?? null;
  h.press = async (testID: string) => { await act(async () => h.hosts((id: string) => id === testID)[0].props.onPress()); await h.settle(); };
  h.confirm = async () => {
    const alert = h.alerts[h.alerts.length - 1];
    await act(async () => alert.buttons.find((button: Row) => button.text === '취소하기').onPress());
    await h.settle();
  };
  return h;
}

describe('SELL intent list (stop-loss / take-profit family)', () => {
  it('old live rows behind 32 newer ended rows are complete; target vs executable is explained', async (t) => {
    const h = listHarness('protection');
    const live = row('sl', 'watching', 'stop_loss', {
      position: { holdingQuantity: '10.00000000', reservedQuantity: '6.00000000', availableQuantity: '4.00000000', executableQuantity: '4.00000000' },
    });
    const pending = row('tp', 'order_pending', 'take_profit');
    const ended = Array.from({ length: 32 }, (_, i) => row(`e${i}`, i % 2 ? 'canceled' : 'filled', i % 2 ? 'stop_loss' : 'take_profit',
      i % 2 ? { terminalReason: 'position_closed' }
        : { order: { orderId: `oe${i}`, status: 'executed', quantity: '4.00000000', executedAt: '2026-10-13T02:00:00.000Z', executedPrice: '70000.00000000' },
          quantityLimited: true, executionAvailableQuantity: '4.00000000' }));
    // A condition-family row is never listed here.
    h.rows = [live, pending, ...ended, row('cond', 'watching', 'condition')];
    await h.mount(); t.after(h.close);
    assert.deepEqual(h.section('open'), ['tp', 'sl']);
    assert.equal(h.section('ended')!.length, 30);
    assert.deepEqual(h.reads.map((read: Row) => `${read.state}:${read.kind}:${read.offset}`), ['open:protection:0', 'ended:protection:0']);
    assert.equal(h.textOf('sell-order-sl-state'), '감시 중');
    assert.equal(h.textOf('sell-order-sl-quantity'), '지금 발동 시 실제 매도 수량 4 (설정 10 · 매도 가능 4 · 다른 주문 예약 6)');
    assert.equal(h.textOf('sell-order-tp-state'), '매도 접수 · 체결 대기');
    assert.equal(h.textOf('sell-order-e30-quantity'), '설정 수량 10 중 실제 주문 수량 4 (발동 시 매도 가능 4)');
    assert.equal(h.textOf('sell-order-e30-state'), '체결 완료');
    assert.equal(h.has('sell-order-e30-cancel'), false, 'ended rows are read-only');
    await h.press('sell-orders-protection-more');
    assert.equal(h.section('ended')!.length, 32);

    // Each open row keeps its own cancel path.
    await h.press('sell-order-sl-cancel');
    assert.equal(h.alerts[h.alerts.length - 1].title, '손절 매도 설정 취소');
    await h.confirm();
    await h.press('sell-order-tp-cancel');
    assert.equal(h.alerts[h.alerts.length - 1].title, '연결된 지정가 매도 취소');
    await h.confirm();
    assert.deepEqual(h.cancels, ['intent:general:sl', 'order:general:o-tp']);
    assert.deepEqual(h.section('open'), []);
  });

  it('flags off: existing rows stay readable and cancelable, with the reason shown', async (t) => {
    const h = listHarness('condition');
    h.enabled = false;
    h.rows = [row('c1', 'watching', 'condition')];
    await h.mount(); t.after(h.close);
    assert.equal(h.has('sell-orders-condition-disabled'), true);
    assert.deepEqual(h.section('open'), ['c1']);
    await h.press('sell-order-c1-cancel');
    await h.confirm();
    assert.deepEqual(h.cancels, ['intent:general:c1']);
  });
});
