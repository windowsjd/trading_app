import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { formatOrderBookDecimal, normalizeOrderBook } from './orderBook.ts';
import { createOrderBookFixture, createLongOrderBookFixture, createCryptoOrderBookFixture } from './orderBook.fixture.ts';
import { TEST_IDS } from '../../constants/testIds.ts';

const require = createRequire(import.meta.url);
const { createTradingUiHarness, textContent, elements } = require('../../../test/tradingUiHarness.cjs');

describe('provider-independent order book normalization', () => {
  it('sorts both sides best first, caps at ten, and preserves the input', () => {
    const book = createOrderBookFixture('kr-1');
    book.asks = Array.from({ length: 12 }, (_, i) => ({ price: String(112 - i), quantity: String(i) }));
    book.bids = Array.from({ length: 12 }, (_, i) => ({ price: String(80 + i), quantity: String(i) }));
    const before = structuredClone(book);
    const normalized = normalizeOrderBook(book);
    assert.deepEqual(normalized.asks.map((level) => level.price), ['101', '102', '103', '104', '105', '106', '107', '108', '109', '110']);
    assert.deepEqual(normalized.bids.map((level) => level.price), ['91', '90', '89', '88', '87', '86', '85', '84', '83', '82']);
    assert.deepEqual(book, before);
  });

  it('retains exact prices beyond Number precision and keeps quantities paired', () => {
    const book = createOrderBookFixture('kr-1');
    book.asks = [
      { price: '9007199254740993', quantity: '2' },
      { price: '9007199254740992', quantity: '999999999999999999999999' },
    ];
    const normalized = normalizeOrderBook(book);
    assert.deepEqual(normalized.asks, [book.asks[1], book.asks[0]]);
  });

  it('drops invalid and absent price levels without inventing data; zero shares remain', () => {
    const book = createOrderBookFixture('kr-1');
    book.asks = [
      { price: '0', quantity: '0' }, { price: '-1', quantity: '20' },
      { price: 'NaN', quantity: '20' }, { price: '', quantity: '20' },
      { price: '100', quantity: '-1' }, { price: '101', quantity: '1..5' },
      { price: '102', quantity: 'Infinity' }, { price: '103', quantity: '' },
      { price: '104', quantity: '0' }, { price: '105', quantity: '2.000' },
    ];
    book.bids = [];
    book.totalAskQuantity = '-1';
    book.totalBidQuantity = undefined;
    const normalized = normalizeOrderBook(book);
    assert.deepEqual(normalized.asks, [{ price: '104', quantity: '0' }, { price: '105', quantity: '2.000' }]);
    assert.deepEqual(normalized.bids, []);
    assert.equal(normalized.totalAskQuantity, null);
    assert.equal(normalized.totalBidQuantity, null);
  });

  it('does not replace exchange totals or timestamps with visible-depth sums or the clock', () => {
    const book = createOrderBookFixture('kr-1');
    const normalized = normalizeOrderBook(book);
    assert.equal(normalized.totalAskQuantity, book.totalAskQuantity);
    assert.equal(normalized.totalBidQuantity, book.totalBidQuantity);
    assert.equal(normalized.effectiveAt, book.effectiveAt);
    assert.equal(normalized.capturedAt, book.capturedAt);
    assert.equal(normalized.assetId, 'kr-1');
    assert.equal(normalized.priceUnit, '원');
    assert.equal(normalized.quantityUnit, '주');
  });

  for (const fixture of [createOrderBookFixture, createLongOrderBookFixture]) {
    it(`${fixture.name} supplies ten distinct prices and quantities per side`, () => {
      const book = fixture('kr-1');
      for (const side of [book.asks, book.bids]) {
        assert.equal(side.length, 10);
        assert.equal(new Set(side.map((level) => level.price)).size, 10);
        assert.equal(new Set(side.map((level) => level.quantity)).size, 10);
      }
      assert.deepEqual(normalizeOrderBook(book), book);
    });
  }

  it('preserves fractional quantities and totals exactly, including tiny and large values', () => {
    const book = createCryptoOrderBookFixture('btc', 'BTC', true);
    book.totalAskQuantity = '12345678901234567890.000000000000000001';
    book.totalBidQuantity = '0.00125000';
    const before = structuredClone(book);
    const normalized = normalizeOrderBook(book);
    assert.deepEqual(normalized, before);
    assert.deepEqual(book, before);
    assert.equal(normalized.asks.length, 10);
    assert.equal(normalized.bids.length, 10);
    assert.equal(normalized.asks[1].quantity, '0.00125000');
    assert.equal(normalized.asks[3].quantity, '0.000000000000000001');
    assert.equal(normalized.asks[5].quantity, '0');
  });

  it('sorts very small decimal prices, caps depth, and keeps their quantities paired', () => {
    const book = createCryptoOrderBookFixture('btc', 'BTC');
    book.asks = Array.from({ length: 12 }, (_, i) => ({
      price: `0.0000000000000000${99 - i}`, quantity: `0.${i + 1}`,
    }));
    book.bids = [...book.asks].reverse();
    const normalized = normalizeOrderBook(book);
    assert.deepEqual(normalized.asks, [...book.asks].reverse().slice(0, 10));
    assert.deepEqual(normalized.bids, book.asks.slice(0, 10));
  });

  for (const invalid of ['', ' ', '-0.001', '1e-8', 'NaN', 'Infinity', '1,250', '.1', '1.', '1.2.3', 1 as unknown as string]) {
    it(`rejects non-contract decimals: ${JSON.stringify(invalid)}`, () => {
      const book = createCryptoOrderBookFixture('btc', 'BTC');
      book.asks = [{ price: invalid, quantity: '1' }];
      book.bids = [{ price: '1', quantity: invalid }];
      book.totalAskQuantity = invalid;
      const normalized = normalizeOrderBook(book);
      assert.deepEqual(normalized.asks, []);
      assert.deepEqual(normalized.bids, []);
      assert.equal(normalized.totalAskQuantity, null);
      assert.equal(formatOrderBookDecimal(invalid), '-');
    });
  }

  for (const long of [false, true]) {
    it(`crypto fixture (long=${long}) has 20 distinct prices and quantities without inventing totals`, () => {
      const book = createCryptoOrderBookFixture('eth', 'ETH', long);
      for (const side of [book.asks, book.bids]) {
        assert.equal(side.length, 10);
        assert.equal(new Set(side.map((level) => level.price)).size, 10);
        assert.equal(new Set(side.map((level) => level.quantity)).size, 10);
      }
      const normalized = normalizeOrderBook(book);
      assert.deepEqual(normalized.asks, book.asks);
      assert.deepEqual(normalized.bids, book.bids);
      assert.equal(normalized.totalAskQuantity, null);
      assert.equal(normalized.totalBidQuantity, null);
    });
  }
});

