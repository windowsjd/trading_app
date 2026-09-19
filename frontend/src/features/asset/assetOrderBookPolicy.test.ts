import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAssetOrderBook, isOrderBookStale, supportsLiveOrderBook } from './assetOrderBookPolicy.ts';
import { createCryptoOrderBookFixture } from './orderBook.fixture.ts';

describe('live order book contract', () => {
  for (const base of ['BTC', 'ETH', 'XRP']) {
    it(`accepts ${base} 10+10 neutral snapshots without rounding or provider fields`, () => {
      const book = createCryptoOrderBookFixture(base, base, true);
      if (base === 'XRP') {
        book.asks = book.asks.map((level, i) => ({ ...level, price: `0.0000000000000000${10 + i}` }));
        book.bids = book.bids.map((level, i) => ({ ...level, price: i === 9 ? '0.0000000000000000001' : `0.00000000000000000${9 - i}` }));
      }
      const parsed = parseAssetOrderBook({ type: 'asset_order_book', ...book, lastUpdateId: 123, raw: {} }, base)!;
      assert.equal(parsed.asks.length, 10); assert.equal(parsed.bids.length, 10);
      assert.equal(parsed.asks[3].quantity, '0.000000000000000001');
      assert.equal(parsed.asks[4].quantity, '12345678901234567890.123456789012345678');
      assert.equal(parsed.asks[1].quantity, '0.00125000');
      assert.equal('lastUpdateId' in parsed, false); assert.equal('raw' in parsed, false);
    });
  }

  it('accepts empty and partial snapshots with zero levels, without synthesizing data', () => {
    const book = { ...createCryptoOrderBookFixture('btc', 'BTC'), asks: [], bids: [{ price: '0.00000001', quantity: '0' }] };
    const parsed = parseAssetOrderBook({ type: 'asset_order_book', ...book }, 'btc')!;
    assert.deepEqual(parsed.asks, []); assert.deepEqual(parsed.bids, book.bids);
    assert.equal(parsed.totalAskQuantity, null);
  });

  it('rejects malformed snapshots in their entirety and isolates assets', () => {
    const valid = { type: 'asset_order_book', ...createCryptoOrderBookFixture('btc', 'BTC') };
    for (const override of [{ asks: null }, { asks: [{}] }, { bids: [['1', '1']] }, { asks: [{ price: '0', quantity: '1' }] },
      { asks: [{ price: '1', quantity: '-1' }] }, { asks: [{ price: '1e3', quantity: '1' }] }, { asks: [{ price: '1', quantity: 1 }] },
      { asks: [...valid.asks, valid.asks[0]] }, { capturedAt: 'invalid' }, { effectiveAt: 123 }, { priceUnit: '' }, { assetId: 'eth' }]) {
      assert.equal(parseAssetOrderBook({ ...valid, ...override }, 'btc'), null);
    }
    assert.equal(parseAssetOrderBook(null, 'btc'), null);
  });

  it('turns stale strictly after five seconds in the client clock domain', () => {
    const book = { ...createCryptoOrderBookFixture('btc', 'BTC'), capturedAt: new Date(10000).toISOString() };
    assert.equal(isOrderBookStale(book, 10000, 15000), false);
    assert.equal(isOrderBookStale(book, 10000, 15001), true);
    assert.equal(isOrderBookStale(null, null, 20000), false);
    assert.equal(isOrderBookStale(book, null, 20000), false);
  });

  it('ignores server/client clock skew in either direction for freshness', () => {
    for (const serverTime of [1000, 300000]) {
      const book = { ...createCryptoOrderBookFixture('btc', 'BTC'), capturedAt: new Date(serverTime).toISOString() };
      assert.equal(isOrderBookStale(book, 20000, 20000), false, 'a just-received valid snapshot is fresh');
      assert.equal(isOrderBookStale(book, 10000, 20000), true, 'future server time cannot keep a silent stream fresh');
    }
  });

  it('uses asset metadata only to enable crypto; backend remains the supported-universe authority', () => {
    const asset = { assetType: 'crypto' as const, market: 'BINANCE', symbol: 'BTCUSDT', priceCurrency: 'USD' as const, isActive: true };
    assert.equal(supportsLiveOrderBook(asset), true);
    for (const override of [{ market: 'OTHER' }, { isActive: false }, { priceCurrency: 'KRW' as const }, { assetType: 'domestic_stock' as const }]) {
      assert.equal(supportsLiveOrderBook({ ...asset, ...override }), false);
    }
  });
});
