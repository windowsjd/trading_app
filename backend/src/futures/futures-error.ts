import { HttpStatus } from '@nestjs/common';
import { createApiError } from '../common/api-error';

export function futuresError(
  code: string,
  message: string,
  status = HttpStatus.CONFLICT,
): never {
  throw createApiError(code, message, status);
}
