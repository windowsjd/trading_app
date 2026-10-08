import { createApiError } from './api-error';
import { safePublicErrorMessage } from './public-error-message';
import { safeDiagnosticMessage } from './safe-diagnostic-message';

describe('public product copy is separate from diagnostic copy', () => {
  it.each([
    'Limit order cancel service is not wired.',
    'Limit order create service is not wired.',
    'Participant has no trading account link; run trading-accounts:repair-links.',
    'Trading account access service unavailable',
    'General account performance service unavailable',
    'Portfolio valuation service unavailable',
    'Database transaction clock is unavailable.',
    'binance HTTP 503 (PROVIDER_HTTP_ERROR).',
  ])('does not publish diagnostic-only fixed text: %s', (message) => {
    expect(safeDiagnosticMessage(message)).toBe(message);
    expect(safePublicErrorMessage(message)).toBeUndefined();
    expect(
      createApiError('NEW_DOMAIN_CODE', message, 503).getResponse(),
    ).toEqual({
      success: false,
      error: {
        code: 'NEW_DOMAIN_CODE',
        message: 'Request could not be completed.',
      },
    });
  });

  it.each([
    'Futures trading is disabled.',
    'Only risk-reducing Futures trades are enabled.',
    'Cash wallet balance is insufficient.',
    'Available position quantity is insufficient.',
    'Leverage must be an integer from 1 through 100.',
    'Price is stale.',
  ])('preserves reviewed product copy independently of code: %s', (message) => {
    expect(
      createApiError('UNREGISTERED_CODE', message, 409).getResponse(),
    ).toMatchObject({ error: { message } });
  });

  it('does not approve unknown copy just because it lacks technical keywords', () => {
    for (const message of [
      'private marker 987654.12345678',
      'Futures trading is disabled. extra private text',
    ]) {
      expect(
        createApiError('FUTURES_TRADING_DISABLED', message, 409).getResponse(),
      ).toMatchObject({
        error: { message: 'Request could not be completed.' },
      });
    }
    expect(
      safePublicErrorMessage({ message: 'Price is stale.' }),
    ).toBeUndefined();
  });
});
