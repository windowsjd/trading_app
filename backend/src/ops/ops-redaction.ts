const REDACTED = '[REDACTED]';
const UNSUPPORTED_VALUE = '[UNSUPPORTED_METADATA_VALUE]';

const SENSITIVE_KEY_PATTERNS = [
  'access_token',
  'accesstoken',
  'api_key',
  'apikey',
  'app_key',
  'appkey',
  'app_secret',
  'appsecret',
  'approval_key',
  'approvalkey',
  'authorization',
  'database_url',
  'databaseurl',
  'password',
  'private_key',
  'privatekey',
  'provider_payload',
  'providerpayload',
  'raw_payload',
  'rawpayload',
  'raw_provider_payload',
  'rawproviderpayload',
  'refresh_token',
  'refreshtoken',
  'secret',
  'token',
];

export function sanitizeOpsJson(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  return sanitizeJsonValue(value);
}

function sanitizeJsonValue(value: unknown): unknown {
  if (value === null) {
    return null;
  }

  if (typeof value === 'string') {
    return isSensitiveString(value) ? REDACTED : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }

  if (typeof value === 'object') {
    if (!isPlainObject(value)) {
      return UNSUPPORTED_VALUE;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [
          key,
          isSensitiveKey(key) ? REDACTED : sanitizeJsonValue(item),
        ]),
    );
  }

  return UNSUPPORTED_VALUE;
}

function isPlainObject(value: object) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSensitiveKey(key: string) {
  const normalized = key.replace(/[\s.-]/g, '_').toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function isSensitiveString(value: string) {
  return (
    /^bearer\s+/i.test(value.trim()) ||
    /postgres(?:ql)?:\/\//i.test(value) ||
    /mysql:\/\//i.test(value) ||
    /mongodb(?:\+srv)?:\/\//i.test(value)
  );
}
