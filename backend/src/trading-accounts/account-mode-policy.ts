import { TradingAccountMode } from '../generated/prisma/client';

/** Shared financial rules only; this does not grant rewards or unlock features. */
export function isStandaloneAccountMode(
  mode: TradingAccountMode | undefined,
): mode is 'general' | 'beginner' {
  return mode === 'general' || mode === 'beginner';
}
