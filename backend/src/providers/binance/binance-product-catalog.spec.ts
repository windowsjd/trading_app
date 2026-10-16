import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BINANCE_FIXED_SYMBOLS } from './binance-fixed-asset-universe';
import selection100 from '../../../artifacts/binance-crypto-100-2026/selection.json';
import {
  BINANCE_FUTURES_SYMBOLS,
  BINANCE_FUTURES_ONLY_ASSETS,
  BINANCE_FUTURES_ONLY_SYMBOLS,
  isOfferedFuturesSymbol,
  isFuturesOnlyAsset,
  FUTURES_DISPLAY_DECIMALS,
} from './binance-product-catalog';
import {
  parseFuturesContracts,
  verifiedFuturesInstrument,
} from '../../futures/futures-instrument-coverage';
import { presentFuturesInstrument } from '../../futures/futures.presenter';

const at = new Date('2026-10-11T00:00:00Z');
function row(symbol: string, tickSize?: string) {
  return {
    symbol,
    pair: symbol,
    baseAsset: symbol.slice(0, -4),
    contractType: 'PERPETUAL',
    status: 'TRADING',
    quoteAsset: 'USDT',
    marginAsset: 'USDT',
    underlyingType: 'COIN',
    ...(tickSize
      ? { filters: [{ filterType: 'PRICE_FILTER', tickSize }] }
      : {}),
  };
}
function instrument(symbol: string, tickSize?: string) {
  return {
    id: `i-${symbol}`,
    underlyingAssetId: symbol,
    isActive: true,
    productType: 'synthetic_perpetual',
    settlementCurrency: 'USD',
    markVerifiedAt: at,
    markContractJson: parseFuturesContracts({
      symbols: [row(symbol, tickSize)],
    }).get(symbol),
    underlyingAsset: {
      id: symbol,
      symbol,
      name: symbol,
      isActive: true,
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
  } as never;
}
describe('approved separate Binance products', () => {
  it('keeps the 25 CSV identities in selection order and appends the 75 researched contracts', () => {
    const csv = readFileSync(
      resolve(
        process.cwd(),
        '../docs/investigations/2026-10-11-binance-futures-ytd/evidence/top25-conditional-new-underlying.csv',
      ),
      'utf8',
    );
    const symbols = csv
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(',')[2].replaceAll('"', ''));
    expect(BINANCE_FUTURES_SYMBOLS.slice(0, 25)).toEqual(symbols);
    expect(selection100.futures.existing).toEqual(symbols);
    expect(BINANCE_FUTURES_SYMBOLS.slice(25)).toEqual(
      selection100.futures.added.map((row) => row.symbol),
    );
    expect(BINANCE_FUTURES_SYMBOLS).toEqual(selection100.futures.final);
    expect(new Set(BINANCE_FUTURES_SYMBOLS).size).toBe(100);
    expect(BINANCE_FIXED_SYMBOLS.length).toBe(100);
  });
  it('derives the Futures-only underlyings from the two catalogs and names every one', () => {
    const researched = selection100.futures.futuresOnlyUnderlyings;
    expect(BINANCE_FUTURES_ONLY_SYMBOLS).toEqual(
      researched.map((row) => row.symbol),
    );
    expect(BINANCE_FUTURES_ONLY_ASSETS).toEqual(
      researched.map(({ symbol, name }) => ({ symbol, name })),
    );
    expect(BINANCE_FUTURES_ONLY_SYMBOLS.length).toBe(21);
    expect(
      BINANCE_FUTURES_ONLY_SYMBOLS.some((s) =>
        BINANCE_FIXED_SYMBOLS.includes(s),
      ),
    ).toBe(false);
    // Former Futures-only underlyings the Spot ranking selected are Spot now.
    for (const symbol of ['PUMPUSDT', 'BCHUSDT', 'FILUSDT', 'AAVEUSDT']) {
      expect(BINANCE_FIXED_SYMBOLS.includes(symbol)).toBe(true);
      expect(
        isFuturesOnlyAsset({ symbol, market: 'BINANCE', assetType: 'crypto' }),
      ).toBe(false);
    }
  });
  it('declares the researched FAPI display precision for every offered contract', () => {
    expect(FUTURES_DISPLAY_DECIMALS).toEqual(
      selection100.futures.displayPriceDecimals,
    );
  });
  it.each(BINANCE_FUTURES_ONLY_SYMBOLS)(
    '%s is operationally valid for Futures, excluded only from Spot',
    (symbol) => {
      const i = instrument(symbol);
      expect(verifiedFuturesInstrument(i, at)).toBe(true);
      expect(
        isFuturesOnlyAsset({ symbol, market: 'BINANCE', assetType: 'crypto' }),
      ).toBe(true);
      expect(
        isFuturesOnlyAsset({ symbol, market: 'NYSE', assetType: 'us_stock' }),
      ).toBe(false);
      expect(presentFuturesInstrument(i).underlying.displayPriceDecimals).toBe(
        FUTURES_DISPLAY_DECIMALS[symbol],
      );
    },
  );
  it('rejects unoffered, alias and multiplier contracts for entry without narrowing the coverage parser', () => {
    expect(verifiedFuturesInstrument(instrument('BICOUSDT'), at)).toBe(false);
    expect(
      parseFuturesContracts({ symbols: [row('BICOUSDT')] }).has('BICOUSDT'),
    ).toBe(true);
    expect(isOfferedFuturesSymbol('HYPE')).toBe(false);
    expect(isOfferedFuturesSymbol('1000PEPEUSDT')).toBe(false);
    expect(
      parseFuturesContracts({
        symbols: [{ ...row('HYPEUSDT'), baseAsset: 'PUMP' }],
      }).size,
    ).toBe(0);
  });
  it('uses FAPI tick precision and retains eight-decimal financial amounts', () => {
    expect(
      presentFuturesInstrument(instrument('BTCUSDT')).underlying
        .displayPriceDecimals,
    ).toBe(1);
    expect(
      presentFuturesInstrument(instrument('PUMPUSDT', '0.00000010')).underlying
        .displayPriceDecimals,
    ).toBe(7);
    expect(
      presentFuturesInstrument(instrument('PUMPUSDT', '0')).underlying
        .displayPriceDecimals,
    ).toBe(6);
  });
});
