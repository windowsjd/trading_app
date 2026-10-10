import { HttpStatus } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import { TradingAccountMode } from '../generated/prisma/client';

/** Shared financial rules only; this does not grant rewards or unlock features. */
export function isStandaloneAccountMode(
  mode: TradingAccountMode | undefined,
): mode is 'general' | 'beginner' {
  return mode === 'general' || mode === 'beginner';
}

/**
 * Operator switch for every user, in every environment (production included).
 * Default off; anything but the exact string `true` keeps it off, so clearing
 * the variable is the emergency stop. Owned accounts are never deleted by it.
 */
export function isBeginnerModeEnabled(env = process.env): boolean {
  return env.BEGINNER_MODE_ENABLED === 'true';
}

/** New exposure and financial risk require the explicit operator switch. */
export function assertBeginnerModeEnabled(mode: TradingAccountMode): void {
  if (mode === 'beginner' && !isBeginnerModeEnabled()) {
    throw createApiError(
      'BEGINNER_MODE_DISABLED',
      'Beginner mode is not enabled.',
      HttpStatus.FORBIDDEN,
    );
  }
}
