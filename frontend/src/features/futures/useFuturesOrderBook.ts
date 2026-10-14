import { useOrderBookStream } from '../asset/orderBookStream';
import { parseFuturesOrderBook } from './futuresOrderBook';

/** Reference-counted USDⓈ-M contract ladder subscription (display only). */
export function useFuturesOrderBook({ instrumentId, wsUrl, enabled = true }: {
  instrumentId: string; wsUrl: string; enabled?: boolean;
}) {
  return useOrderBookStream({
    source: { channel: 'futures_order_book', id: instrumentId },
    wsUrl,
    enabled,
    parse: parseFuturesOrderBook,
  });
}
