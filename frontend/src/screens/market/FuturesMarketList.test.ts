import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const { futuresHarness } = createRequire(import.meta.url)('../../../test/futuresHarness.cjs');

type Node = { children?: unknown[]; props: Record<string, any> };
const textOf = (node: Node | undefined): string =>
  !node ? '' : (node.children ?? []).map((child) => typeof child === 'string' ? child : textOf(child as Node)).join('');
const stats = (change: string, volume: string) => ({
  state: 'available', priceChangePercent: change, quoteVolume: volume,
  windowOpenTime: '2026-10-13T03:00:00.000Z', windowCloseTime: '2026-10-14T03:00:00.000Z', receivedAt: new Date().toISOString(),
});
const unavailable = { state: 'unavailable', priceChangePercent: null, quoteVolume: null, windowOpenTime: null, windowCloseTime: null, receivedAt: null };
function contracts(base: any, values: Record<string, { change: string; volume: string } | null>) {
  return Object.entries(values).map(([id, value]) => ({
    ...base, id,
    underlying: { ...base.underlying, assetId: `asset-${id}`, symbol: `${id.toUpperCase()}USDT`, name: id.toUpperCase() },
    marketStats: value ? stats(value.change, value.volume) : unavailable,
  }));
}
const rowIds = (h: any) => h.renderer.root
  .findAll((node: Node) => typeof (node as any).type === 'string' && /^futures-market-(?!list$)/.test(node.props.testID ?? ''))
  .map((node: Node) => node.props.testID.replace('futures-market-', ''));

test('the futures list uses the Spot sort control and ranks by 24h statistics', async t => {
  const h = futuresHarness({ screen: 'market' });
  let values: Record<string, { change: string; volume: string } | null> = {
    btc: { change: '1.25', volume: '12000000000' }, eth: { change: '-3.5', volume: '900000000' },
    sol: null, xrp: { change: '4.1', volume: '50000000' },
  };
  h.catalogInstruments = (base: any) => contracts(base, values);
  await h.start(); t.after(h.close);
  assert.equal(h.node('market-sort-control') !== undefined, true);
  assert.deepEqual(rowIds(h), ['btc', 'eth', 'xrp', 'sol']);
  // The list no longer repeats the price/statistics basis under the toolbar;
  // the summary line and the rows are unchanged.
  const listText = textOf(h.node('futures-list-controls')) + textOf(h.node('futures-market-list'));
  assert.equal(listText.includes('현재가는 선물 Last 거래 기준'), false);
  assert.equal(listText.includes('24시간 통계'), false);
  assert.equal(textOf(h.node('futures-list-summary')), 'USDⓈ-M 무기한 · 24시간 기준');
  // The contract's own 24h change, signed; unavailable shows '-'.
  assert.equal(textOf(h.node('futures-change-btc')), '+1.25%');
  assert.equal(textOf(h.node('futures-change-eth')), '-3.5%');
  assert.equal(textOf(h.node('futures-change-sol')), '-');

  await h.press('market-sort-changeRate');
  assert.equal(h.sort, 'change_desc');
  await h.update();
  assert.deepEqual(rowIds(h), ['xrp', 'btc', 'eth', 'sol']);

  // A poll with new values keeps the ranking (values update in place)…
  values = { ...values, eth: { change: '9.9', volume: '1' } };
  await h.client.refetchQueries();
  await h.flush();
  assert.deepEqual(rowIds(h), ['xrp', 'btc', 'eth', 'sol']);
  assert.equal(textOf(h.node('futures-change-eth')), '+9.9%');
  // …and an explicit refresh re-ranks it.
  h.refreshVersion = 1;
  await h.update();
  await h.flush();
  assert.deepEqual(rowIds(h), ['eth', 'xrp', 'btc', 'sol']);

  await h.input('선물 상품 검색', 'b');
  assert.deepEqual(rowIds(h), ['btc']);
});

test('the trading restriction notice stays while the removed price-basis line is gone', async t => {
  const h = futuresHarness({ screen: 'market', mode: 'REDUCE_ONLY' });
  await h.start(); t.after(h.close);
  // The notice sits with the controls in the header card, above the rows.
  assert.equal(textOf(h.node('futures-list-controls')).includes('현재 신규 선물 거래가 제한되어 있습니다.'), true);
  const listText = textOf(h.node('futures-market-list'));
  assert.equal(listText.includes('현재 신규 선물 거래가 제한되어 있습니다.'), false);
  assert.equal(listText.includes('현재가는 선물 Last 거래 기준'), false);
  assert.deepEqual(rowIds(h), ['btc']);
});
