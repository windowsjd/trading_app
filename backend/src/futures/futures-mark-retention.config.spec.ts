import { futuresMarkRetentionConfig } from './futures-mark-retention.config';
describe('Futures Mark retention configuration', () => {
  it('defaults to 24h bounded batches and follows Mark ingestion enable', () => {
    expect(futuresMarkRetentionConfig({})).toEqual({
      enabled: false,
      hours: 24,
      batchSize: 1000,
      maxBatches: 10,
      intervalMs: 60000,
    });
    expect(
      futuresMarkRetentionConfig({ FUTURES_MARK_INGESTION_ENABLED: 'true' })
        .enabled,
    ).toBe(true);
    expect(
      futuresMarkRetentionConfig({
        FUTURES_MARK_INGESTION_ENABLED: 'true',
        FUTURES_MARK_RETENTION_ENABLED: 'false',
      }).enabled,
    ).toBe(false);
  });
  it.each(['0', '-1', 'NaN', '1.5', '10001'])(
    'rejects unsafe batch bound %s',
    (value) => {
      expect(() =>
        futuresMarkRetentionConfig({
          FUTURES_MARK_RETENTION_BATCH_SIZE: value,
        }),
      ).toThrow();
    },
  );
  it.each(['0', '-24', 'NaN', '0.1', '8761'])(
    'rejects unsafe age bound %s',
    (value) => {
      expect(() =>
        futuresMarkRetentionConfig({ FUTURES_MARK_RETENTION_HOURS: value }),
      ).toThrow();
    },
  );
});
