import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSpotChartPriceLines } from './spotChartPriceLines.ts';

const position = (overrides: Record<string, unknown> = {}) => ({
  positionId: 'p-1', assetId: 'aapl', currencyCode: 'USD', quantity: '3', averageCost: '180.25',
  valuation: { state: 'available', returnRate: '5.2', unrealizedPnl: '28.2', positionValue: '569', priceCurrency: 'USD' },
  ...overrides,
}) as any;
const order = (id: string, overrides: Record<string, unknown> = {}) => ({
  orderId: id, assetId: 'aapl', currencyCode: 'USD', side: 'buy', orderType: 'limit', status: 'submitted', limitPrice: '170', quantity: '1',
  ...overrides,
}) as any;
const condition = (id: string, state: string, overrides: Record<string, unknown> = {}) => ({
  id, assetId: 'aapl', currencyCode: 'USD', state, triggerPrice: '160', limitPrice: '159', executionType: 'limit', ...overrides,
}) as any;
const oco = (status: string, legs: Array<[string, string, string]>, capabilities: Record<string, unknown> = {}) => ({
  tradingAccountId: 'A',
  capabilities: { enabled: true, canCreateSpot: false, canCreateFutures: false, canMonitorSpot: true, canCancel: true, canUseSpotLimit: false, ...capabilities },
  groups: [{ id: 'g', domain: 'spot', assetId: 'aapl', currencyCode: 'USD', status,
    legs: legs.map(([id, kind, triggerPrice]) => ({ id, kind, triggerPrice, state: id.startsWith('armed') ? 'armed' : 'holding' })) }],
}) as any;
const build = (input: Record<string, unknown>) => buildSpotChartPriceLines({
  assetId: 'aapl', currencyCode: 'USD', position: null, pendingOrders: [], conditionalBuys: [], conditionalSells: [], protections: null,
  ...input,
} as any);
const summary = (lines: ReturnType<typeof build>) => lines.map((line) => [line.kind, line.title, line.price, line.note ?? null]);

describe('spot chart lines', () => {
  it('the holding: its average price with the server return rate, signed, whatever its sign', () => {
    assert.deepEqual(summary(build({ position: position() })), [['average', '평단가', 180.25, '+5.2%']]);
    assert.deepEqual(summary(build({ position: position({ valuation: { state: 'available', returnRate: '-12.3456' } }) })),
      [['average', '평단가', 180.25, '-12.35%']]);
    // No current valuation: the price only, never an old or invented rate.
    for (const valuation of [{ state: 'stale_cache', returnRate: '9' }, { state: 'unavailable' }])
      assert.deepEqual(summary(build({ position: position({ valuation }) })), [['average', '평단가', 180.25, null]]);
    // Nothing held, another asset, another currency or a malformed row: no line.
    for (const other of [{ quantity: '0' }, { quantity: 'x' }, { assetId: 'msft' }, { currencyCode: 'KRW' }, { averageCost: '0' }])
      assert.deepEqual(build({ position: position(other) }), [], JSON.stringify(other));
  });

  it('open limit orders at their limit price, by side; finished, market or other-asset orders never', () => {
    const lines = build({ pendingOrders: [
      order('buy'), order('sell', { side: 'sell', limitPrice: '210' }), order('loc', { limitOnClose: { status: 'pending' }, limitPrice: '175' }),
      order('done', { status: 'executed' }), order('canceled', { status: 'canceled' }), order('market', { orderType: 'market' }),
      order('other', { assetId: 'msft' }), order('won', { currencyCode: 'KRW' }), order('no-price', { limitPrice: null }),
    ] });
    assert.deepEqual(summary(lines), [['limit', '지정가 매수', 170, null], ['limit', '지정가 매도', 210, null], ['limit', 'LOC 매수', 175, null]]);
  });

  it('only watched triggers: conditional BUY/SELL, 손절가/익절가 — a triggered or ended row draws nothing', () => {
    const lines = build({
      conditionalBuys: ['watching', 'triggered', 'order_pending', 'filled', 'canceled', 'failed'].map((state) => condition(`b-${state}`, state)),
      conditionalSells: [
        condition('s-watch', 'watching', { kind: 'condition', triggerPrice: '200' }),
        condition('sl', 'watching', { kind: 'stop_loss', triggerPrice: '150' }),
        condition('tp', 'watching', { kind: 'take_profit', triggerPrice: '230' }),
        condition('tp-done', 'filled', { kind: 'take_profit', triggerPrice: '231' }),
        condition('sl-other', 'watching', { kind: 'stop_loss', assetId: 'msft' }),
      ],
    });
    // The watch price — never the limit price the condition would submit (159).
    assert.deepEqual(summary(lines), [
      // A SELL condition's trigger is its 매도 기준가; a BUY watch keeps 감시가.
      ['trigger', '조건 매수 감시가', 160, null], ['trigger', '조건 매도 기준가', 200, null],
      ['trigger', '손절가', 150, null], ['trigger', '익절가', 230, null],
    ]);
  });

  it('old OCO groups: armed legs of active groups, only while the server still watches them', () => {
    const legs: Array<[string, string, string]> = [['armed-sl', 'stop_loss', '150'], ['armed-tp', 'take_profit', '240'], ['wait', 'stop_loss', '140']];
    assert.deepEqual(summary(build({ protections: oco('active', legs) })), [['trigger', '손절가', 150, null], ['trigger', '익절가', 240, null]]);
    // Older servers: monitoring follows canCreateSpot.
    assert.equal(build({ protections: oco('active', legs, { canMonitorSpot: undefined, canCreateSpot: true }) }).length, 2);
    for (const protections of [oco('holding', legs), oco('completed', legs), oco('active', legs, { canMonitorSpot: false }),
      oco('active', legs, { enabled: false })]) assert.deepEqual(build({ protections }), []);
  });

  it('identical orders share one counted line; different kinds at one price stay apart', () => {
    const lines = build({ position: position({ averageCost: '170' }), pendingOrders: [order('a'), order('b'), order('c', { side: 'sell' })],
      conditionalSells: [condition('sl', 'watching', { kind: 'stop_loss', triggerPrice: '170' })] });
    assert.deepEqual(summary(lines), [['average', '평단가', 170, '+5.2%'], ['limit', '지정가 매수', 170, '2건'], ['limit', '지정가 매도', 170, null], ['trigger', '손절가', 170, null]]);
  });

  it('draws nothing before the chart knows its currency', () => {
    assert.deepEqual(build({ currencyCode: null, position: position(), pendingOrders: [order('a')] }), []);
  });
});
