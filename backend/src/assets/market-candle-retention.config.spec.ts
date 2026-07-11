import {
  MarketCandleRetentionConfigError,
  readMarketCandleRetentionConfig,
} from './market-candle-retention.config';

describe('market candle retention config', () => {
  it('defaults to 35 days and 5000 rows per batch', () => {
    expect(readMarketCandleRetentionConfig({})).toMatchObject({
      retentionDays: 35,
      batchSize: 5000,
    });
  });

  it.each([
    { MARKET_CANDLE_5M_RETENTION_DAYS: '30' },
    { MARKET_CANDLE_5M_RETENTION_DAYS: 'invalid' },
    { MARKET_CANDLE_RETENTION_BATCH_SIZE: '0' },
    { MARKET_CANDLE_RETENTION_BATCH_SIZE: '10001' },
  ])('rejects unsafe config %#', (env) => {
    expect(() => readMarketCandleRetentionConfig(env)).toThrow(
      MarketCandleRetentionConfigError,
    );
  });
});
