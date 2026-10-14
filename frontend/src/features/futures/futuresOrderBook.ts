import type { AssetOrderBook } from '../asset/orderBook';
import { parseOrderBookSnapshot } from '../asset/assetOrderBookPolicy.ts';

const FUTURES_SYMBOL = /^[A-Z0-9]{1,30}USDT$/u;

/**
 * One USDⓈ-M contract ladder message, display only. It must be the contract
 * channel and this exact instrument: a Spot `asset_order_book` (even of the
 * same underlying) is never accepted. The result reuses the Spot ladder's
 * display model, keyed by the instrument id.
 */
export function parseFuturesOrderBook(
  value: unknown,
  instrumentId: string,
): AssetOrderBook | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const message = value as Record<string, unknown>;
  if (
    message.type !== 'futures_order_book' ||
    message.instrumentId !== instrumentId ||
    typeof message.symbol !== 'string' ||
    !FUTURES_SYMBOL.test(message.symbol)
  )
    return null;
  return parseOrderBookSnapshot(message, instrumentId);
}
