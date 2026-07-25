import {
  type MarketHealthAssetLike,
  buildBinanceReadiness,
} from './market-readiness';

const asset = (
  over: Partial<MarketHealthAssetLike> = {},
): MarketHealthAssetLike => ({
  assetId: 'a-btc',
  symbol: 'BTCUSDT',
  assetType: 'crypto',
  market: 'BINANCE',
  state: 'available',
  reason: null,
  sourceName: 'binance_spot_ws_ticker',
  snapshotId: 'snap-1',
  capturedAt: '2026-07-25T00:00:00.000Z',
  freshnessAgeSeconds: 5,
  ...over,
});

const toProviderSymbol = (symbol: string) =>
  symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;

describe('buildBinanceReadiness', () => {
  it('reports only Binance crypto assets and marks all-available as ready', () => {
    const readiness = buildBinanceReadiness({
      assets: [
        asset(),
        asset({ assetId: 'a-eth', symbol: 'ETHUSDT' }),
        // Non-crypto / non-Binance assets are ignored.
        asset({
          assetId: 'a-aapl',
          symbol: 'AAPL',
          assetType: 'us_stock',
          market: 'NAS',
        }),
      ],
      binanceTargetSymbols: ['BTCUSDT', 'ETHUSDT'],
      toProviderSymbol,
    });
    expect(readiness.total).toBe(2);
    expect(readiness.available).toBe(2);
    expect(readiness.ready).toBe(true);
    expect(readiness.rows.every((row) => row.targetIncluded)).toBe(true);
    expect(readiness.rows.every((row) => row.snapshotPresent)).toBe(true);
  });

  it('is NOT ready when any Binance asset is unavailable and surfaces the reason', () => {
    const readiness = buildBinanceReadiness({
      assets: [
        asset(),
        asset({
          assetId: 'a-bnb',
          symbol: 'BNBUSDT',
          state: 'unavailable',
          reason: 'PROVIDER_MISSING',
          sourceName: null,
          snapshotId: null,
          capturedAt: null,
          freshnessAgeSeconds: null,
        }),
      ],
      binanceTargetSymbols: ['BTCUSDT', 'BNBUSDT'],
      toProviderSymbol,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.available).toBe(1);
    const bnb = readiness.rows.find((row) => row.symbol === 'BNBUSDT');
    expect(bnb).toMatchObject({
      snapshotPresent: false,
      reason: 'PROVIDER_MISSING',
      targetIncluded: true,
    });
  });

  it('flags a registered asset that is not in the resolved provider targets', () => {
    const readiness = buildBinanceReadiness({
      assets: [asset({ symbol: 'ZECUSDT', assetId: 'a-zec' })],
      binanceTargetSymbols: ['BTCUSDT'],
      toProviderSymbol,
    });
    expect(readiness.rows[0].targetIncluded).toBe(false);
  });

  it('is not ready when there are no Binance assets at all', () => {
    const readiness = buildBinanceReadiness({
      assets: [],
      binanceTargetSymbols: [],
      toProviderSymbol,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.total).toBe(0);
  });
});
