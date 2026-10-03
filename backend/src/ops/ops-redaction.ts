import {
  isSensitiveDiagnosticKey,
  REDACTED,
  redactStoredText,
} from '../common/sensitive-data';
const UNSUPPORTED_VALUE = '[UNSUPPORTED_METADATA_VALUE]';

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
    return redactStoredText(value);
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
          isSensitiveDiagnosticKey(key) ? REDACTED : sanitizeJsonValue(item),
        ]),
    );
  }

  return UNSUPPORTED_VALUE;
}

function isPlainObject(value: object) {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
