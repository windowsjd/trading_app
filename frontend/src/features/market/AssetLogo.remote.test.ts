import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';

// A configured publishable key, read when assetLogoSource.ts first loads (this process only).
process.env.EXPO_PUBLIC_LOGO_DEV_KEY = 'pk_fixture';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

it('a stock logo from the provider sits inside the white circle, and a failed load falls back to the monogram', (t) => {
  const h = interactionHarness();
  const AssetLogo = h.load('src/features/market/AssetLogo.tsx').default;
  const element = (props: Record<string, unknown>) => React.createElement(AssetLogo, { testID: 'logo', ...props });
  const renderer = h.render(element({ assetType: 'us_stock', market: 'NAS', symbol: 'AAPL', name: '애플' }));
  t.after(() => act(() => renderer.unmount()));
  const node = (id: string) => renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
  const image = node('logo-image');
  assert.equal(image.props.source.uri, 'https://img.logo.dev/ticker/AAPL?token=pk_fixture&size=64&retina=true&format=png&fallback=404');
  // 28 dp fits corner to corner inside the 40 dp circle, whatever the logo's shape.
  assert.deepEqual([flatten(image.props.style).width, flatten(image.props.style).height, image.props.resizeMode], [28, 28, 'contain']);
  assert.equal(28 * Math.SQRT2 < 40, true);
  assert.equal(flatten(node('logo').props.style).backgroundColor, '#FFFFFF');
  act(() => image.props.onError());
  assert.equal(node('logo-image') === undefined, true);
  assert.equal(node('logo-monogram').children.join(''), '애');
  // Another listing in the same (recycled) row tries its own logo again.
  act(() => renderer.update(element({ assetType: 'domestic_stock', market: 'KRX', symbol: '005930', name: 'Samsung Electronics' })));
  assert.match(node('logo-image').props.source.uri, /\/isin\/KR7005930003\?/);
  // Crypto stays on the bundled verified icons even with a key.
  act(() => renderer.update(element({ assetType: 'crypto', market: 'BINANCE', symbol: 'PEPEUSDT', name: 'Pepe' })));
  assert.equal(node('logo-image') === undefined, true);
});
