import { HttpException, HttpStatus } from '@nestjs/common';

export function futuresError(
  code: string,
  message: string,
  status = HttpStatus.CONFLICT,
): never {
  throw new HttpException({ success: false, error: { code, message } }, status);
}
