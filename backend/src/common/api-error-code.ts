import { HttpException } from '@nestjs/common';

/** Fixed public error code of an HTTP API error, for bounded worker state. */
export function apiErrorCode(error: unknown, fallback: string): string {
  const response =
    error instanceof HttpException
      ? (error.getResponse() as { error?: { code?: unknown } })
      : null;
  const code = response?.error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(code)
    ? code
    : fallback;
}
