import { HttpException } from '@nestjs/common';
import { classifyFailureCause } from '../common/safe-failure-cause';
import { safeDiagnosticMessage } from '../common/safe-diagnostic-message';

/** Ops-only failure projection. Does not read HTTP diagnostic context or state.
 * Codes remain control-flow facts; they never approve messages or raw payloads.
 */
export function projectOpsFailure(
  error: unknown,
  fallbackCode = 'OPS_JOB_FAILED',
) {
  let code: unknown;
  let message: unknown;
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response && 'error' in response) {
      const failure = response.error;
      if (typeof failure === 'object' && failure) {
        if ('code' in failure) code = failure.code;
        if ('message' in failure) message = failure.message;
      }
    }
  }
  if (typeof error === 'object' && error) {
    // Arbitrary SDK exception.code can contain private text. New Ops codes use
    // a fixed fallback; only observed allowlisted cause codes are inherited.
    if (code === undefined && 'code' in error)
      code =
        error instanceof Error ? classifyFailureCause(error).code : error.code;
    if (message === undefined && 'message' in error) message = error.message;
  }
  return {
    code: safeOpsCode(code, fallbackCode),
    message:
      typeof message === 'string'
        ? (safeDiagnosticMessage(message) ?? 'Background operation failed.')
        : 'Background operation failed.',
    safeCause: classifyFailureCause(error),
  };
}

export function safeOpsCode(code: unknown, fallback = 'OPS_JOB_FAILED') {
  const fallbackCode = /^[A-Z][A-Z0-9_]{0,99}$/u.test(fallback)
    ? fallback
    : 'OPS_JOB_FAILED';
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(code)
    ? code
    : fallbackCode;
}
