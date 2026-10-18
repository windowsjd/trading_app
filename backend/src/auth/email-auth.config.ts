export const EMAIL_AUTH_ENV_KEYS = [
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'EMAIL_VERIFICATION_SECRET',
] as const;

export function readEmailAuthConfig(env: Record<string, unknown>) {
  const values = EMAIL_AUTH_ENV_KEYS.map((key) => {
    const value = env[key];
    if (value == null) return '';
    if (typeof value !== 'string') {
      // @diagnosticSurface internal: Startup validation names the invalid setting without exposing its value.
      throw new Error(`${key} must be a string.`);
    }
    return value.trim();
  });
  if (values.every((v) => !v)) return null;
  if (values.some((v) => !v))
    // @diagnosticSurface internal: Startup configuration failure contains only fixed setting names.
    throw new Error(
      'Email requires RESEND_API_KEY, EMAIL_FROM and EMAIL_VERIFICATION_SECRET.',
    );
  const [apiKey, from, secret] = values;
  if (!/^re_[A-Za-z0-9_-]+$/.test(apiKey))
    // @diagnosticSurface internal: Startup configuration failure contains only fixed setting names.
    throw new Error('RESEND_API_KEY is invalid.');
  if (from !== 'Trading Class <admin@nanghwa.com>')
    // @diagnosticSurface internal: Startup configuration failure contains only fixed setting names.
    throw new Error('EMAIL_FROM must be Trading Class <admin@nanghwa.com>.');
  if (secret.length < 32)
    // @diagnosticSurface internal: Startup configuration failure contains only fixed setting names.
    throw new Error(
      'EMAIL_VERIFICATION_SECRET must have at least 32 characters.',
    );
  return { apiKey, from, secret };
}

export function readAuthTrustProxyHops(value: unknown): number {
  if (value == null || value === '') return 0;
  if (typeof value !== 'string' || !/^[0-5]$/.test(value))
    // @diagnosticSurface internal: Startup configuration failure contains only fixed setting names.
    throw new Error('AUTH_TRUST_PROXY_HOPS must be 0 through 5.');
  return Number(value);
}
