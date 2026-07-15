import {
  CandleServingConfigError,
  readCandleServingConfig,
} from './candle-serving.config';

describe('readCandleServingConfig', () => {
  it('defaults rollout to legacy', () => {
    expect(readCandleServingConfig({}).mode).toBe('legacy');
  });

  it('accepts database and rejects unknown modes', () => {
    expect(
      readCandleServingConfig({ CANDLE_SERVING_MODE: 'database' }).mode,
    ).toBe('database');
    expect(() =>
      readCandleServingConfig({ CANDLE_SERVING_MODE: 'typo' }),
    ).toThrow(CandleServingConfigError);
  });
});
