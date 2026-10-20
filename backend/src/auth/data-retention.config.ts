/** Retention of personal data and logs (docs/data-retention.md).
 *
 * On by default: every period below is a product decision with a default,
 * so nothing has to be set in production. DATA_RETENTION_CLEANUP_ENABLED=false
 * is the emergency stop. Operator audit logs are kept at least one year (the
 * legal minimum); raise OPERATOR_AUDIT_LOG_RETENTION_DAYS to 730 when the
 * service nears 50,000 members. Values are strict decimal integers, and an
 * error names the variable and its range only. */
export function dataRetentionConfig(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.DATA_RETENTION_CLEANUP_ENABLED ?? 'true';
  if (!['true', 'false'].includes(enabled))
    // @diagnosticSurface internal: Startup validation collects this fixed configuration error before the server accepts requests.
    throw new Error('DATA_RETENTION_CLEANUP_ENABLED must be true or false');
  const days = (name: string, fallback: number, min: number, max: number) => {
    const text = env[name] ?? String(fallback);
    const value = Number(text);
    if (
      !/^\d+$/.test(text) ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    )
      // @diagnosticSurface internal: Startup validation collects this fixed configuration error before the server accepts requests.
      throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return value;
  };
  return {
    enabled: enabled === 'true',
    /** Refresh sessions, counted from expiry or revocation (whichever first). */
    sessionDays: days('AUTH_SESSION_RETENTION_DAYS', 90, 30, 365),
    auditLogDays: days('OPERATOR_AUDIT_LOG_RETENTION_DAYS', 365, 365, 3650),
    /** Support inquiries, counted from the answer (or filing, if unanswered). */
    inquiryDays: days('INQUIRY_RETENTION_DAYS', 1095, 30, 3650),
  };
}

export type DataRetentionConfig = ReturnType<typeof dataRetentionConfig>;
