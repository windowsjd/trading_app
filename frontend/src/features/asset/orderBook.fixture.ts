import type { AssetOrderBook } from './orderBook';

/** Fixed layout examples, unrelated to the selected asset's actual price. */
export function createOrderBookFixture(assetId: string): AssetOrderBook {
  return {
    assetId,
    currency: 'KRW',
    capturedAt: '2026-09-18T01:15:31.000Z',
    effectiveAt: '2026-09-18T01:15:30.000Z',
    asks: [
      { price: '70100', quantity: '1234' },
      { price: '70200', quantity: '98765' },
      { price: '70300', quantity: '350' },
      { price: '70400', quantity: '1200000' },
      { price: '70500', quantity: '56789' },
      { price: '70600', quantity: '1' },
      { price: '70700', quantity: '4567890' },
      { price: '70800', quantity: '23000' },
      { price: '70900', quantity: '678901' },
      { price: '71000', quantity: '1234567890' },
    ],
    bids: [
      { price: '70000', quantity: '2345' },
      { price: '69900', quantity: '87654' },
      { price: '69800', quantity: '460' },
      { price: '69700', quantity: '2100000' },
      { price: '69600', quantity: '67890' },
      { price: '69500', quantity: '12' },
      { price: '69400', quantity: '3456789' },
      { price: '69300', quantity: '34000' },
      { price: '69200', quantity: '789012' },
      { price: '69100', quantity: '987654321' },
    ],
    totalAskQuantity: '2345678901',
    totalBidQuantity: '1234567890',
  };
}

/** Deliberately extreme values for precision and horizontal layout checks. */
export function createLongOrderBookFixture(assetId: string): AssetOrderBook {
  const book = createOrderBookFixture(assetId);
  return {
    ...book,
    asks: book.asks.map((level) => ({
      price: `1234567890123456789${level.price}`,
      quantity: `987654321098${level.quantity}`,
    })),
    bids: book.bids.map((level) => ({
      price: `1234567890123456789${level.price}`,
      quantity: `987654321098${level.quantity}`,
    })),
    totalAskQuantity: '999999999999999999999999',
    totalBidQuantity: '888888888888888888888888',
  };
}
