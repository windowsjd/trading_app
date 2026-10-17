import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { AssetsResponseDto, MarketAssetItemDto } from './api';
import { prependKoreanNameMatches } from './koreanNameSearch.ts';

const asset = (id: string, symbol: string, market: string, assetType: MarketAssetItemDto['assetType'] = 'us_stock') =>
  ({ id, symbol, market, assetType, name: id }) as MarketAssetItemDto;
const page = (assets: MarketAssetItemDto[], priceErrors: AssetsResponseDto['priceErrors'] = []): AssetsResponseDto => ({
  assets, priceErrors, sortSnapshot: 'server-sort',
  pagination: { limit: 20, offset: 0, total: assets.length, returned: assets.length, nextOffset: null },
});
const listed = {
  assets: [asset('a-nvda', 'NVDA', 'NAS'), asset('a-aapl', 'AAPL', 'NAS'), asset('x-aapl', 'AAPL', 'NYS'), asset('c-aapl', 'AAPLUSDT', 'BINANCE', 'crypto')],
  priceErrors: [{ assetId: 'a-aapl', code: 'PRICE_STALE' }, { assetId: 'a-nvda', code: 'PRICE_STALE' }],
};

it('puts the matched listings first, in the list order, and keeps the server page as it was', () => {
  const server = page([asset('kr-1', '005930', 'KRX', 'domestic_stock')]);
  const merged = prependKoreanNameMatches(server, listed, [{ market: 'NAS', symbol: 'AAPL' }, { market: 'NAS', symbol: 'NVDA' }]);
  assert.deepEqual(merged.assets.map((item) => item.id), ['a-nvda', 'a-aapl', 'kr-1']);
  assert.deepEqual([merged.sortSnapshot, merged.pagination], [server.sortSnapshot, server.pagination]);
  // Only the matched listings' price errors join the page's own.
  assert.deepEqual(merged.priceErrors?.map((error) => error.assetId), ['a-aapl', 'a-nvda']);
});

it('matches the exact listing: the same symbol on another market or a coin never joins', () => {
  const merged = prependKoreanNameMatches(page([]), listed, [{ market: 'NAS', symbol: 'AAPL' }]);
  assert.deepEqual(merged.assets.map((item) => item.id), ['a-aapl']);
});

it('an asset already on the server page appears once; no match leaves the page untouched', () => {
  const server = page([asset('a-aapl', 'AAPL', 'NAS')], [{ assetId: 'a-aapl', code: 'PRICE_STALE' }]);
  const merged = prependKoreanNameMatches(server, listed, [{ market: 'NAS', symbol: 'AAPL' }]);
  assert.deepEqual(merged.assets.map((item) => item.id), ['a-aapl']);
  assert.deepEqual(merged.priceErrors?.map((error) => error.assetId), ['a-aapl']);
  assert.equal(prependKoreanNameMatches(server, listed, []) === server, true);
  assert.equal(prependKoreanNameMatches(server, listed, [{ market: 'NAS', symbol: 'MSFT' }]) === server, true);
});
