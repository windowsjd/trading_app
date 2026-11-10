import {
  readUsExtendedHoursConfig,
  usExtendedHoursLimitMatchingEnabled,
  usExtendedHoursPriceEnabled,
} from './us-extended-hours.config';
import { validateEnv } from '../common/env-validation';

const env = (values: Record<string, string>) =>
  values as unknown as NodeJS.ProcessEnv;
const tiingo = { US_STOCK_PRICE_PROVIDER: 'tiingo' };

describe('US extended-hours switches', () => {
  it('are both off by default', () => {
    expect(readUsExtendedHoursConfig(env({}))).toEqual({
      priceEnabled: false,
      limitMatchingEnabled: false,
    });
    expect(usExtendedHoursPriceEnabled(env({}))).toBe(false);
    expect(usExtendedHoursLimitMatchingEnabled(env({}))).toBe(false);
  });

  it('parse strictly and never read a typo as off', () => {
    expect(
      readUsExtendedHoursConfig(
        env({ ...tiingo, US_STOCK_EXTENDED_HOURS_PRICE_ENABLED: ' TRUE ' }),
      ).priceEnabled,
    ).toBe(true);
    expect(
      readUsExtendedHoursConfig(
        env({ US_STOCK_EXTENDED_HOURS_PRICE_ENABLED: '0' }),
      ).priceEnabled,
    ).toBe(false);
    for (const value of ['yes', 'on', ''])
      expect(() =>
        readUsExtendedHoursConfig(
          env({ US_STOCK_EXTENDED_HOURS_PRICE_ENABLED: value }),
        ),
      ).toThrow('US_STOCK_EXTENDED_HOURS_PRICE_ENABLED must be one of');
  });

  it('require the Tiingo provider for prices and prices for limit fills', () => {
    expect(() =>
      readUsExtendedHoursConfig(
        env({ US_STOCK_EXTENDED_HOURS_PRICE_ENABLED: 'true' }),
      ),
    ).toThrow('requires US_STOCK_PRICE_PROVIDER=tiingo');
    expect(() =>
      readUsExtendedHoursConfig(
        env({
          ...tiingo,
          US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED: 'true',
        }),
      ),
    ).toThrow('requires US_STOCK_EXTENDED_HOURS_PRICE_ENABLED=true');
    expect(
      usExtendedHoursLimitMatchingEnabled(
        env({
          ...tiingo,
          US_STOCK_EXTENDED_HOURS_PRICE_ENABLED: 'true',
          US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED: 'true',
        }),
      ),
    ).toBe(true);
  });

  it('refuse to boot on an invalid combination and warn when the matcher is off', () => {
    const tiingoOfficial = {
      ...tiingo,
      TIINGO_ENABLED: 'true',
      TIINGO_TRIAL_MODE: 'false',
      TIINGO_API_TOKEN: 'test-token',
    };
    expect(() =>
      validateEnv({ US_STOCK_EXTENDED_HOURS_PRICE_ENABLED: 'true' }),
    ).toThrow('requires US_STOCK_PRICE_PROVIDER=tiingo');
    expect(() =>
      validateEnv({
        ...tiingoOfficial,
        US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED: 'true',
      }),
    ).toThrow('requires US_STOCK_EXTENDED_HOURS_PRICE_ENABLED=true');
    expect(() =>
      validateEnv({ US_STOCK_EXTENDED_HOURS_PRICE_ENABLED: 'maybe' }),
    ).toThrow('US_STOCK_EXTENDED_HOURS_PRICE_ENABLED must be one of');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() =>
        validateEnv({
          ...tiingoOfficial,
          US_STOCK_EXTENDED_HOURS_PRICE_ENABLED: 'true',
          US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED: 'true',
        }),
      ).not.toThrow();
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes('us_extended_hours_limit_matching_inert'),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
