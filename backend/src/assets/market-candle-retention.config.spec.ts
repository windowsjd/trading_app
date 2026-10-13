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

  it('keeps the long-range 4h history 180 days by default, independent of 5m', () => {
    expect(
      readMarketCandleRetentionConfig({
        MARKET_CANDLE_5M_RETENTION_DAYS: '40',
      }),
    ).toMatchObject({ retentionDays: 40, fourHourRetentionDays: 180 });
    expect(
      readMarketCandleRetentionConfig({
        MARKET_CANDLE_4H_RETENTION_DAYS: '200',
      }).fourHourRetentionDays,
    ).toBe(200);
  });

  it.each([
    { MARKET_CANDLE_5M_RETENTION_DAYS: '30' },
    { MARKET_CANDLE_5M_RETENTION_DAYS: 'invalid' },
    { MARKET_CANDLE_RETENTION_BATCH_SIZE: '0' },
    { MARKET_CANDLE_RETENTION_BATCH_SIZE: '10001' },
    { MARKET_CANDLE_4H_RETENTION_DAYS: '149' },
    { MARKET_CANDLE_4H_RETENTION_DAYS: 'x' },
  ])('rejects unsafe config %#', (env) => {
    expect(() => readMarketCandleRetentionConfig(env)).toThrow(
      MarketCandleRetentionConfigError,
    );
  });
});
