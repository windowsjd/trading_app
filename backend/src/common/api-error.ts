import { HttpException } from '@nestjs/common';
import { safeDiagnosticMessage } from './safe-diagnostic-message';

/** HTTP surface: the global filter supplies diagnostics, never this factory.
 * A new code does not make arbitrary message text safe. Add reviewed fixed
 * product messages to the existing message policy independently of the code.
 */
export function createApiError(
  code: string,
  message: string,
  status: number,
): HttpException {
  const reviewed = safeDiagnosticMessage(message);
  // Admin-reviewed Provider templates are technical observations, not product
  // copy. Review remains exact-match; this rejection never approves raw prose.
  const publicMessage =
    reviewed &&
    !/\b(?:provider|binance|kis|HTTP|Prisma|database|SQL|console)\b|[A-Z]{2,}_[A-Z_]{2,}/iu.test(
      reviewed,
    )
      ? reviewed
      : 'Request could not be completed.';
  return new HttpException(
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
}
