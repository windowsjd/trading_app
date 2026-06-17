import { sanitizeOpsJson } from './ops-redaction';

describe('ops redaction', () => {
  it('redacts secret-like keys and connection strings recursively', () => {
    const sanitized = sanitizeOpsJson({
      ok: true,
      access_token: 'token-value',
      rawPayloadJson: {
        approval_key: 'approval-value',
        nested: {
          databaseUrl: 'postgresql://user:pass@localhost:5432/db',
        },
      },
      rows: [
        {
          providerPayload: {
            secret: 'secret-value',
          },
        },
      ],
    });

    expect(sanitized).toEqual({
      ok: true,
      access_token: '[REDACTED]',
      rawPayloadJson: '[REDACTED]',
      rows: [
        {
          providerPayload: '[REDACTED]',
        },
      ],
    });
  });
});
