import { sanitizeOpsJson } from './ops-redaction';

describe('ops redaction', () => {
  it('bounds nested/cyclic and oversized diagnostic results while retaining ordinary Ops financial facts', () => {
    const cyclic: Record<string, unknown> = {
      count: 3,
      totalAmount: '123.45678900',
    };
    cyclic.self = cyclic;
    expect(JSON.stringify(sanitizeOpsJson(cyclic))).toContain(
      '[TRUNCATED_DEPTH]',
    );
    expect(
      sanitizeOpsJson({ accountId: 'account-1', totalAmount: '123.45678900' }),
    ).toEqual({ accountId: 'account-1', totalAmount: '123.45678900' });
    expect(sanitizeOpsJson(Array(1000).fill('x'.repeat(2000)))).toEqual({
      truncated: true,
      reason: 'ops_result_size_limit',
    });
    expect(
      sanitizeOpsJson({
        error_message: 'SELECT wallet_balance 987654.12345678',
        ProviderErrorMessage: 'https://provider.invalid/body',
        message: 'Background operation failed.',
      }),
    ).toEqual({
      error_message: 'Background operation failed.',
      ProviderErrorMessage: 'Background operation failed.',
      message: 'Background operation failed.',
    });
  });
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
