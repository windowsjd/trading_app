import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { createOrderBookFixture, createLongOrderBookFixture, createCryptoOrderBookFixture } from './orderBook.fixture.ts';
import { formatOrderBookDecimal } from './orderBook.ts';
import { formatKrwDecimal } from '../../utils/format.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const text = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(text).join('');
const host = (renderer: any, testID: string) => renderer.root.find((node: any) => node.type === 'View' && node.props.testID === testID);

describe('order book card rendering', () => {
  it('shows 10 asks descending then 10 bids descending, with exact paired quantities', () => {
    const h = interactionHarness();
    const Card = h.load('src/features/asset/AssetOrderBookCard.tsx').default;
    const book = createOrderBookFixture('kr-1');
    const renderer = h.render(React.createElement(Card, { book, isPreview: true }));
    const rows = renderer.root.findAll((node: any) => node.type === 'View' && /^asset-order-book-(asks|bids)-\d+$/u.test(node.props.testID ?? ''));
    assert.equal(rows.length, 20);
    assert.equal(rows[0].props.testID, 'asset-order-book-asks-10');
    assert.equal(rows[9].props.testID, 'asset-order-book-asks-1');
    assert.equal(rows[10].props.testID, 'asset-order-book-bids-1');
    assert.equal(rows[19].props.testID, 'asset-order-book-bids-10');
    for (const side of ['asks', 'bids'] as const) {
      book[side].forEach((level, i) => {
        const row = host(renderer, `asset-order-book-${side}-${i + 1}`);
        assert.equal(text(row.children[0]), formatKrwDecimal(level.price));
        assert.equal(text(row.children[1]), formatKrwDecimal(level.quantity));
        assert.equal(row.props.onPress, undefined);
        assert.match(row.props.accessibilityLabel, /호가, 가격/);
      });
    }
    assert.match(text(renderer.root), /개발용 예시 · 실제 시세가 아닙니다/);
    assert.match(text(renderer.root), /가격 \(원\) · 잔량 \(주\)/);
    assert.match(host(renderer, 'asset-order-book-asks-1').props.accessibilityLabel, /70,100 원, 잔량 1,234 주/);
    assert.match(text(renderer.root), /기준 2026-09-18 10:15/);
    assert.match(text(host(renderer, 'asset-order-book-asks-total')), /2,345,678,901/);
    act(() => renderer.unmount());
  });

  it('shows empty and partial sides, zero quantity, missing totals and capture time honestly', () => {
    const h = interactionHarness();
    const Card = h.load('src/features/asset/AssetOrderBookCard.tsx').default;
    const book = { ...createOrderBookFixture('kr-1'), asks: [], bids: [{ price: '100', quantity: '0' }],
      effectiveAt: null, totalAskQuantity: null, totalBidQuantity: undefined };
    const renderer = h.render(React.createElement(Card, { book }));
    assert.match(text(renderer.root), /매도호가가 없습니다/);
    assert.match(text(renderer.root), /매수호가 · 1단계/);
    assert.equal(text(host(renderer, 'asset-order-book-bids-1').children[1]), '0');
    assert.doesNotMatch(text(renderer.root), /총 매도잔량|총 매수잔량|개발용 예시/);
    assert.match(text(renderer.root), /수집 2026-09-18 10:15/);
    act(() => renderer.unmount());
  });

  it('preserves all long digits and offers horizontal scrolling on a small screen with large fonts', () => {
    const h = interactionHarness();
    h.dimensions = { width: 280, height: 568, fontScale: 3 };
    const Card = h.load('src/features/asset/AssetOrderBookCard.tsx').default;
    const renderer = h.render(React.createElement(Card, { book: createLongOrderBookFixture('kr-1') }));
    const measuringView = renderer.root.find((node: any) => node.type === 'View' && typeof node.props.onLayout === 'function');
    act(() => measuringView.props.onLayout({ nativeEvent: { layout: { width: 214 } } }));
    assert.match(text(renderer.root), /좌우로 밀어/);
    assert.equal(text(host(renderer, 'asset-order-book-asks-1').children[0]), '123,456,789,012,345,678,970,100');
    const scroll = renderer.root.findByType('ScrollView');
    assert.equal(scroll.props.horizontal, true);
    assert.ok(scroll.children[0].props.style.width > 214);
    for (const node of renderer.root.findAllByType('Text')) {
      assert.equal(node.props.numberOfLines, undefined, 'no ellipsis or single-line clipping');
    }
    act(() => renderer.unmount());
  });

  it('renders decimal crypto levels and updates all units when switching KR → BTC → ETH → KR', () => {
    const h = interactionHarness();
    const Card = h.load('src/features/asset/AssetOrderBookCard.tsx').default;
    const renderer = h.render(React.createElement(Card, { book: createOrderBookFixture('kr') }));
    for (const [base, long] of [['BTC', false], ['ETH', true]] as const) {
      const book = createCryptoOrderBookFixture(base, base, long);
      act(() => renderer.update(React.createElement(Card, { book, isPreview: true })));
      assert.ok(text(renderer.root).includes(`${base} / USDT`));
      assert.ok(text(renderer.root).includes(`가격 (USDT) · 잔량 (${base})`));
      assert.doesNotMatch(text(renderer.root), /잔량 \(주\)|가격 \(원\)|\$/u);
      for (const side of ['asks', 'bids'] as const) {
        const rows = renderer.root.findAll((node: any) => node.type === 'View' && new RegExp(`^asset-order-book-${side}-\\d+$`).test(node.props.testID ?? ''));
        assert.equal(rows.length, 10);
        book[side].forEach((level, i) => {
          const row = host(renderer, `asset-order-book-${side}-${i + 1}`);
          assert.equal(text(row.children[0]), formatOrderBookDecimal(level.price));
          assert.equal(text(row.children[1]), formatOrderBookDecimal(level.quantity));
          assert.ok(row.props.accessibilityLabel.endsWith(`${formatOrderBookDecimal(level.quantity)} ${base}`));
          assert.ok(row.props.accessibilityLabel.includes(' USDT,'));
        });
      }
      assert.equal(text(host(renderer, 'asset-order-book-asks-2').children[1]), '0.00125');
      assert.equal(text(host(renderer, 'asset-order-book-asks-4').children[1]), long ? '0.000000000000000001' : '0.00000001');
      assert.equal(text(host(renderer, 'asset-order-book-asks-5').children[1]), long ? '12,345,678,901,234,567,890.123456789012345678' : '12,345.6789');
      assert.equal(text(host(renderer, 'asset-order-book-asks-6').children[1]), '0');
      assert.doesNotMatch(text(renderer.root), /총 매도잔량|총 매수잔량/);
    }
    act(() => renderer.update(React.createElement(Card, { book: createOrderBookFixture('kr') })));
    assert.match(text(renderer.root), /가격 \(원\) · 잔량 \(주\)/);
    assert.doesNotMatch(text(renderer.root), /BTC|ETH|USDT/);
    act(() => renderer.unmount());
  });

  it('renders partial and empty crypto sides and fractional exchange totals without rounding', () => {
    const h = interactionHarness();
    const Card = h.load('src/features/asset/AssetOrderBookCard.tsx').default;
    const book = { ...createCryptoOrderBookFixture('btc', 'BTC'), asks: [], bids: [{ price: '0.000000000000000001', quantity: '0.125' }],
      totalAskQuantity: '0.000', totalBidQuantity: '12345678901234567890.123456789012345678' };
    const renderer = h.render(React.createElement(Card, { book }));
    assert.match(text(renderer.root), /매도호가가 없습니다/);
    assert.match(text(renderer.root), /매수호가 · 1단계/);
    assert.equal(text(host(renderer, 'asset-order-book-bids-1').children[0]), '0.000000000000000001');
    assert.equal(text(host(renderer, 'asset-order-book-bids-1').children[1]), '0.125');
    assert.match(text(host(renderer, 'asset-order-book-bids-total')), /12,345,678,901,234,567,890\.123456789012345678/);
    act(() => renderer.update(React.createElement(Card, { book: { ...book, bids: [] } })));
    assert.match(text(renderer.root), /매수호가가 없습니다/);
    act(() => renderer.unmount());
  });
});
