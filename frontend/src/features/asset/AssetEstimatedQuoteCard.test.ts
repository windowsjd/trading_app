import { financial } from '../../theme/financialColors.ts';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { AssetEstimatedQuote } from './estimatedQuote.ts';
const require = createRequire(import.meta.url);
const { interactionHarness, flatten, React, act } = require('../../../test/interactionTestHarness.cjs');

// Synthetic estimate, never provider data.
const estimate = (overrides: Partial<AssetEstimatedQuote> = {}): AssetEstimatedQuote => ({
  assetId: 'asset-aapl',
  kind: 'estimated_liquidity',
  provider: 'tiingo',
  priceCurrency: 'USD',
  quantityUnit: 'share',
  bid: { price: '247.45', size: '300' },
  ask: { price: '247.55', size: '1234567' },
  spread: '0.0004',
  referencePrice: '247.5',
  effectiveAt: '2026-10-13T14:29:59.000Z',
  capturedAt: '2026-10-13T14:29:59.500Z',
  ...overrides,
});

function render(props: Record<string, unknown>, fontScale = 1) {
  const h = interactionHarness();
  h.dimensions.fontScale = fontScale;
  const Card = h.load('src/features/asset/AssetEstimatedQuoteCard.tsx').default;
  const renderer = h.render(React.createElement(Card, props));
  const text = () => JSON.stringify(renderer.toJSON());
  return { renderer, text, unmount: () => act(() => renderer.unmount()) };
}

describe('estimated quote card', () => {
  for (const fontScale of [1, 2]) {
    it(`shows a one-level statistical estimate without the title, badge or notices (font ${fontScale})`, (t) => {
      const view = render({ estimate: estimate(), statusMessage: null }, fontScale);
      t.after(view.unmount);
      const text = view.text();
      // Removed (2026-10-19): the 추정 호가 title, the Tiingo 통계 추정 badge and both notices.
      for (const removed of ['추정 호가', 'Tiingo', '통계 추정', '실제 거래소 호가', '주문 체결에 사용되지 않습니다', '정규장에만']) {
        assert.equal(text.includes(removed), false, removed);
      }
      assert.equal(view.renderer.root.findAll((node: any) => node.props?.testID === 'asset-estimated-quote-badge').length, 0);
      // Still an estimate: each row and the spread say so.
      assert.ok(text.includes('매도 추정'));
      assert.ok(text.includes('매수 추정'));
      const rows = view.renderer.root.findAll(
        (node: any) => typeof node.type === 'string' && /^asset-estimated-quote-(?:ask|bid)$/.test(node.props.testID ?? ''),
      );
      assert.equal(rows.length, 2, 'exactly one level per side');
      assert.equal(view.renderer.root.findAllByType('ScrollView').length, 0, 'no ladder');
      assert.equal(view.renderer.root.findAllByType('Pressable').length, 0, 'not an order input');
      const ask = view.renderer.root.findByProps({ testID: 'asset-estimated-quote-ask' });
      assert.match(ask.props.accessibilityLabel, /매도 추정 가격 \$247\.55, 수량 1,234,567주/);
      assert.ok(text.includes('1,234,567주'));
      assert.ok(text.includes('추정 스프레드 0.04%'));
    });
  }

  it('shows a missing side as unavailable instead of inventing it', (t) => {
    const view = render({
      estimate: estimate({ ask: { price: null, size: null }, spread: null }),
      statusMessage: null,
    });
    t.after(view.unmount);
    const ask = view.renderer.root.findByProps({ testID: 'asset-estimated-quote-ask' });
    assert.match(ask.props.accessibilityLabel, /매도 추정 가격 미제공, 수량 미제공/);
    assert.ok(view.text().includes('추정 스프레드 미제공'));
    const bid = view.renderer.root.findByProps({ testID: 'asset-estimated-quote-bid' });
    assert.match(bid.props.accessibilityLabel, /매수 추정 가격 \$247\.45, 수량 300주/);
  });

  it('uses the shared buy/sell colors', (t) => {
    const view = render({ estimate: estimate(), statusMessage: null });
    t.after(view.unmount);
    const ask = view.renderer.root.findByProps({ testID: 'asset-estimated-quote-ask' });
    const bid = view.renderer.root.findByProps({ testID: 'asset-estimated-quote-bid' });
    assert.equal(flatten(ask.props.style).backgroundColor, financial.sellSurface);
    assert.equal(flatten(bid.props.style).backgroundColor, financial.buySurface);
    assert.equal(flatten(ask.children[1].props.style).color, financial.sell);
    assert.equal(flatten(bid.children[1].props.style).color, financial.buy);
  });

  it('draws nothing without an estimate: no empty card, whatever the status', (t) => {
    for (const statusMessage of [null, '현재 표시할 추정 호가가 없습니다.', '추정 호가를 불러오는 중입니다.', '추정 호가 연결을 복구하는 중입니다.']) {
      const view = render({ estimate: null, statusMessage });
      t.after(view.unmount);
      assert.equal(view.renderer.toJSON() === null, true, String(statusMessage));
    }
  });

  it('scrolls long exact values sideways in a narrow column instead of clipping them', (t) => {
    const view = render(
      {
        estimate: estimate({
          bid: { price: '12345.123456', size: '123456789' },
          ask: { price: '12345.987654', size: '987654321' },
        }),
        statusMessage: null,
      },
      2,
    );
    t.after(view.unmount);
    const container = view.renderer.root.findByProps({ testID: 'asset-estimated-quote' });
    act(() => container.props.onLayout({ nativeEvent: { layout: { width: 130, height: 200 } } }));
    const scrolls = view.renderer.root.findAllByType('ScrollView');
    assert.equal(scrolls.length, 2);
    assert.ok(scrolls.every((scroll: any) => scroll.props.horizontal));
    assert.ok(view.text().includes('추정 호가 좌우로 밀기'));
    // Values stay exact (never rounded to fit).
    assert.ok(view.text().includes('$12,345.987654'));
    assert.ok(view.text().includes('987,654,321주'));
  });

  it('states a delay of the estimate it shows', (t) => {
    const view = render({ estimate: estimate(), statusMessage: '추정 호가가 지연되고 있습니다.' });
    t.after(view.unmount);
    assert.equal(
      view.renderer.root.findByProps({ testID: 'asset-estimated-quote-status' }).props.children,
      '추정 호가가 지연되고 있습니다.',
    );
  });
});
