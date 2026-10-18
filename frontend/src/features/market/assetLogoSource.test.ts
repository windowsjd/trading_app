import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { assetMonogram, BUNDLED_CRYPTO_LOGOS, cryptoBaseAsset, krxCommonShareIsin, resolveAssetLogo } from './assetLogoSource.ts';

const key = 'pk_test key';
const assets = path.join(process.cwd(), 'src', 'assets', 'crypto-logos');

it('bundles exactly the verified coin icons, each mapped once in the component', () => {
  const files = readdirSync(assets).filter((file) => file.endsWith('.png')).map((file) => file.slice(0, -4).toUpperCase()).sort();
  assert.deepEqual(files, [...BUNDLED_CRYPTO_LOGOS].sort());
  const component = readFileSync(path.join(process.cwd(), 'src', 'features', 'market', 'AssetLogo.tsx'), 'utf8');
  for (const symbol of BUNDLED_CRYPTO_LOGOS) {
    const lower = symbol.toLowerCase();
    assert.match(component, new RegExp(`import ${lower} from '\\.\\./\\.\\./assets/crypto-logos/${lower}\\.png';`), symbol);
    assert.match(component, new RegExp(`\\b${symbol}: ${lower}\\b`), symbol);
  }
  // Curve's manifest entry was rejected on its artwork (README).
  assert.equal((BUNDLED_CRYPTO_LOGOS as readonly string[]).includes('CRV'), false);
});

it('reads the Binance base asset of Spot and USDⓈ-M crypto rows only', () => {
  assert.equal(cryptoBaseAsset({ assetType: 'crypto', market: 'BINANCE', symbol: 'BTCUSDT' }), 'BTC');
  assert.equal(cryptoBaseAsset({ assetType: 'crypto', market: 'USDⓈ-M 무기한', symbol: 'ethusdt' }), 'ETH');
  assert.equal(cryptoBaseAsset({ assetType: 'crypto', symbol: '1000PEPEUSDT' }), '1000PEPE');
  for (const asset of [{ assetType: 'us_stock', symbol: 'BTCUSDT' }, { assetType: 'crypto', symbol: 'BTC' }, { assetType: 'crypto', symbol: null }]) {
    assert.equal(cryptoBaseAsset(asset), null, JSON.stringify(asset));
  }
});

it('crypto uses only the bundled verified icons, never a remote lookup by ticker', () => {
  assert.deepEqual(resolveAssetLogo({ assetType: 'crypto', market: 'BINANCE', symbol: 'BTCUSDT' }, { logoDevKey: key }), { kind: 'bundled', key: 'BTC' });
  assert.deepEqual(resolveAssetLogo({ assetType: 'crypto', market: 'USDⓈ-M 무기한', symbol: 'SOLUSDT' }, { logoDevKey: null }), { kind: 'bundled', key: 'SOL' });
  for (const symbol of ['PEPEUSDT', 'CRVUSDT', 'REUSDT', '1000PEPEUSDT']) {
    assert.equal(resolveAssetLogo({ assetType: 'crypto', market: 'BINANCE', symbol }, { logoDevKey: key }), null, symbol);
  }
});

it('stocks get a provider logo only with a key, by an identifier unique to their own listing', () => {
  const uri = (asset: Parameters<typeof resolveAssetLogo>[0]) => {
    const source = resolveAssetLogo(asset, { logoDevKey: key });
    return source?.kind === 'remote' ? source.uri : null;
  };
  assert.equal(uri({ assetType: 'us_stock', market: 'NAS', symbol: 'AAPL' }),
    'https://img.logo.dev/ticker/AAPL?token=pk_test%20key&size=64&retina=true&format=png&fallback=404');
  assert.match(uri({ assetType: 'us_stock', market: 'NYS', symbol: 'BRK.B' }) ?? '', /^https:\/\/img\.logo\.dev\/isin\/US0846707026\?/);
  assert.match(uri({ assetType: 'domestic_stock', market: 'KRX', symbol: '005930' }) ?? '', /^https:\/\/img\.logo\.dev\/isin\/KR7005930003\?/);
  // No key: no request at all.
  assert.equal(resolveAssetLogo({ assetType: 'us_stock', market: 'NAS', symbol: 'AAPL' }, { logoDevKey: null }), null);
  // A listing that is not what its fields claim gets no logo rather than someone else's.
  for (const asset of [{ assetType: 'us_stock', market: 'KRX', symbol: 'AAPL' }, { assetType: 'domestic_stock', market: 'NAS', symbol: '005930' },
    { assetType: 'domestic_stock', market: 'KRX', symbol: 'ABC123' }, { assetType: 'us_stock', market: 'NYS', symbol: 'WEIRD.X' },
    { assetType: 'etf', market: 'NAS', symbol: 'QQQ' }]) {
    assert.equal(resolveAssetLogo(asset, { logoDevKey: key }), null, JSON.stringify(asset));
  }
});

