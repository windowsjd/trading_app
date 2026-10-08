import {
  isSecretKey,
  isSensitiveDiagnosticKey,
  redactSensitiveText,
} from './sensitive-data';
import { sanitizeOpsJson, sanitizeOpsFailureJson } from '../ops/ops-redaction';
import { redactJsonValue } from '../providers/provider-secret-redaction';

const variants = (words: string[]) => [
  words.join('_'),
  words.join('-'),
  words.join('.'),
  words.join(' '),
  words
    .map((word, index) =>
      index ? word[0].toUpperCase() + word.slice(1) : word,
    )
    .join(''),
  words.map((word) => word[0].toUpperCase() + word.slice(1)).join(''),
];

describe('shared sensitive data policy', () => {
  it('does not claim arbitrary URLs, SQL or financial values are secret assignments', () => {
    const unprojected =
      'https://provider.invalid/private SELECT wallet_balance FROM private_wallet balance 987654.12345678';
    expect(redactSensitiveText(unprojected)).toBe(unprojected);
    expect(
      sanitizeOpsFailureJson({
        amount: '987654.12345678',
        message: unprojected,
      }),
    ).toEqual({
      amount: '987654.12345678',
      message: 'Background operation failed.',
    });
    // Redaction does not detect arbitrary technical prose/amounts. The Ops
    // failure projection excludes the prose; permitted numeric Ops data stays.
    expect(
      sanitizeOpsJson({
        message: 'normal operational message',
        amount: '987654.12345678',
      }),
    ).toEqual({
      message: 'normal operational message',
      amount: '987654.12345678',
    });
  });
  it.each([
    ['private', 'key'],
    ['database', 'url'],
    ['api', 'key'],
    ['refresh', 'token'],
    ['kis', 'app', 'secret'],
    ['korea', 'exim', 'auth', 'key'],
    ['exchange', 'rate', 'api', 'key'],
    ['provider', 'credential'],
  ])(
    'normalizes credential words %j across all supported representations',
    (...words: string[]) => {
      for (const key of variants(words)) {
        expect(isSecretKey(key)).toBe(true);
        expect(sanitizeOpsJson({ [key]: 'synthetic-secret' })).toEqual({
          [key]: '[REDACTED]',
        });
        expect(redactJsonValue({ [key]: 'synthetic-secret' })).toEqual({
          [key]: '[REDACTED]',
        });
        expect(
          redactSensitiveText(
            JSON.stringify({ [key]: 'synthetic-secret', status: 503 }),
          ),
        ).not.toContain('synthetic-secret');
        expect(redactSensitiveText(`${key}=synthetic-secret`)).not.toContain(
          'synthetic-secret',
        );
        expect(
          redactSensitiveText(
            JSON.stringify({
              message: JSON.stringify({ [key]: 'synthetic-secret' }),
            }),
          ),
        ).not.toContain('synthetic-secret');
      }
    },
  );

  it.each([
    ['raw', 'payload'],
    ['provider', 'payload'],
    ['raw', 'response', 'body'],
  ])(
    'blocks payload words %j without changing normal provider business JSON',
    (...words: string[]) => {
      for (const key of variants(words)) {
        expect(isSensitiveDiagnosticKey(key)).toBe(true);
        expect(isSecretKey(key)).toBe(false);
        expect(sanitizeOpsJson({ [key]: { data: 'synthetic-body' } })).toEqual({
          [key]: '[REDACTED]',
        });
        expect(
          redactSensitiveText(
            JSON.stringify({ [key]: { data: 'synthetic-body' } }),
          ),
        ).toBe('[REDACTED]');
      }
      expect(redactJsonValue({ price: '123.45', volume: '42' })).toEqual({
        price: '123.45',
        volume: '42',
      });
    },
  );

  it.each([
    'code=FAILED apiKey=synthetic-secret retry=1',
    '{"apiKey":"synthetic-secret","refreshToken":"synthetic-secret"}',
    "request failed authorization='Bearer synthetic-secret'",
    '{"secret":"synthetic-secret with spaces and \\"escape\\""}',
    'Bearer synthetic-secret',
    'Authorization: Basic synthetic-secret',
    '{"credential":["synthetic-secret","second-secret"]}',
    'postgresql://fake:synthetic-secret@example.test/db',
    '-----BEGIN PRIVATE KEY-----\nsynthetic-secret\n-----END PRIVATE KEY-----',
  ])('redacts secrets in free-form text: %s', (value) => {
    expect(redactSensitiveText(value)).not.toContain('synthetic-secret');
  });

  it('preserves safe prose and business keys', () => {
    const safe =
      'provider=kis status=503 stale threshold=300 capturedAt age=1842 retry=1';
    expect(redactSensitiveText(safe)).toBe(safe);
    const nestedSafe = JSON.stringify({
      message: JSON.stringify({ provider: 'kis', status: 503 }),
    });
    expect(redactSensitiveText(nestedSafe)).toBe(nestedSafe);
    for (const key of [
      'idempotencyKey',
      'lockKey',
      'subscriptionKey',
      'cacheKey',
      'quoteId',
      'capturedAt',
      'sourceName',
    ]) {
      expect(isSensitiveDiagnosticKey(key)).toBe(false);
      expect(redactSensitiveText(JSON.stringify({ [key]: 'safe-value' }))).toBe(
        JSON.stringify({ [key]: 'safe-value' }),
      );
    }
  });
});
