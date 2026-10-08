import { HttpException } from '@nestjs/common';
import { safePublicErrorMessage } from './public-error-message';
import { safeDiagnosticMessage } from './safe-diagnostic-message';

// Keep only reviewed copy off the serialized HTTP response.
const diagnosticMessages = new WeakMap<HttpException, string>();

export function apiErrorDiagnosticMessage(error: unknown): string | undefined {
  return error instanceof HttpException
    ? diagnosticMessages.get(error)
    : undefined;
}

/** HTTP surface: the global filter supplies diagnostics, never this factory.
 * A new code does not make arbitrary message text safe. Add reviewed fixed
 * product messages to the public policy independently of the diagnostic catalog.
 */
export function createApiError(
  code: string,
  message: string,
  status: number,
): HttpException {
  const publicMessage =
    safePublicErrorMessage(message) ?? 'Request could not be completed.';
  const exception = new HttpException(
    {
      success: false,
      error: {
        code: /^[A-Z][A-Z0-9_]{0,99}$/u.test(code)
          ? code
          : 'INTERNAL_SERVER_ERROR',
        message: publicMessage,
      },
    },
    status,
  );
  const diagnosticMessage = safeDiagnosticMessage(message);
  if (diagnosticMessage) diagnosticMessages.set(exception, diagnosticMessage);
  return exception;
}
