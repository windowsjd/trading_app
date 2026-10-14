import { parseAssetOrderBook } from './assetOrderBookPolicy';
import { useOrderBookStream } from './orderBookStream';

/** Reference-counted Spot ladder subscription; no query/financial cache. */
export function useAssetOrderBook({ assetId, wsUrl, enabled = true }: {
  assetId: string; wsUrl: string; enabled?: boolean;
}) {
  return useOrderBookStream({
    source: { channel: 'asset_order_book', id: assetId },
    wsUrl,
    enabled,
    parse: parseAssetOrderBook,
  });
}
