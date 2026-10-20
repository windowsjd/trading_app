import { Prisma } from '../generated/prisma/client';

export const DEVELOPMENT_SEASON_ID = 'sea_2026_s1';
export const LAUNCH_DURATION_MS = 21 * 24 * 60 * 60 * 1000;

export type SeasonAvailability = {
  suspendedAt?: Date | null;
  tradingCutoffAt?: Date | null;
};

/** One server policy for public season reads and selected-account recovery. */
export function publicSeasonWhere(now = new Date()): Prisma.SeasonWhereInput {
  return {
    suspendedAt: null,
    OR: [{ tradingCutoffAt: null }, { tradingCutoffAt: { gt: now } }],
  };
}

export function publicTradingAccountWhere(
  now = new Date(),
): Prisma.TradingAccountWhereInput {
  return {
    OR: [
      { mode: { not: 'season' } },
      { seasonParticipant: { is: { season: publicSeasonWhere(now) } } },
    ],
  };
}

export function isSeasonSuspended(season: SeasonAvailability, now: Date) {
  return (
    !!season.suspendedAt ||
    (!!season.tradingCutoffAt &&
      now.getTime() >= season.tradingCutoffAt.getTime())
  );
}

export function seasonDisplayBadge(season: {
  launchKind?: string | null;
}): 'beta' | null {
  return season.launchKind === 'test' || season.launchKind === 'release'
    ? 'beta'
    : null;
}

export function seasonDisplayFields(season: { launchKind?: string | null }): {
  displayBadge?: 'beta';
} {
  return seasonDisplayBadge(season) ? { displayBadge: 'beta' } : {};
}
