import { HttpStatus } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import { TradingAccountMode } from '../generated/prisma/client';

/** Shared financial rules only; this does not grant rewards or unlock features. */
export function isStandaloneAccountMode(
  mode: TradingAccountMode | undefined,
): mode is 'general' | 'beginner' {
  return mode === 'general' || mode === 'beginner';
}

export function isBeginnerModeEnabled(env = process.env): boolean {
  return (
    (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') &&
    env.BEGINNER_MODE_ENABLED === 'true'
  );
}

/** New exposure and financial risk require explicit development opt-in. */
export function assertBeginnerModeEnabled(mode: TradingAccountMode): void {
  if (mode === 'beginner' && !isBeginnerModeEnabled()) {
    throw createApiError(
      'BEGINNER_MODE_DISABLED',
      'Beginner mode is not enabled.',
      HttpStatus.FORBIDDEN,
    );
  }
}