describe('exact order book decimal display', () => {
  for (const [input, expected] of [
    ['0.00125000', '0.00125'], ['12.345678', '12.345678'],
    ['68420.10', '68,420.1'], ['0.000000000000000001', '0.000000000000000001'],
    ['12345678901234567890.123456789012345678', '12,345,678,901,234,567,890.123456789012345678'],
    ['0001234.000', '1,234'], ['0.00000', '0'], ['70100', '70,100'],
  ]) {
    it(`formats ${input} without rounding or Number conversion`, () => {
      assert.equal(formatOrderBookDecimal(input), expected);
    });
  }
});

function withPreview(dev: boolean | undefined, flag: string | undefined, run: () => void, long = false) {
  const target = globalThis as typeof globalThis & { __DEV__?: boolean };
  const previousDev = target.__DEV__;
  const previousFlag = process.env.EXPO_PUBLIC_ORDER_BOOK_PREVIEW;
  const previousLong = process.env.EXPO_PUBLIC_ORDER_BOOK_PREVIEW_LONG;
  target.__DEV__ = dev;
  if (flag === undefined) delete process.env.EXPO_PUBLIC_ORDER_BOOK_PREVIEW;
  else process.env.EXPO_PUBLIC_ORDER_BOOK_PREVIEW = flag;
  process.env.EXPO_PUBLIC_ORDER_BOOK_PREVIEW_LONG = String(long);
  try { run(); } finally {
    if (previousDev === undefined) delete target.__DEV__; else target.__DEV__ = previousDev;
    if (previousFlag === undefined) delete process.env.EXPO_PUBLIC_ORDER_BOOK_PREVIEW;
    else process.env.EXPO_PUBLIC_ORDER_BOOK_PREVIEW = previousFlag;
    if (previousLong === undefined) delete process.env.EXPO_PUBLIC_ORDER_BOOK_PREVIEW_LONG;
    else process.env.EXPO_PUBLIC_ORDER_BOOK_PREVIEW_LONG = previousLong;
  }
}

