import {
  DEFAULT_GENERAL_FX_FEE_RATE,
  GeneralFxConfigError,
  parseGeneralFxFeeRate,
  readGeneralFxFeeRate,
} from './general-fx.config';

describe('general FX fee config', () => {
  it('uses the independent 0.1% product default', () => {
    expect(readGeneralFxFeeRate({}).toFixed(6)).toBe(
      DEFAULT_GENERAL_FX_FEE_RATE,
    );
  });

  it.each(['0', '0.000001', '0.001000', '0.5', '1', '1.000000'])(
    'accepts %s',
    (value) => {
      expect(parseGeneralFxFeeRate(value).toFixed(6)).toBe(
        Number(value).toFixed(6),
      );
    },
  );

  it.each(['', '-0.1', '1.000001', '0.1234567', 'NaN', '  '])(
    'rejects %j',
    (value) => {
      expect(() => parseGeneralFxFeeRate(value)).toThrow(GeneralFxConfigError);
    },
  );
});
