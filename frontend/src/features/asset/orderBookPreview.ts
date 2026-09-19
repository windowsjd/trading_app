import { parsePublicBooleanFlag } from '../../constants/publicFlags.ts';
import type { AssetDetailAssetDto } from './api';
import type { AssetOrderBook } from './orderBook';

/** No HTTP, WebSocket, query cache, or fallback from a real price feed. */
export function getOrderBookPreview(
  asset: Pick<AssetDetailAssetDto, 'id' | 'assetType' | 'priceCurrency' | 'market' | 'symbol'>,
): AssetOrderBook | null {
  // __DEV__ is replaced by Metro in release builds. Keep the fixture require
  // behind this guard so an accidentally enabled public flag cannot expose it.
  if (typeof __DEV__ === 'undefined') return null;
  if (__DEV__ && parsePublicBooleanFlag(process.env.EXPO_PUBLIC_ORDER_BOOK_PREVIEW)) {
    // A positive __DEV__ branch also lets Metro remove the fixture dependency.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createOrderBookFixture, createLongOrderBookFixture, createCryptoOrderBookFixture } = require('./orderBook.fixture') as typeof import('./orderBook.fixture');
    const long = process.env.EXPO_PUBLIC_ORDER_BOOK_PREVIEW_LONG === 'true';
    if (asset.assetType === 'domestic_stock' && asset.priceCurrency === 'KRW') {
      return long ? createLongOrderBookFixture(asset.id) : createOrderBookFixture(asset.id);
    }
    // Current asset contract: BINANCE Spot symbols are <BASE>USDT, while the
    // financial price/settlement currency remains USD-equivalent. Do not guess
    // USDT or the base asset from a bare BTC symbol or from priceCurrency alone.
    if (asset.assetType === 'crypto' && asset.priceCurrency === 'USD' &&
        asset.market.trim().toUpperCase() === 'BINANCE') {
      const pair = /^([A-Z0-9]+)USDT$/u.exec(asset.symbol.trim().toUpperCase());
      if (pair) return createCryptoOrderBookFixture(asset.id, pair[1], long);
    }
  }
  return null;
}
