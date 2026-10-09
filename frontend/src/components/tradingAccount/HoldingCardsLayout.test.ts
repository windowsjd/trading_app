import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { holding } from '../../../test/positionFixture.ts';
import { financial } from '../../theme/financialColors.ts';
import { semantic, resolveSemanticStyle } from '../../theme/tokens.ts';
const { interactionHarness, React, act, flatten } = createRequire(import.meta.url)('../../../test/interactionTestHarness.cjs');

for (const platform of ['android', 'ios']) for (const mode of ['light', 'dark'])
  for (const width of [320, 360, 390, 430]) for (const fontScale of [1, 2]) {
    it(`${platform}/${mode}/${width}/${fontScale}: native holding cards retain all financial text and adapt their tracks`, t => {
      const h = interactionHarness(platform);
      h.dimensions = { width, fontScale, height: 844 };
      const Spot = h.load('src/components/tradingAccount/PositionAssetRow.tsx', {
        '../states/AdminDiagnosticPanel': { default: () => null, __esModule: true },
      }).default;
      const Future = h.load('src/components/tradingAccount/FuturesPositionRow.tsx').default;
      const spot = holding('btc', { assetType: 'crypto', symbol: 'BTCUSDT', market: 'BINANCE', quantity: '0.00000001',
        name: 'Bitcoin 대한민국 미래산업 ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
      Object.assign(spot.valuation, { priceCurrency: 'USD', positionValue: '1234567890123456.12345678', unrealizedPnl: '-123456789012345.12', returnRate: '-99.12345678' });
      const now = Date.now(), at = new Date(now - 1000).toISOString();
      const future = { assetId: 'btc', symbol: 'BTCUSDT', name: spot.name, direction: 'long', marginMode: 'cross', leverage: 37,
        markNotional: '1234567890123456.12345678', markUnrealizedPnl: '-123456789012345.12', roi: '-99.12345678',
        markState: 'fresh', markEvidence: { effectiveAt: at, capturedAt: at } };
      const renderer = h.render(React.createElement(React.Fragment, {},
        React.createElement(Spot, { position: spot, testID: 'spot' }),
        React.createElement(Future, { position: future, evaluatedAt: at, now, testID: 'future' })));
      t.after(() => act(() => renderer.unmount()));
      const node = id => renderer.root.findAll(n => n.type === 'Text' && n.props.testID === id)[0];
      assert.equal(node('spot-quantity').props.children, '보유수량 0.00000001 BTC');
      assert.equal(node('spot-value').props.children, '$1,234,567,890,123,456.12');
      assert.equal(node('future-notional').props.children, '$1,234,567,890,123,456.12');
      assert.equal(node('spot-return').props.children, '-$123,456,789,012,345.12 (-99.12%)');
      assert.equal(node('future-performance').props.children, '-$123,456,789,012,345.12 (-99.12%)');
      const track = node('spot-value').parent;
      assert.equal(flatten(track.parent.props.style).flexDirection, fontScale === 2 ? 'column' : 'row');
      assert.equal(flatten(track.props.style).maxWidth, fontScale === 2 ? '100%' : '60%');
      for (const text of renderer.root.findAllByType('Text')) {
        assert.equal(text.props.numberOfLines === undefined, true);
        assert.equal(text.props.ellipsizeMode === undefined, true);
        assert.equal(text.props.allowFontScaling === false, false);
        assert.equal(text.props.adjustsFontSizeToFit === true, false);
      }
      assert.equal(renderer.root.findAllByType('Pressable').length, 0, 'read-only portfolios expose no trading or navigation control');
      assert.equal(flatten(node('future-direction').props.style).color, financial.buyAction);
      assert.equal(flatten(node('future-performance').props.style).color, financial.fall);
      for (const preference of ['red_blue', 'green_red']) {
        const colors = { secondary: 'neutral' };
        const pnl = flatten(resolveSemanticStyle(node('future-performance').props.style, colors as any, mode as any, preference as any)).color;
        const direction = flatten(resolveSemanticStyle(node('future-direction').props.style, colors as any, mode as any, preference as any)).color;
        assert.equal(pnl === direction, false, 'a LONG loss uses the loss role independently of the buy direction');
      }
      assert.equal(flatten(node('spot-quantity').props.style).color, semantic.secondary);
    });
  }
