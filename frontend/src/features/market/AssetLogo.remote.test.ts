import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';

// A configured publishable key, read when assetLogoSource.ts first loads (this process only).
process.env.EXPO_PUBLIC_LOGO_DEV_KEY = 'pk_fixture';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

it('a stock logo from the provider fills its own 36 dp box with no mask or ground, and a failed load falls back to the monogram', (t) => {
  const h = interactionHarness();
  const AssetLogo = h.load('src/features/market/AssetLogo.tsx').default;
  const element = (props: Record<string, unknown>) => React.createElement(AssetLogo, { testID: 'logo', ...props });
  const renderer = h.render(element({ assetType: 'us_stock', market: 'NAS', symbol: 'AAPL', name: '애플' }));
  t.after(() => act(() => renderer.unmount()));
  const node = (id: string) => renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
  const image = node('logo-image');
  assert.equal(image.props.source.uri, 'https://img.logo.dev/ticker/AAPL?token=pk_fixture&size=64&retina=true&format=png&fallback=404');
  // Its own proportions, centred in the row's 40 dp square: never masked, cut or put on a ground of ours.
  assert.deepEqual([flatten(image.props.style).width, flatten(image.props.style).height, image.props.resizeMode], [36, 36, 'contain']);
  const box = flatten(node('logo').props.style);
  assert.deepEqual([box.width, box.height, box.alignItems, box.justifyContent, box.flexShrink], [40, 40, 'center', 'center', 0]);
  assert.deepEqual([box.borderRadius, box.overflow, box.backgroundColor, box.borderWidth].map((value) => value === undefined), [true, true, true, true]);
  act(() => image.props.onError());
  assert.equal(node('logo-image') === undefined, true);
  assert.equal(node('logo-monogram').children.join(''), '애');
  // The fallback keeps its circle.
  assert.equal(flatten(node('logo').props.style).borderRadius, 20);
  // Another listing in the same (recycled) row tries its own logo again.
  act(() => renderer.update(element({ assetType: 'domestic_stock', market: 'KRX', symbol: '005930', name: '삼성전자' })));
  assert.match(node('logo-image').props.source.uri, /\/isin\/KR7005930003\?/);
  // Crypto stays on the bundled verified icons even with a key.
  act(() => renderer.update(element({ assetType: 'crypto', market: 'BINANCE', symbol: 'PEPEUSDT', name: 'Pepe' })));
  assert.equal(node('logo-image') === undefined, true);
});

it('on a dark screen a stock logo is the provider\'s dark variant; coins keep their bundled icon', (t) => {
  const h = interactionHarness();
  const AssetLogo = h.load('src/features/market/AssetLogo.tsx', {
    '../../theme/appearance': { useAppearance: () => ({ mode: 'dark' }) },
  }).default;
  const renderer = h.render(React.createElement(AssetLogo, { testID: 'logo', assetType: 'us_stock', market: 'NAS', symbol: 'AAPL', name: '애플' }));
  t.after(() => act(() => renderer.unmount()));
  const node = (id: string) => renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
  assert.equal(node('logo-image').props.source.uri,
    'https://img.logo.dev/ticker/AAPL?token=pk_fixture&size=64&retina=true&format=png&fallback=404&theme=dark');
  act(() => renderer.update(React.createElement(AssetLogo, { testID: 'logo', assetType: 'crypto', market: 'BINANCE', symbol: 'BTCUSDT', name: 'Bitcoin' })));
  assert.equal(node('logo-image').props.source.uri.endsWith('/crypto-logos/btc.png'), true);
});
