import { sanitizeOpsJson, sanitizeOpsFailureJson } from './ops-redaction';

describe('ops redaction', () => {
  it('separates normal metadata messages from explicit failure messages', () => {
    const raw =
      'SELECT private_wallet https://provider.invalid/body 987654.12345678';
    expect(
      sanitizeOpsJson({
        message: 'normal operational message',
        dryRunMessage: 'Would run when dryRun is false.',
        failure: { message: raw },
        errors: [{ message: raw }],
      }),
    ).toEqual({
      message: 'normal operational message',
      dryRunMessage: 'Would run when dryRun is false.',
      failure: { message: 'Background operation failed.' },
      errors: [{ message: 'Background operation failed.' }],
    });
    expect(
      sanitizeOpsFailureJson({
        message: raw,
        count: 3,
        totalAmount: '123.45678900',
      }),
    ).toEqual({
      message: 'Background operation failed.',
      count: 3,
      totalAmount: '123.45678900',
    });
    expect(sanitizeOpsFailureJson(raw)).toBe('Background operation failed.');
  });
  it('retains secret and payload redaction for ordinary success messages', () => {
    const projected = sanitizeOpsJson({
      message: 'postgresql://user:private@db.invalid/db',
      notice: 'Bearer fake-token',
      dryRunMessage: 'preview token=fake-private-token',
      nested: { message: 'rawPayload={"private":"data"}' },
      key: '-----BEGIN PRIVATE KEY-----private-key-----END PRIVATE KEY-----',
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /db.invalid|fake-token|fake-private-token|private-key|"data"/,
    );
    expect(projected).toMatchObject({
      message: '[REDACTED]',
      nested: { message: '[REDACTED]' },
    });
  });
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
