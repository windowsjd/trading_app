import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { normalizeOrderBook } from './orderBook.ts';
import { createOrderBookFixture, createLongOrderBookFixture } from './orderBook.fixture.ts';
import { TEST_IDS } from '../../constants/testIds.ts';

const require = createRequire(import.meta.url);
const { createTradingUiHarness, textContent, elements } = require('../../../test/tradingUiHarness.cjs');

describe('provider-independent domestic order book normalization', () => {
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
      { price: '100', quantity: '-1' }, { price: '101', quantity: '1.5' },
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
    assert.equal(normalized.currency, 'KRW');
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
    }, true));
  }

  for (const assetType of ['us_stock', 'crypto']) {
    it(`leaves ${assetType} untouched even when preview is enabled`, () => withPreview(true, 'true', () => {
      const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
      h.asset.assetType = assetType;
      assert.equal(elements(h.render(), 'AssetOrderBookCard').length, 0);
    }));
  }

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
});
