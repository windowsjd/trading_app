import {
  type BinanceExchangeInfoResponse,
  hasSpotPermission,
  validateBinanceSpotUniverse,
} from './binance-exchange-info.validation';

const expected = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC' },
  { symbol: 'ETHUSDT', baseAsset: 'ETH' },
];

const tradingSpot = (over: Record<string, unknown> = {}) => ({
  symbol: 'BTCUSDT',
  status: 'TRADING',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  isSpotTradingAllowed: true,
  ...over,
});

describe('validateBinanceSpotUniverse', () => {
  it('passes when every symbol is TRADING Spot USDT with matching base asset', () => {
    const response: BinanceExchangeInfoResponse = {
      symbols: [
        tradingSpot(),
        tradingSpot({ symbol: 'ETHUSDT', baseAsset: 'ETH' }),
        tradingSpot({ symbol: 'NOISEUSDT', baseAsset: 'NOISE' }),
      ],
    };
    const result = validateBinanceSpotUniverse(expected, response);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('accepts SPOT via permissionSets when isSpotTradingAllowed is absent', () => {
    const response: BinanceExchangeInfoResponse = {
      symbols: [
        tradingSpot({
          isSpotTradingAllowed: undefined,
          permissionSets: [['SPOT', 'MARGIN']],
        }),
        tradingSpot({
          symbol: 'ETHUSDT',
          baseAsset: 'ETH',
          isSpotTradingAllowed: undefined,
          permissions: ['SPOT'],
        }),
      ],
    };
    expect(validateBinanceSpotUniverse(expected, response).ok).toBe(true);
  });

  it('fails (no partial pass) and reports each problem', () => {
    const response: BinanceExchangeInfoResponse = {
      symbols: [
        tradingSpot({ status: 'BREAK' }), // BTC not trading
        // ETH missing entirely
      ],
    };
    const result = validateBinanceSpotUniverse(expected, response);
    expect(result.ok).toBe(false);
    const bySymbol = Object.fromEntries(
      result.failures.map((f) => [f.symbol, f.reason]),
    );
    expect(bySymbol.BTCUSDT).toBe('STATUS_NOT_TRADING');
    expect(bySymbol.ETHUSDT).toBe('SYMBOL_NOT_FOUND');
  });

  it('rejects a non-USDT quote asset', () => {
    const response: BinanceExchangeInfoResponse = {
      symbols: [
        tradingSpot({ quoteAsset: 'USDC' }),
        tradingSpot({ symbol: 'ETHUSDT', baseAsset: 'ETH' }),
      ],
    };
    const result = validateBinanceSpotUniverse(expected, response);
    expect(result.failures.find((f) => f.symbol === 'BTCUSDT')?.reason).toBe(
      'QUOTE_ASSET_NOT_USDT',
    );
  });

  it('rejects a base-asset mismatch (guards a wrong pair sneaking in)', () => {
    const response: BinanceExchangeInfoResponse = {
      symbols: [
        tradingSpot({ baseAsset: 'WBTC' }),
        tradingSpot({ symbol: 'ETHUSDT', baseAsset: 'ETH' }),
      ],
    };
    const result = validateBinanceSpotUniverse(expected, response);
    expect(result.failures.find((f) => f.symbol === 'BTCUSDT')?.reason).toBe(
      'BASE_ASSET_MISMATCH',
    );
  });

  it('rejects a symbol without Spot permission', () => {
    const response: BinanceExchangeInfoResponse = {
      symbols: [
        tradingSpot({
          isSpotTradingAllowed: false,
          permissions: ['MARGIN'],
          permissionSets: [['MARGIN']],
        }),
        tradingSpot({ symbol: 'ETHUSDT', baseAsset: 'ETH' }),
      ],
    };
    const result = validateBinanceSpotUniverse(expected, response);
    expect(result.failures.find((f) => f.symbol === 'BTCUSDT')?.reason).toBe(
      'SPOT_NOT_PERMITTED',
    );
  });

  it('treats a malformed response (no symbols array) as all-not-found, never a pass', () => {
    const result = validateBinanceSpotUniverse(
      expected,
      {} as BinanceExchangeInfoResponse,
    );
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.reason)).toEqual([
      'SYMBOL_NOT_FOUND',
      'SYMBOL_NOT_FOUND',
    ]);
  });
});

describe('hasSpotPermission', () => {
  it('is true for isSpotTradingAllowed, permissions, or permissionSets', () => {
    expect(hasSpotPermission({ isSpotTradingAllowed: true })).toBe(true);
    expect(hasSpotPermission({ permissions: ['SPOT'] })).toBe(true);
    expect(
      hasSpotPermission({ permissionSets: [['LEVERAGED'], ['SPOT']] }),
    ).toBe(true);
  });

  it('is false when Spot appears nowhere', () => {
    expect(
      hasSpotPermission({
        isSpotTradingAllowed: false,
        permissions: ['MARGIN'],
      }),
    ).toBe(false);
    expect(hasSpotPermission({})).toBe(false);
  });
});
