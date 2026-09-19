import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { createCryptoOrderBookFixture } from './orderBook.fixture.ts';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');

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