it('a release build carries the key it was built with, and a build without one requests no provider logos', () => {
  // The Metro release transform itself (babel-preset-expo, isDev false), not a
  // runtime read: on device process.env holds no EXPO_PUBLIC_ value, so the
  // key reaches the app only if the build inlined it.
  const require = createRequire(import.meta.url);
  const babel = require('@babel/core');
  const filename = path.join(process.cwd(), 'src', 'features', 'market', 'assetLogoSource.ts');
  const source = readFileSync(filename, 'utf8');
  assert.match(source, /process\.env\.EXPO_PUBLIC_LOGO_DEV_KEY/);
  assert.doesNotMatch(source, /process\.env\?\.EXPO_PUBLIC_LOGO_DEV_KEY/);
  const releaseBuild = (buildKey: string | undefined) => {
    const saved = process.env.EXPO_PUBLIC_LOGO_DEV_KEY;
    if (buildKey === undefined) delete process.env.EXPO_PUBLIC_LOGO_DEV_KEY;
    else process.env.EXPO_PUBLIC_LOGO_DEV_KEY = buildKey;
    try {
      const { code } = babel.transformSync(source, {
        filename, babelrc: false, configFile: false, comments: false, presets: ['babel-preset-expo'],
        caller: { name: 'metro', bundler: 'metro', platform: 'android', isDev: false },
      });
      // A decoy runtime value: only a non-inlined read could pick it up.
      const module = { exports: {} as { LOGO_DEV_KEY?: string | null } };
      runInNewContext(code, { module, exports: module.exports, require, process: { env: { EXPO_PUBLIC_LOGO_DEV_KEY: 'pk_runtime' } } });
      return { code: code as string, logoDevKey: module.exports.LOGO_DEV_KEY };
    } finally {
      if (saved === undefined) delete process.env.EXPO_PUBLIC_LOGO_DEV_KEY;
      else process.env.EXPO_PUBLIC_LOGO_DEV_KEY = saved;
    }
  };
  const withKey = releaseBuild(' pk_build ');
  assert.equal(withKey.logoDevKey, 'pk_build');
  assert.equal(/process\.env/.test(withKey.code), false);
  const withoutKey = releaseBuild(undefined);
  assert.equal(withoutKey.logoDevKey, null);
  assert.equal(withoutKey.code.includes('pk_'), false);
});

it('computes KRX common-share ISINs (published examples)', () => {
  for (const [code, isin] of [['005930', 'KR7005930003'], ['000660', 'KR7000660001'], ['035720', 'KR7035720002'],
    ['373220', 'KR7373220003'], ['086520', 'KR7086520004'], ['035420', 'KR7035420009'], ['005380', 'KR7005380001']]) {
    assert.equal(krxCommonShareIsin(code), isin, code);
  }
  for (const code of ['', '5930', '0059300', 'A05930']) assert.equal(krxCommonShareIsin(code), null, code);
});

it('marks a logo-less row with the first letter of the name it shows', () => {
  assert.deepEqual(['애플', 'bitcoin', ' Samsung', '', null, '𝔸lpha'].map(assetMonogram), ['애', 'B', 'S', '?', '?', '𝔸']);
});
