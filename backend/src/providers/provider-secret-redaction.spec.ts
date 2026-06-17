import { redactJsonValue, redactText } from './provider-secret-redaction';

describe('provider secret redaction', () => {
  it('masks explicit API key, app key, app secret, token, and approval key values', () => {
    const secrets = ['api-key-value', 'kis-app-key', 'kis-app-secret'];
    const text = redactText(
      'api-key-value kis-app-key kis-app-secret bearer-token',
      {
        secrets: [...secrets, 'bearer-token'],
      },
    );

    expect(text).toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED]');
  });

  it('masks sensitive JSON keys and matching nested values', () => {
    const redacted = redactJsonValue(
      {
        apiKey: 'api-key-value',
        appsecret: 'kis-app-secret',
        nested: {
          approval_key: 'approval-secret',
          visible: 'prefix api-key-value suffix',
        },
      },
      {
        secrets: ['api-key-value', 'kis-app-secret', 'approval-secret'],
      },
    );

    expect(redacted).toEqual({
      apiKey: '[REDACTED]',
      appsecret: '[REDACTED]',
      nested: {
        approval_key: '[REDACTED]',
        visible: 'prefix [REDACTED] suffix',
      },
    });
  });
});
