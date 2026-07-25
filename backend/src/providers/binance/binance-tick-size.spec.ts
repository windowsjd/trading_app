import {
  parseTickSizeDisplayDecimals,
  readBinanceSymbolPricePrecision,
  readPriceFilterTickSize,
} from './binance-tick-size';
import { BINANCE_FIXED_ASSET_UNIVERSE } from './binance-fixed-asset-universe';

describe('parseTickSizeDisplayDecimals', () => {
  it('maps Binance tick sizes to display decimals', () => {
    expect(parseTickSizeDisplayDecimals('0.01000000')).toBe(2);
    expect(parseTickSizeDisplayDecimals('0.00100000')).toBe(3);
    expect(parseTickSizeDisplayDecimals('0.00010000')).toBe(4);
    expect(parseTickSizeDisplayDecimals('0.00001000')).toBe(5);
    expect(parseTickSizeDisplayDecimals('1.00000000')).toBe(0);
    expect(parseTickSizeDisplayDecimals('0.5')).toBe(1);
  });

  it('rejects malformed tick sizes instead of guessing', () => {
    expect(parseTickSizeDisplayDecimals(undefined)).toBeNull();
    expect(parseTickSizeDisplayDecimals(null)).toBeNull();
    expect(parseTickSizeDisplayDecimals('')).toBeNull();
    expect(parseTickSizeDisplayDecimals('   ')).toBeNull();
    expect(parseTickSizeDisplayDecimals('abc')).toBeNull();
    expect(parseTickSizeDisplayDecimals('-0.01')).toBeNull();
    expect(parseTickSizeDisplayDecimals('1e-5')).toBeNull();
    expect(parseTickSizeDisplayDecimals('0.00000000')).toBeNull();
    expect(parseTickSizeDisplayDecimals(0.01 as unknown as string)).toBeNull();
  });

  it('does not lose precision through a float round-trip', () => {
    // Number('0.00000010') stringifies as '1e-7'; the string path keeps 7.
    expect(parseTickSizeDisplayDecimals('0.00000010')).toBe(7);
  });
});

describe('readPriceFilterTickSize', () => {
  it('finds PRICE_FILTER among other filter types', () => {
    expect(
      readPriceFilterTickSize({
        symbol: 'DOGEUSDT',
        filters: [
          { filterType: 'LOT_SIZE', stepSize: '1.00000000' },
          { filterType: 'PRICE_FILTER', tickSize: '0.00001000' },
          { filterType: 'NOTIONAL', minNotional: '5' },
        ],
      }),
    ).toBe('0.00001000');
  });

  it('returns null when the filter or the field is missing', () => {
    expect(readPriceFilterTickSize({ symbol: 'X', filters: [] })).toBeNull();
    expect(readPriceFilterTickSize({ symbol: 'X' })).toBeNull();
    expect(readPriceFilterTickSize(null)).toBeNull();
    expect(
      readPriceFilterTickSize({
        symbol: 'X',
        filters: [{ filterType: 'PRICE_FILTER', tickSize: 0.01 }],
      }),
    ).toBeNull();
  });
});

describe('readBinanceSymbolPricePrecision', () => {
  it('extracts every valid symbol and drops malformed entries', () => {
    const precisions = readBinanceSymbolPricePrecision({
      symbols: [
        {
          symbol: 'BTCUSDT',
          filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01000000' }],
        },
        {
          symbol: 'DOGEUSDT',
          filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.00001000' }],
        },
        { symbol: 'BROKENUSDT', filters: [] },
        { filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01000000' }] },
        null,
      ],
    });

    expect(precisions).toEqual([
      {
        symbol: 'BTCUSDT',
        priceTickSize: '0.01000000',
        displayPriceDecimals: 2,
      },
      {
        symbol: 'DOGEUSDT',
        priceTickSize: '0.00001000',
        displayPriceDecimals: 5,
      },
    ]);
  });

  it('returns an empty list for a non-exchangeInfo payload', () => {
    expect(readBinanceSymbolPricePrecision(null)).toEqual([]);
    expect(readBinanceSymbolPricePrecision({})).toEqual([]);
    expect(readBinanceSymbolPricePrecision({ symbols: 'nope' })).toEqual([]);
  });
});

describe('fixed universe fallback precision', () => {
  it('declares a self-consistent tickSize/decimals pair for all 10 symbols', () => {
    expect(BINANCE_FIXED_ASSET_UNIVERSE).toHaveLength(10);
    for (const entry of BINANCE_FIXED_ASSET_UNIVERSE) {
      expect(parseTickSizeDisplayDecimals(entry.priceTickSize)).toBe(
        entry.displayPriceDecimals,
      );
    }
  });

  it('keeps low-priced coins above 2 decimals', () => {
    const bySymbol = new Map(
      BINANCE_FIXED_ASSET_UNIVERSE.map((entry) => [
        entry.symbol,
        entry.displayPriceDecimals,
      ]),
    );
    expect(bySymbol.get('BTCUSDT')).toBe(2);
    expect(bySymbol.get('XRPUSDT')).toBe(4);
    expect(bySymbol.get('TRXUSDT')).toBe(4);
    expect(bySymbol.get('XLMUSDT')).toBe(4);
    expect(bySymbol.get('LINKUSDT')).toBe(3);
    expect(bySymbol.get('DOGEUSDT')).toBe(5);
  });
});
