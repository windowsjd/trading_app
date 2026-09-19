import type { AssetOrderBook } from './orderBook';

/** Fixed layout examples, unrelated to the selected asset's actual price. */
export function createOrderBookFixture(assetId: string): AssetOrderBook {
  return {
    assetId,
    priceUnit: '원',
    quantityUnit: '주',
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

/** Decimal layout examples shared by crypto previews, never actual quotations. */
export function createCryptoOrderBookFixture(
  assetId: string,
  baseAsset: string,
  long = false,
): AssetOrderBook {
  const book: AssetOrderBook = {
    assetId,
    priceUnit: 'USDT',
    quantityUnit: baseAsset,
    marketLabel: `${baseAsset} / USDT`,
    capturedAt: '2026-09-18T01:15:31.000Z',
    effectiveAt: '2026-09-18T01:15:30.000Z',
    asks: [
      { price: '68420.10', quantity: '0.003521' },
      { price: '68420.20', quantity: '0.00125000' },
      { price: '68420.30', quantity: '12.23456789' },
      { price: '68420.40', quantity: '0.00000001' },
      { price: '68420.50', quantity: '12345.6789' },
      { price: '68420.60', quantity: '0' },
      { price: '68420.70', quantity: '0.125' },
      { price: '68420.80', quantity: '123.456789' },
      { price: '68420.90', quantity: '12.345678' },
      { price: '68421.00', quantity: '1.23456789' },
    ],
    bids: [
      { price: '68420.00', quantity: '0.004321' },
      { price: '68419.90', quantity: '0.00250000' },
      { price: '68419.80', quantity: '23.34567891' },
      { price: '68419.70', quantity: '0.00000002' },
      { price: '68419.60', quantity: '23456.7891' },
      { price: '68419.50', quantity: '0.00000003' },
      { price: '68419.40', quantity: '0.25' },
      { price: '68419.30', quantity: '234.567891' },
      { price: '68419.20', quantity: '23.456789' },
      { price: '68419.10', quantity: '2.34567891' },
    ],
    // Depth snapshots need not supply exchange totals. Do not synthesize them.
  };
  if (!long) return book;
  return {
    ...book,
    asks: book.asks.map((level, index) => ({
      price: `1234567890123456789${level.price}`,
      quantity: index === 3 ? '0.000000000000000001'
        : index === 4 ? '12345678901234567890.123456789012345678' : level.quantity,
    })),
    bids: book.bids.map((level, index) => ({
      price: `1234567890123456789${level.price}`,
      quantity: index === 3 ? '0.000000000000000002'
        : index === 4 ? '23456789012345678901.234567890123456789' : level.quantity,
    })),
  };
}
