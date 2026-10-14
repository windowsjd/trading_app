import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseFuturesOrderBook } from './futuresOrderBook.ts';

const message = (overrides: Record<string, unknown> = {}) => ({
  type: 'futures_order_book',
  instrumentId: 'inst-btc',
  symbol: 'BTCUSDT',
  priceUnit: 'USDT',
  quantityUnit: 'BTC',
  marketLabel: 'BTC / USDT 무기한',
  asks: [{ price: '62001.5', quantity: '0.250' }, { price: '62000.5', quantity: '1.000' }],
  bids: [{ price: '61999.9', quantity: '2' }, { price: '62000.1', quantity: '0' }],
  capturedAt: '2026-10-14T03:00:00.000Z',
  effectiveAt: '2026-10-14T02:59:59.998Z',
  ...overrides,
});

describe('USDⓈ-M ladder messages', () => {
  it('keeps the contract identity and orders both sides best first', () => {
    const book = parseFuturesOrderBook(message(), 'inst-btc');
    assert.equal(book === null, false);
    assert.equal(book?.assetId, 'inst-btc');
    assert.equal(book?.quantityUnit, 'BTC');
    assert.deepEqual(book?.asks.map(level => level.price), ['62000.5', '62001.5']);
    assert.deepEqual(book?.bids.map(level => level.price), ['62000.1', '61999.9']);
    assert.equal(book?.bids[0].quantity, '0');
  });

  for (const [name, value] of [
    ['a Spot book of the same underlying', { ...message(), type: 'asset_order_book', assetId: 'inst-btc' }],
    ['another contract', message({ instrumentId: 'inst-eth' })],
    ['a non-USDT symbol', message({ symbol: 'BTC' })],
    ['eleven levels', message({ asks: Array.from({ length: 11 }, (_, i) => ({ price: `${i + 1}`, quantity: '1' })) })],
    ['a zero price', message({ bids: [{ price: '0', quantity: '1' }] })],
    ['a duplicate price', message({ asks: [{ price: '1.0', quantity: '1' }, { price: '1', quantity: '2' }] })],
    ['a bad time', message({ capturedAt: 'later' })],
  ] as const) {
    it(`refuses ${name}`, () => {
      assert.equal(parseFuturesOrderBook(value, 'inst-btc') === null, true);
    });
  }
});
