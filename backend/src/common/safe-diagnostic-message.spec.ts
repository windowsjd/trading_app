import { safeDiagnosticMessage } from './safe-diagnostic-message';

describe('reviewed diagnostic message policy', () => {
  it('keeps safe domain meaning and finite Provider classification', () => {
    for (const message of [
      'Futures trading is disabled.',
      'Background operation failed.',
      'binance HTTP 503 (PROVIDER_HTTP_ERROR).',
    ]) {
      expect(safeDiagnosticMessage(message)).toBe(message);
    }
  });
  it.each([
    'NEW_SYNTHETIC_ERROR raw-private-text',
    'Futures trading is disabled. token=fake-token',
    'binance HTTP 503 (PROVIDER_HTTP_ERROR). https://provider.invalid/body',
    'SELECT wallet_balance postgres://fake:fake@db.invalid/db 987654.12345678',
    '{"nested":{"secret":"fake-secret"}}',
  ])('does not approve arbitrary text or a familiar prefix: %s', (message) => {
    expect(safeDiagnosticMessage(message)).toBeUndefined();
  });
});
