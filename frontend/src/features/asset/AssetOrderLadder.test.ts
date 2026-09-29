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


describe('order side colors in the trading ladder', () => {
  it('uses red asks and green bids without changing the best levels', (t) => {
    const h = interactionHarness();
    const Ladder = h.load('src/features/asset/AssetOrderLadder.tsx').default;
    const book = createCryptoOrderBookFixture('btc', 'BTC', true);
    const renderer = h.render(React.createElement(Ladder, { book, statusMessage: null, currentPrice: React.createElement('Text', null, '$777') }));
    t.after(() => act(() => renderer.unmount()));
    const ask = renderer.root.findByProps({ testID: 'asset-order-book-asks-1' });
    const bid = renderer.root.findByProps({ testID: 'asset-order-book-bids-1' });
    assert.equal(flatten(ask.props.style).backgroundColor, '#fef2f2');
    assert.equal(flatten(bid.props.style).backgroundColor, '#f0fdf4');
    assert.equal(flatten(ask.children[0].props.style).color, '#dc2626');
    assert.equal(flatten(bid.children[0].props.style).color, '#16a34a');
    assert.match(ask.props.accessibilityLabel, /매도 1호가/);
    assert.match(bid.props.accessibilityLabel, /매수 1호가/);
    assert.equal(ask.children[0].props.children, formatOrderBookDecimal(book.asks[0].price));
    assert.equal(bid.children[0].props.children, formatOrderBookDecimal(book.bids[0].price));
  });
});
