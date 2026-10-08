import {
  isSensitiveDiagnosticKey,
  REDACTED,
  redactStoredText,
} from '../common/sensitive-data';
import { classifyFailureCause } from '../common/safe-failure-cause';
import { safeDiagnosticMessage } from '../common/safe-diagnostic-message';
const UNSUPPORTED_VALUE = '[UNSUPPORTED_METADATA_VALUE]';
const MAX_DEPTH = 8;
const MAX_ITEMS = 1_000;
const MAX_STRING = 2_000;
const MAX_BYTES = 256 * 1024;

export function sanitizeOpsJson(value: unknown): unknown {
  return sanitizeBoundedJson(value, false);
}

/** Failed result payloads are exception surfaces, unlike normal Ops metadata. */
export function sanitizeOpsFailureJson(value: unknown): unknown {
  return sanitizeBoundedJson(
    typeof value === 'string'
      ? (safeDiagnosticMessage(value) ?? 'Background operation failed.')
      : value,
    true,
  );
}

function sanitizeBoundedJson(value: unknown, failure: boolean): unknown {
  if (value === undefined) {
    return undefined;
  }

  const result = sanitizeJsonValue(value, 0, failure);
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_BYTES
    ? result
    : { truncated: true, reason: 'ops_result_size_limit' };
}

function sanitizeJsonValue(
  value: unknown,
  depth: number,
  failure: boolean,
): unknown {
  if (value === null) {
    return null;
  }

  if (typeof value === 'string') {
    return redactStoredText(value).slice(0, MAX_STRING);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) return classifyFailureCause(value);
  if (depth >= MAX_DEPTH) return '[TRUNCATED_DEPTH]';

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ITEMS)
      .map((item) => sanitizeJsonValue(item, depth + 1, failure));
  }

  if (typeof value === 'object') {
    if (!isPlainObject(value)) {
      return UNSUPPORTED_VALUE;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .slice(0, MAX_ITEMS)
        .map(([key, item]) => [
          key.slice(0, MAX_STRING),
          isSensitiveDiagnosticKey(key)
            ? REDACTED
            : (failure
                  ? /message$/iu
                  : /(?:error|exception|failure)message$/iu
                ).test(key.replace(/[^a-z]/giu, '')) && typeof item === 'string'
              ? (safeDiagnosticMessage(item) ?? 'Background operation failed.')
              : sanitizeJsonValue(
                  item,
                  depth + 1,
                  failure || /^(?:errors?|exceptions?|failures?)$/iu.test(key),
                ),
        ]),
    );
  }

  return UNSUPPORTED_VALUE;
}

function isPlainObject(value: object) {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
