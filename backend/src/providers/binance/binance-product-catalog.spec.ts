import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BINANCE_FIXED_SYMBOLS } from './binance-fixed-asset-universe';
import {
  BINANCE_FUTURES_SYMBOLS,
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
  it('matches all 25 CSV identities in selection order without changing the Spot 25', () => {
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
    expect(BINANCE_FUTURES_SYMBOLS).toEqual(symbols);
    expect(new Set(symbols).size).toBe(25);
    expect(BINANCE_FIXED_SYMBOLS.length).toBe(25);
    expect(BINANCE_FUTURES_ONLY_SYMBOLS).toEqual([
      'HYPEUSDT',
      'PUMPUSDT',
      'BCHUSDT',
      'FILUSDT',
      'AAVEUSDT',
    ]);
    expect(
      BINANCE_FUTURES_ONLY_SYMBOLS.some((s) =>
        BINANCE_FIXED_SYMBOLS.includes(s),
      ),
    ).toBe(false);
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
    expect(verifiedFuturesInstrument(instrument('DOTUSDT'), at)).toBe(false);
    expect(
      parseFuturesContracts({ symbols: [row('DOTUSDT')] }).has('DOTUSDT'),
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
