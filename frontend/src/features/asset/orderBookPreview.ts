import { parsePublicBooleanFlag } from '../../constants/publicFlags.ts';
import type { AssetDetailAssetDto } from './api';
import type { AssetOrderBook } from './orderBook';

/** No HTTP, WebSocket, query cache, or fallback from a real price feed. */
export function getOrderBookPreview(
  asset: Pick<AssetDetailAssetDto, 'id' | 'assetType' | 'priceCurrency'>,
): AssetOrderBook | null {
  // __DEV__ is replaced by Metro in release builds. Keep the fixture require
  // behind this guard so an accidentally enabled public flag cannot expose it.
  if (typeof __DEV__ === 'undefined') return null;
  if (__DEV__ && parsePublicBooleanFlag(process.env.EXPO_PUBLIC_ORDER_BOOK_PREVIEW)) {
    if (asset.assetType !== 'domestic_stock' || asset.priceCurrency !== 'KRW') return null;
    // A positive __DEV__ branch also lets Metro remove the fixture dependency.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createOrderBookFixture, createLongOrderBookFixture } = require('./orderBook.fixture') as typeof import('./orderBook.fixture');
    return process.env.EXPO_PUBLIC_ORDER_BOOK_PREVIEW_LONG === 'true'
      ? createLongOrderBookFixture(asset.id)
      : createOrderBookFixture(asset.id);
  }
  return null;
}
