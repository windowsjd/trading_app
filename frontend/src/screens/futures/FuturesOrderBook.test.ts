import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const { futuresHarness } = createRequire(import.meta.url)('../../../test/futuresHarness.cjs');

type Node = { children?: unknown[] };
function textOf(node: Node | undefined): string {
  if (!node) return '';
  return (node.children ?? []).map((child) => typeof child === 'string' ? child : textOf(child as Node)).join('');
}
const book = (assetId: string) => ({
  assetId, priceUnit: 'USDT', quantityUnit: 'BTC', marketLabel: 'BTC / USDT 무기한',
  asks: [{ price: '102.5', quantity: '1.25' }], bids: [{ price: '101.5', quantity: '0.5' }],
  capturedAt: new Date().toISOString(), effectiveAt: null,
});

test('the contract ladder follows the selected instrument with Futures Last in the middle', async t => {
  const h = futuresHarness({ futuresOnly: true });
  await h.start(); t.after(h.close);
  const request = h.orderBookRequests.at(-1);
  assert.equal(request.instrumentId, 'btc');
  assert.equal(request.enabled, true);
  // The middle row is the Futures Last reference (102), never Mark (101).
  assert.match(textOf(h.node('futures-order-book-last')), /현재가 · 선물 Last/);
  assert.match(textOf(h.node('futures-order-book-last')), /102/);
  assert.doesNotMatch(textOf(h.node('futures-order-book-last')), /101/);
  assert.equal(textOf(h.node('asset-order-book-status')), '호가 정보를 불러오는 중입니다.');

  h.orderBookState = { latestOrderBook: book('btc'), statusMessage: null };
  await h.update();
  assert.equal(h.node('asset-order-book-asks-1') !== undefined, true);
  assert.equal(h.node('asset-order-book-status') === undefined, true);

  // A book of another contract is never drawn on this one.
  h.orderBookState = { latestOrderBook: book('hype'), statusMessage: null };
  await h.update();
  assert.equal(h.node('asset-order-book-asks-1') === undefined, true);

  await h.selectInstrument('hype');
  assert.equal(h.orderBookRequests.at(-1).instrumentId, 'hype');
});

test('collapsing the ladder releases its subscription', async t => {
  const h = futuresHarness();
  await h.start(); t.after(h.close);
  assert.equal(h.node('futures-order-book-toggle').props.accessibilityState.expanded, true);
  await h.press('futures-order-book-toggle');
  assert.equal(h.orderBookRequests.at(-1).enabled, false);
  assert.equal(h.node('asset-order-book') === undefined, true);
  assert.equal(h.node('futures-order-book-toggle').props.accessibilityState.expanded, false);
  await h.press('futures-order-book-toggle');
  assert.equal(h.orderBookRequests.at(-1).enabled, true);
  assert.equal(h.node('asset-order-book') !== undefined, true);
});
