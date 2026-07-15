import {
  isCandleOperationalFallbackError,
  isDatabaseOperationalError,
} from './candle-operational-error';

function named(name: string, message = 'x', code?: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.name = name;
  if (code !== undefined) error.code = code;
  return error;
}

describe('candle operational error classification', () => {
  it('classifies database connectivity and timeout failures as operational', () => {
    expect(
      isDatabaseOperationalError(named('PrismaClientInitializationError')),
    ).toBe(true);
    expect(
      isDatabaseOperationalError(
        named('PrismaClientKnownRequestError', 'pool timeout', 'P2024'),
      ),
    ).toBe(true);
    expect(
      isDatabaseOperationalError(
        named('PrismaClientKnownRequestError', 'cannot connect', 'P1001'),
      ),
    ).toBe(true);
    expect(
      isDatabaseOperationalError(
        named('Error', 'connect ECONNREFUSED ::1:5432'),
      ),
    ).toBe(true);
    expect(isDatabaseOperationalError(named('Error', 'read ECONNRESET'))).toBe(
      true,
    );
    expect(
      isDatabaseOperationalError(
        named('Error', 'Connection terminated unexpectedly'),
      ),
    ).toBe(true);
    expect(
      isDatabaseOperationalError(
        named(
          'Error',
          'terminating connection due to administrator command',
          '57P01',
        ),
      ),
    ).toBe(true);
  });

  it('never classifies validation/config/programmer errors as operational', () => {
    expect(
      isDatabaseOperationalError(named('MarketCandleSyncInputError')),
    ).toBe(false);
    expect(isDatabaseOperationalError(named('ProviderConfigError'))).toBe(
      false,
    );
    expect(
      isDatabaseOperationalError(new TypeError('undefined is not a function')),
    ).toBe(false);
    expect(
      isDatabaseOperationalError(
        named('Error', 'interval must be 5m, 1d, or 1w.'),
      ),
    ).toBe(false);
    expect(
      isDatabaseOperationalError(
        named('PrismaClientKnownRequestError', 'unique violation', 'P2002'),
      ),
    ).toBe(false);
    expect(isDatabaseOperationalError(null)).toBe(false);
    expect(isDatabaseOperationalError('ECONNREFUSED')).toBe(false);
  });

  it('accepts Redis coordination failures and caller-listed operational names', () => {
    expect(
      isCandleOperationalFallbackError(named('RedisUnavailableError')),
    ).toBe(true);
    expect(
      isCandleOperationalFallbackError(
        named('CandleSingleFlightWaitTimeoutError'),
      ),
    ).toBe(true);
    expect(
      isCandleOperationalFallbackError(named('CandleOperationalRefreshError'), [
        'CandleOperationalRefreshError',
      ]),
    ).toBe(true);
    expect(
      isCandleOperationalFallbackError(named('CandleOperationalRefreshError')),
    ).toBe(false);
  });
});