describe('asset detail preview isolation and regression', () => {
  for (const [dev, flag] of [[false, 'true'], [undefined, 'true'], [true, undefined], [true, 'false'], [true, 'typo']] as const) {
    it(`does not expose fixtures when dev=${dev}, flag=${flag}`, () => withPreview(dev, flag, () => {
      const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
      assert.equal(elements(h.render(), 'AssetOrderBookCard').length, 0);
      Object.assign(h.asset, { assetType: 'crypto', market: 'BINANCE', symbol: 'BTCUSDT', priceCurrency: 'USD' });
      assert.equal(elements(h.render(), 'AssetOrderBookCard').length, 0);
    }, true));
  }

  it('leaves US stocks untouched even when preview is enabled', () => withPreview(true, 'true', () => {
    const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
    h.asset.assetType = 'us_stock';
    assert.equal(elements(h.render(), 'AssetOrderBookCard').length, 0);
  }));

  it('rejects a domestic asset with an unexpected currency', () => withPreview(true, 'true', () => {
    const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
    h.asset.priceCurrency = 'USD';
    assert.equal(elements(h.render(), 'AssetOrderBookCard').length, 0);
  }));

  it('renders the dev book while preserving price, chart, queries and account-bound buy/sell routes', () => withPreview(true, '1', () => {
    const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
    h.candles = [{ time: '2026-09-18T01:00:00Z', open: '70000', high: '71000', low: '69000', close: '70500', volume: '100' }];
    h.positionQuery.data.positions = [{ assetId: h.asset.id, quantity: '2', averageCost: '70000', currencyCode: 'KRW', valuation: { state: 'unavailable' } }];
    const tree = h.render();
    const card = elements(tree, 'AssetOrderBookCard')[0];
    assert.equal(card.props.isPreview, true);
    assert.deepEqual(card.props.book, createOrderBookFixture(h.asset.id));
    assert.match(textContent(tree), /70,000원/);
    assert.match(textContent(tree), /시장 상태: closed/);
    assert.deepEqual(elements(tree, 'CandlestickChart')[0].props.candles, h.candles);
    assert.equal(h.queries.length, 3, 'no new HTTP query or cache added');
    for (const side of ['buy', 'sell']) {
      const cta = h.control(tree, TEST_IDS.assetDetail[`${side}Button` as 'buyButton' | 'sellButton']);
      assert.equal(h.renderCta(cta).props.disabled, false);
      cta.props.onPress();
    }
    assert.deepEqual(h.navigation, ['buy', 'sell'].map((side) => ['Order', { assetId: h.asset.id, side, accountId: h.account.id }]));
    assert.deepEqual(h.requests, [], 'fixture and its rows never submit orders');
    h.asset.id = 'kr-2';
    assert.equal(elements(h.render(), 'AssetOrderBookCard')[0].props.book.assetId, 'kr-2');
  }));

  it('uses the long layout fixture only after opting in', () => withPreview(true, 'true', () => {
    const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
    assert.deepEqual(elements(h.render(), 'AssetOrderBookCard')[0].props.book, createLongOrderBookFixture(h.asset.id));
  }, true));

  for (const [symbol, base] of [['BTCUSDT', 'BTC'], ['ETHUSDT', 'ETH'], ['XRPUSDT', 'XRP'], ['1INCHUSDT', '1INCH'], [' ethusdt ', 'ETH']]) {
    it(`derives ${base} / USDT from the existing ${symbol} asset contract`, () => withPreview(true, 'true', () => {
      const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
      Object.assign(h.asset, { assetType: 'crypto', market: 'BINANCE', symbol, priceCurrency: 'USD', settlementCurrency: 'USD' });
      const tree = h.render();
      const book = elements(tree, 'AssetOrderBookCard')[0].props.book;
      assert.deepEqual(book, createCryptoOrderBookFixture(h.asset.id, base));
      assert.equal(book.asks.length, 10);
      assert.equal(book.bids.length, 10);
      assert.equal(h.asset.priceCurrency, 'USD');
      assert.equal(h.asset.settlementCurrency, 'USD');
      assert.equal(h.queries.length, 3);
      assert.deepEqual(h.requests, []);
    }));
  }

  for (const overrides of [
    { symbol: 'BTC' }, { symbol: 'BTCUSD' }, { symbol: 'ETHBTC' },
    { symbol: 'USDT' }, { symbol: '' }, { symbol: 'BTC/USDT' },
    { market: 'OTHER' }, { priceCurrency: 'KRW' }, { assetType: 'us_stock' },
  ]) {
    it(`does not guess a crypto pair for ${JSON.stringify(overrides)}`, () => withPreview(true, 'true', () => {
      const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
      Object.assign(h.asset, { assetType: 'crypto', market: 'BINANCE', symbol: 'BTCUSDT', priceCurrency: 'USD', ...overrides });
      assert.equal(elements(h.render(), 'AssetOrderBookCard').length, 0);
    }));
  }

  it('reuses the LONG flag for crypto and refreshes units across asset changes', () => withPreview(true, 'true', () => {
    const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
    assert.equal(elements(h.render(), 'AssetOrderBookCard')[0].props.book.quantityUnit, '주');
    Object.assign(h.asset, { id: 'btc', assetType: 'crypto', market: 'BINANCE', symbol: 'BTCUSDT', priceCurrency: 'USD' });
    assert.deepEqual(elements(h.render(), 'AssetOrderBookCard')[0].props.book, createCryptoOrderBookFixture('btc', 'BTC', true));
    Object.assign(h.asset, { id: 'eth', symbol: 'ETHUSDT' });
    assert.deepEqual(elements(h.render(), 'AssetOrderBookCard')[0].props.book, createCryptoOrderBookFixture('eth', 'ETH', true));
    Object.assign(h.asset, { id: 'kr-2', assetType: 'domestic_stock', market: 'KRX', symbol: '005930', priceCurrency: 'KRW' });
    assert.deepEqual(elements(h.render(), 'AssetOrderBookCard')[0].props.book, createLongOrderBookFixture('kr-2'));
  }, true));
});
