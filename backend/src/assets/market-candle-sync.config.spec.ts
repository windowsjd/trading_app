import {
  MarketCandleSyncConfigError,
  readMarketCandleSyncConfig,
} from './market-candle-sync.config';

describe('readMarketCandleSyncConfig', () => {
  it('returns bounded defaults with an empty environment', () => {
    expect(readMarketCandleSyncConfig({})).toEqual({
      maxPages: 300,
      maxRows: 50_000,
      maxDurationMs: 180_000,
      assetConcurrency: 2,
      incrementalOverlapMinutes: 120,
      lockTtlSeconds: 120,
      lockRenewSeconds: 40,
    });
  });

  it('reads explicit values', () => {
    expect(
      readMarketCandleSyncConfig({
        MARKET_CANDLE_SYNC_MAX_PAGES: '50',
        MARKET_CANDLE_SYNC_MAX_ROWS: '1000',
        MARKET_CANDLE_SYNC_MAX_DURATION_MS: '60000',
        MARKET_CANDLE_SYNC_ASSET_CONCURRENCY: '1',
        MARKET_CANDLE_SYNC_INCREMENTAL_OVERLAP_MINUTES: '30',
        MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS: '60',
        MARKET_CANDLE_SYNC_LOCK_RENEW_SECONDS: '20',
      }),
    ).toMatchObject({
      maxPages: 50,
      maxRows: 1000,
      maxDurationMs: 60_000,
      assetConcurrency: 1,
      incrementalOverlapMinutes: 30,
      lockTtlSeconds: 60,
      lockRenewSeconds: 20,
    });
  });

  it.each([
    ['MARKET_CANDLE_SYNC_MAX_PAGES', 'abc'],
    ['MARKET_CANDLE_SYNC_MAX_PAGES', '0'],
    ['MARKET_CANDLE_SYNC_MAX_PAGES', '999999'],
    ['MARKET_CANDLE_SYNC_MAX_ROWS', '-1'],
    ['MARKET_CANDLE_SYNC_MAX_DURATION_MS', '10'],
    ['MARKET_CANDLE_SYNC_ASSET_CONCURRENCY', '99'],
    ['MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS', '2'],
    ['MARKET_CANDLE_SYNC_LOCK_RENEW_SECONDS', '1.5'],
  ])('throws a config error for invalid %s=%s', (name, value) => {
    expect(() => readMarketCandleSyncConfig({ [name]: value })).toThrow(
      MarketCandleSyncConfigError,
    );
  });

  it('requires the renew interval to stay below the lock TTL', () => {
    expect(() =>
      readMarketCandleSyncConfig({
        MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS: '30',
        MARKET_CANDLE_SYNC_LOCK_RENEW_SECONDS: '30',
      }),
    ).toThrow(MarketCandleSyncConfigError);
  });
});
