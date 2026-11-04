import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { futuresHarness } = require('../../../test/futuresHarness.cjs');
const guestState = require('../../features/auth/guestBrowsing.ts');

const chartLines = (h: any) => {
  const chart = h.renderer.root.findAll((node: any) => node.type === 'CandlestickChart')[0];
  assert.equal(chart !== undefined, true, 'the chart is drawn');
  return chart.props.priceLines.map((line: any) => [line.kind, line.title, line.price, line.note ?? null]);
};
const accountReads = (h: any) => h.reads.filter((path: string) => /\/futures\/(positions|limit-orders|conditional-entries|tp-sl-settings)/u.test(path));
const limitEntry = (id: string, limitPrice: string) => ({ id, tradingAccountId: 'A', instrumentId: 'btc', direction: 'long', marginMode: 'isolated', leverage: 10,
  quantity: '1', limitPrice, reservedAmount: '10', status: 'submitted', executionId: null, terminalReason: null, createdAt: new Date().toISOString(), endedAt: null });

for (const screen of ['chart', 'detail']) {
  test(`${screen}: the bound account's position, limit entry and watches are drawn, and follow fills and cancels`, async (t) => {
    const h = futuresHarness({ screen, position: true });
    h.pendingEntries = [limitEntry('l-1', '95')];
    h.conditionalEntries = { open: [{ id: 'c-1', tradingAccountId: 'A', instrumentId: 'btc', direction: 'short', state: 'watching', status: 'watching',
      triggerPrice: '110', limitPrice: '109', executionType: 'limit' }] };
    h.futuresTpSl = { open: [{ id: 'sl-1', tradingAccountId: 'A', instrumentId: 'btc', positionId: 'A:position', kind: 'stop_loss',
      state: 'watching', status: 'watching', triggerPrice: '90' }] };
    await h.start(); t.after(h.close);
    assert.deepEqual(chartLines(h), [
      ['average', '롱 진입가', 100, '-106.17%'], ['limit', '지정가 롱', 95, null],
      ['trigger', '조건 숏 감시가', 110, null], ['trigger', '손절가', 90, null],
    ]);
    // The limit entry fills into the position and the watch ends: the next reads drop them.
    h.pendingEntries = [];
    h.conditionalEntries = { open: [] };
    await h.client.refetchQueries();
    await h.flush();
    assert.deepEqual(chartLines(h), [['average', '롱 진입가', 100, '-106.17%'], ['trigger', '손절가', 90, null]]);
    // The position closes: no average price, and its 손절가 goes with it.
    h.options.position = false;
    h.futuresTpSl = { open: [] };
    await h.client.refetchQueries();
    await h.flush();
    assert.deepEqual(chartLines(h), []);
  });
}

test('chart: another selected account than the screen\'s draws nothing and reads none of its orders', async (t) => {
  const h = futuresHarness({ screen: 'chart', position: true });
  h.routeAccountId = 'B';
  await h.start(); t.after(h.close);
  assert.deepEqual(chartLines(h), []);
  assert.deepEqual(accountReads(h), []);
});

test('detail: a guest sees market data only — no account read, no line', async (t) => {
  guestState.setGuestBrowsing(true);
  t.after(() => guestState.setGuestBrowsing(false));
  const h = futuresHarness({ screen: 'detail', position: true });
  h.routeAccountId = null;
  await h.start(); t.after(h.close);
  assert.deepEqual(chartLines(h), []);
  assert.equal(h.reads.some((path: string) => path.startsWith('/trading-accounts/')), false);
});
