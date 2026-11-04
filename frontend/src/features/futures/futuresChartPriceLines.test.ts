import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFuturesChartPriceLines } from './futuresChartPriceLines.ts';

const now = Date.parse('2026-11-04T07:00:10.000Z');
const at = (msAgo: number) => new Date(now - msAgo).toISOString();
const position = (overrides: Record<string, unknown> = {}) => ({
  id: 'pos-btc', instrumentId: 'btc', direction: 'long', marginMode: 'isolated', leverage: 10, quantity: '0.5',
  averageEntryPrice: '67000.5', roi: '12.5', markUnrealizedPnl: '418.75', markNotional: '33918', markState: 'fresh',
  markEvidence: { snapshotId: 's', source: 'binance', effectiveAt: at(1500), capturedAt: at(1000) },
  instrument: { underlying: { assetId: 'btc-asset', name: 'Bitcoin', symbol: 'BTC', assetType: 'crypto' } },
  ...overrides,
}) as any;
const build = (input: Record<string, unknown>) => buildFuturesChartPriceLines({
  instrumentId: 'btc', positions: [], evaluatedAt: at(1000), now, limitOrders: [], conditionalEntries: [], tpSl: [], protections: null,
  ...input,
} as any);
const summary = (lines: ReturnType<typeof build>) => lines.map((line) => [line.kind, line.title, line.price, line.note ?? null]);

describe('futures chart lines', () => {
  it('the position: its average entry price with the card\'s own leverage ROI, only while the Mark is fresh', () => {
    assert.deepEqual(summary(build({ positions: [position()] })), [['average', '롱 진입가', 67000.5, '+12.5%']]);
    assert.deepEqual(summary(build({ positions: [position({ direction: 'short', roi: '-38.25' })] })), [['average', '숏 진입가', 67000.5, '-38.25%']]);
    // A read older than 5 s, a Mark that is not fresh or stale evidence: the price only.
    for (const input of [{ evaluatedAt: at(6000) }, { positions: [position({ markState: 'stale' })] },
      { positions: [position({ markEvidence: { snapshotId: 's', source: 'binance', effectiveAt: at(7000), capturedAt: at(6500) } })] }]) {
      assert.deepEqual(summary(build({ positions: [position()], ...input })), [['average', '롱 진입가', 67000.5, null]], JSON.stringify(input));
    }
    // Another contract or a closed position: nothing.
    assert.deepEqual(build({ positions: [position({ instrumentId: 'eth' }), position({ quantity: '0' })] }), []);
  });

  it('submitted limit entries and watched conditional entries of this contract only', () => {
    const lines = build({
      limitOrders: [
        { id: 'l1', instrumentId: 'btc', direction: 'long', status: 'submitted', limitPrice: '65000' },
        { id: 'l2', instrumentId: 'btc', direction: 'short', status: 'submitted', limitPrice: '70000' },
        { id: 'l3', instrumentId: 'btc', direction: 'long', status: 'executed', limitPrice: '64000' },
        { id: 'l4', instrumentId: 'eth', direction: 'long', status: 'submitted', limitPrice: '3000' },
      ],
      conditionalEntries: ['watching', 'triggered', 'order_pending', 'filled', 'canceled'].map((state, index) => ({
        id: `c-${state}`, instrumentId: 'btc', direction: index % 2 ? 'short' : 'long', state, triggerPrice: `6${index}000`, limitPrice: '1',
      })),
    });
    assert.deepEqual(summary(lines), [['limit', '지정가 롱', 65000, null], ['limit', '지정가 숏', 70000, null], ['trigger', '조건 롱 감시가', 60000, null]]);
  });

  it('손절가/익절가 still watched on this position, and armed legs of an old OCO group on it while watched', () => {
    const protections = (overrides: Record<string, unknown> = {}) => ({
      capabilities: { enabled: true, canCreateSpot: false, canCreateFutures: false, canMonitorFutures: true, canCancel: true, canUseSpotLimit: false, ...overrides },
      groups: [
        { id: 'g', domain: 'futures', positionId: 'pos-btc', status: 'active', legs: [
          { id: 'sl', kind: 'stop_loss', triggerPrice: '61000', state: 'armed' }, { id: 'tp', kind: 'take_profit', triggerPrice: '75000', state: 'triggered' }] },
        { id: 'old', domain: 'futures', positionId: 'closed-position', status: 'active', legs: [{ id: 'x', kind: 'stop_loss', triggerPrice: '1', state: 'armed' }] },
      ],
    });
    const lines = build({
      positions: [position()],
      tpSl: [
        { id: 't1', instrumentId: 'btc', positionId: 'pos-btc', kind: 'stop_loss', state: 'watching', triggerPrice: '62000' },
        { id: 't2', instrumentId: 'btc', positionId: 'pos-btc', kind: 'take_profit', state: 'watching', triggerPrice: '80000' },
        { id: 't3', instrumentId: 'btc', positionId: 'pos-btc', kind: 'take_profit', state: 'filled', triggerPrice: '81000' },
        { id: 't4', instrumentId: 'btc', positionId: 'other', kind: 'stop_loss', state: 'watching', triggerPrice: '1' },
      ],
      protections: protections(),
    });
    assert.deepEqual(summary(lines), [['average', '롱 진입가', 67000.5, '+12.5%'], ['trigger', '손절가', 62000, null],
      ['trigger', '익절가', 80000, null], ['trigger', '손절가', 61000, null]]);
    assert.equal(build({ positions: [position()], protections: protections({ canMonitorFutures: false }) }).length, 1);
    // Without the position, its 손절가/익절가 are not drawn.
    assert.deepEqual(build({ tpSl: [{ id: 't1', instrumentId: 'btc', positionId: 'pos-btc', kind: 'stop_loss', state: 'watching', triggerPrice: '62000' }] }), []);
  });
});
