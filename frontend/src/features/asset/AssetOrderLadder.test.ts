import { financial, getFinancialColors, resolveFinancialColor } from '../../theme/financialColors.ts';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { createCryptoOrderBookFixture } from './orderBook.fixture.ts';
import { formatOrderBookDecimal } from './orderBook.ts';
const require = createRequire(import.meta.url);
const { interactionHarness, flatten, React, act } = require('../../../test/interactionTestHarness.cjs');

describe('compact trading depth presentation', () => {
  for (const fontScale of [1, 1.5, 2]) {
    it(`keeps exact 10+10 levels around the canonical price at font scale ${fontScale}`, (t) => {
      const h = interactionHarness(); h.dimensions.fontScale = fontScale;
      const Ladder = h.load('src/features/asset/AssetOrderLadder.tsx').default;
      const book = createCryptoOrderBookFixture('btc', 'BTC', true);
      const renderer = h.render(React.createElement(Ladder, { book, statusMessage: '호가 정보가 지연되고 있습니다.', currentPrice: React.createElement('Text', { testID: 'canonical-price' }, '$777.1234') }));
      t.after(() => act(() => renderer.unmount()));
      const rows = renderer.root.findAll((node: any) => typeof node.type === 'string' && /^asset-order-book-(?:asks|bids)-\d+$/.test(node.props.testID ?? ''));
      assert.equal(rows.length, 20);
      assert.equal(rows[0].props.testID, 'asset-order-book-asks-10');
      assert.equal(rows[9].props.testID, 'asset-order-book-asks-1');
      assert.equal(rows[10].props.testID, 'asset-order-book-bids-1');
      assert.equal(rows[19].props.testID, 'asset-order-book-bids-10');
      const ids = renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID).map((node: any) => node.props.testID);
      assert.ok(ids.indexOf('asset-order-book-asks-1') < ids.indexOf('canonical-price'));
      assert.ok(ids.indexOf('canonical-price') < ids.indexOf('asset-order-book-bids-1'));
      assert.equal(renderer.root.findAllByType('Pressable').length, 0);
      assert.ok(rows.some((row: any) => row.props.accessibilityLabel.includes('0.000000000000000001')));
      const scrolls = renderer.root.findAllByType('ScrollView');
      assert.equal(scrolls.length, 2);
      assert.ok(scrolls.every((scroll: any) => scroll.props.horizontal));
      assert.equal(renderer.root.findByProps({ testID: 'canonical-price' }).props.children, '$777.1234');
    });
  }
  it('shows status and current price without inventing depth during loading', (t) => {
    const h = interactionHarness(); const Ladder = h.load('src/features/asset/AssetOrderLadder.tsx').default;
    const renderer = h.render(React.createElement(Ladder, { book: null, statusMessage: '호가 정보를 불러오는 중입니다.', currentPrice: React.createElement('Text', null, '$763.79') }));
    t.after(() => act(() => renderer.unmount()));
    assert.equal(renderer.root.findAllByType('ScrollView').length, 0);
    assert.ok(JSON.stringify(renderer.toJSON()).includes('$763.79'));
  });
});


describe('order book side colors in the trading ladder', () => {
  it('draws asks red and bids blue under either preference, number and row alike, without changing the best levels', (t) => {
    const h = interactionHarness();
    const Ladder = h.load('src/features/asset/AssetOrderLadder.tsx').default;
    const book = createCryptoOrderBookFixture('btc', 'BTC', true);
    const renderer = h.render(React.createElement(Ladder, { book, statusMessage: null, currentPrice: React.createElement('Text', null, '$777') }));
    t.after(() => act(() => renderer.unmount()));
    const ask = renderer.root.findByProps({ testID: 'asset-order-book-asks-1' });
    const bid = renderer.root.findByProps({ testID: 'asset-order-book-bids-1' });
    // Book-side roles, never the order buttons' buy/sell roles.
    assert.equal(flatten(ask.props.style).backgroundColor, financial.askSurface);
    assert.equal(flatten(bid.props.style).backgroundColor, financial.bidSurface);
    assert.equal(flatten(ask.children[0].props.style).color, financial.askText);
    assert.equal(flatten(bid.children[0].props.style).color, financial.bidText);
    for (const mode of ['light', 'dark'] as const) {
      const redBlue = getFinancialColors(mode, 'red_blue');
      // Red/Blue: red asks over the current price, blue bids under it.
      assert.deepEqual([resolveFinancialColor(financial.askText, mode, 'red_blue'), resolveFinancialColor(financial.bidText, mode, 'red_blue')],
        [redBlue.rise, redBlue.fall]);
      assert.deepEqual([resolveFinancialColor(financial.askSurface, mode, 'red_blue'), resolveFinancialColor(financial.bidSurface, mode, 'red_blue')],
        [redBlue.riseSurface, redBlue.fallSurface]);
      // Green/Red uses the same book-side colors and surfaces.
      assert.deepEqual([resolveFinancialColor(financial.askText, mode, 'green_red'), resolveFinancialColor(financial.bidText, mode, 'green_red')],
        [redBlue.askText, redBlue.bidText]);
      assert.deepEqual([resolveFinancialColor(financial.askSurface, mode, 'green_red'), resolveFinancialColor(financial.bidSurface, mode, 'green_red')],
        [redBlue.askSurface, redBlue.bidSurface]);
    }
    assert.match(ask.props.accessibilityLabel, /매도 1호가/);
    assert.match(bid.props.accessibilityLabel, /매수 1호가/);
    assert.equal(ask.children[0].props.children, formatOrderBookDecimal(book.asks[0].price));
    assert.equal(bid.children[0].props.children, formatOrderBookDecimal(book.bids[0].price));
  });

  it('colors a level by its book side, never by where its price falls against the current price', (t) => {
    const h = interactionHarness();
    const Ladder = h.load('src/features/asset/AssetOrderLadder.tsx').default;
    // A crossed (abnormal) snapshot: the best ask is below the best bid.
    const book = { assetId: 'btc', priceUnit: 'USDT', quantityUnit: 'BTC', capturedAt: '2026-10-18T00:00:00.000Z',
      asks: [{ price: '99', quantity: '1' }], bids: [{ price: '101', quantity: '2' }] };
    const renderer = h.render(React.createElement(Ladder, { book, statusMessage: null,
      currentPrice: React.createElement('Text', { testID: 'canonical-price' }, '$100') }));
    t.after(() => act(() => renderer.unmount()));
    const ids = renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID).map((node: any) => node.props.testID);
    assert.ok(ids.indexOf('asset-order-book-asks-1') < ids.indexOf('canonical-price'));
    assert.ok(ids.indexOf('canonical-price') < ids.indexOf('asset-order-book-bids-1'));
    const ask = renderer.root.findByProps({ testID: 'asset-order-book-asks-1' });
    const bid = renderer.root.findByProps({ testID: 'asset-order-book-bids-1' });
    assert.deepEqual([ask.children[0].props.children, bid.children[0].props.children], ['99', '101']);
    assert.deepEqual([flatten(ask.children[0].props.style).color, flatten(bid.children[0].props.style).color],
      [financial.askText, financial.bidText]);
  });
});
