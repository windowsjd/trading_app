import {
  DEFAULT_GENERAL_TRADE_FEE_RATE,
  GeneralTradingConfigError,
  parseGeneralTradeFeeRate,
  readGeneralTradeFeeRate,
} from './general-trading.config';

describe('general trading fee config', () => {
  it('uses the one independent default and never needs a season', () => {
    expect(readGeneralTradeFeeRate({})).toEqual(
      parseGeneralTradeFeeRate(DEFAULT_GENERAL_TRADE_FEE_RATE),
    );
    expect(readGeneralTradeFeeRate({}).toFixed(6)).toBe('0.001000');
  });

  it.each(['0', '0.000001', '0.001000', '0.5', '1', '1.000000'])(
    'accepts %s',
    (value) => {
      expect(parseGeneralTradeFeeRate(value).toFixed(6)).toBe(
        Number(value).toFixed(6),
      );
    },
  );

  it.each(['', '-0.1', '1.000001', '0.1234567', 'NaN', '  '])(
    'rejects %j',
    (value) => {
      expect(() => parseGeneralTradeFeeRate(value)).toThrow(
        GeneralTradingConfigError,
      );
    },
  );
});
