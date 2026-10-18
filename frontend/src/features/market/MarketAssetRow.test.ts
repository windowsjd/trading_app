import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

const strings = (node: any): string[] =>
  node.children.flatMap((child: any) => (typeof child === 'string' ? [child] : strings(child)));

function row(patch: Record<string, unknown>) {
  return {
    id: 'asset', assetType: 'us_stock', symbol: 'AAPL', name: 'Apple Inc.', market: 'NAS', priceCurrency: 'USD',
    settlementCurrency: 'USD', isActive: true, marketStatus: 'open', tradable: true, changeRate: '1.25',
    price: { state: 'available', currentPrice: '250.12', priceCurrency: 'USD', changeRate: '1.25' }, ...patch,
  };
}

function render(t: any, items: Array<Record<string, unknown>>) {
  const h = interactionHarness();
  h.dimensions = { width: 360, height: 800, fontScale: 1 };
  const { MarketAssetRow } = h.load('src/features/market/MarketAssetRow.tsx', {
    '../../components/common/ActionPressable': { default: h.ActionPressable, __esModule: true },
    '../../components/states/AdminDiagnosticPanel': { default: 'AdminDiagnosticPanel', __esModule: true },
  });
  const renderer = h.render(React.createElement(React.Fragment, null,
    items.map((item) => React.createElement(MarketAssetRow, { key: String(item.id), item, onPress() {} }))));
  t.after(() => act(() => renderer.unmount()));
  const node = (id: string) => renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
  return { renderer, node, text: (id: string) => strings(node(id)).join('') };
}

it('a US stock leads with its Korean name and keeps the English name and symbol under it', (t) => {
  const r = render(t, [row({ id: 'us-aapl' }), row({ id: 'us-klac', symbol: 'KLAC', name: 'KLA Corp.' }),
    row({ id: 'us-elsewhere', market: 'NYS' })]);
  assert.deepEqual([r.text('market-name-us-aapl'), r.text('market-subtitle-us-aapl')], ['애플', '(Apple Inc.) · AAPL']);
  // No Korean name at the source, or a listing that is not this one: the English name and `symbol · market` as before.
  assert.deepEqual([r.text('market-name-us-klac'), r.text('market-subtitle-us-klac')], ['KLA Corp.', 'KLAC · NAS']);
  assert.deepEqual([r.text('market-name-us-elsewhere'), r.text('market-subtitle-us-elsewhere')], ['Apple Inc.', 'AAPL · NYS']);
});

it('domestic and crypto rows keep their names; verified coins show their icon, others a monogram', (t) => {
  const r = render(t, [
    row({ id: 'kr', assetType: 'domestic_stock', symbol: '005930', name: 'Samsung Electronics', market: 'KRX', priceCurrency: 'KRW' }),
    row({ id: 'btc', assetType: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin', market: 'BINANCE' }),
    row({ id: 'pepe', assetType: 'crypto', symbol: 'PEPEUSDT', name: 'Pepe', market: 'BINANCE' }),
    row({ id: 'perp', assetType: 'crypto', symbol: 'ETHUSDT', name: 'Ethereum', market: 'USDⓈ-M 무기한' }),
  ]);
  assert.deepEqual([r.text('market-name-kr'), r.text('market-subtitle-kr')], ['Samsung Electronics', 'KRX']);
  assert.deepEqual([r.text('market-name-btc'), r.text('market-subtitle-btc')], ['Bitcoin', 'BTCUSDT']);
  assert.equal(r.node('market-logo-btc-image').props.source.uri.endsWith('/crypto-logos/btc.png'), true);
  assert.equal(r.node('market-logo-perp-image').props.source.uri.endsWith('/crypto-logos/eth.png'), true, 'futures rows share the coin');
  // Without a verified icon (and with no stock logo key here) the shown name's first letter marks the row.
  assert.deepEqual([r.text('market-logo-pepe-monogram'), r.text('market-logo-kr-monogram')], ['P', 'S']);
  assert.equal(r.node('market-logo-pepe-image') === undefined, true);
});

it('the logo keeps one 40 dp circle that nothing leaves, beside names that wrap rather than overlap', (t) => {
  const r = render(t, [row({ id: 'btc', assetType: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin', market: 'BINANCE' }),
    row({ id: 'long', symbol: 'SPCX', name: 'Space Exploration Technologies Corp. Class A' })]);
  for (const id of ['btc', 'long']) {
    const circle = flatten(r.node(`market-logo-${id}`).props.style);
    assert.deepEqual([circle.width, circle.height, circle.borderRadius, circle.overflow, circle.flexShrink], [40, 40, 20, 'hidden', 0], id);
    // Decorative: the name is the row's label.
    assert.equal(r.node(`market-logo-${id}`).props.accessibilityElementsHidden, true);
  }
  const icon = flatten(r.node('market-logo-btc-image').props.style);
  assert.deepEqual([icon.width, icon.height, r.node('market-logo-btc-image').props.resizeMode], [40, 40, 'contain']);
  // Names take the room beside the circle and wrap (no line limit); the price column wraps below when needed.
  const identity = r.node('market-name-long').parent;
  const leading = identity.parent;
  assert.deepEqual([flatten(identity.props.style).flex, flatten(identity.props.style).minWidth], [1, 0]);
  assert.deepEqual([flatten(leading.props.style).flexDirection, flatten(leading.props.style).minWidth], ['row', 0]);
  // The logo comes first in that row (through its memoized component to the host circle).
  let first = leading.children[0];
  while (first && typeof first.type !== 'string') first = first.children[0];
  assert.equal(first === r.node('market-logo-long'), true);
  assert.equal(r.node('market-name-long').props.numberOfLines, undefined);
  assert.equal(r.text('market-subtitle-long'), '(Space Exploration Technologies Corp. Class A) · SPCX');
});

it('a closed US market\'s last confirmed close is labeled 종가 without its session date; other rows carry no label', (t) => {
  const close = { sourceType: 'provider_api', sourceName: 'tiingo_eod', snapshotId: null, fallbackUsed: true,
    fallbackReason: 'market_closed_last_close' };
  const r = render(t, [
    row({ id: 'closed', marketStatus: 'closed', tradable: false,
      price: { state: 'available', currentPrice: '250.12', priceCurrency: 'USD', changeRate: '1.25',
        priceSource: close, priceEffectiveAt: '2026-10-16T20:00:00.000Z' } }),
    row({ id: 'live' }),
    // The KRX display close has its own reason and stays unlabeled (no date either).
    row({ id: 'krx', assetType: 'domestic_stock', symbol: '005930', name: 'Samsung Electronics', market: 'KRX', priceCurrency: 'KRW',
      marketStatus: 'closed', price: { state: 'available', currentPrice: '70000', priceCurrency: 'KRW', changeRate: '0',
        priceSource: { ...close, sourceName: 'koscom_intraday', fallbackReason: 'market_closed_krx_last_close' } } }),
  ]);
  assert.equal(r.text('market-last-close-closed'), '종가');
  assert.equal([r.node('market-last-close-live'), r.node('market-last-close-krx')].every((node) => node === undefined), true);
});
