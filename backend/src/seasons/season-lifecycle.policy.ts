import { SeasonStatus } from '../generated/prisma/client';

export type SeasonLifecycleMode =
  | 'upcoming'
  | 'active'
  | 'ended'
  | 'settled';

export type SeasonLifecycleErrorCode =
  | 'SEASON_NOT_ACTIVE'
  | 'SEASON_NOT_STARTED'
  | 'SEASON_ENDED';

export type SeasonLifecycleSeason = {
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
};

export class SeasonLifecycleError extends Error {
  constructor(
    readonly code: SeasonLifecycleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function getEffectiveSeasonMode(
  season: SeasonLifecycleSeason,
  now: Date,
): SeasonLifecycleMode {
  if (season.status === SeasonStatus.settled) {
    return 'settled';
  }

  if (now.getTime() < season.startAt.getTime()) {
    return 'upcoming';
  }

  if (now.getTime() >= season.endAt.getTime()) {
    return 'ended';
  }

  if (season.status === SeasonStatus.active) {
    return 'active';
  }

  return season.status === SeasonStatus.ended ? 'ended' : 'upcoming';
}

export function isSeasonCurrentlyActive(
  season: SeasonLifecycleSeason,
  now: Date,
): boolean {
  return (
    season.status === SeasonStatus.active &&
    season.startAt.getTime() <= now.getTime() &&
    now.getTime() < season.endAt.getTime()
  );
}

export function assertSeasonJoinable(
  season: SeasonLifecycleSeason,
  now: Date,
): void {
  assertSeasonCurrentlyActive(season, now);
}

export function assertSeasonTradable(
  season: SeasonLifecycleSeason,
  now: Date,
): void {
  assertSeasonCurrentlyActive(season, now);
}

export function assertSeasonExchangeable(
  season: SeasonLifecycleSeason,
  now: Date,
): void {
  assertSeasonCurrentlyActive(season, now);
}

function assertSeasonCurrentlyActive(
  season: SeasonLifecycleSeason,
  now: Date,
): void {
  if (season.status !== SeasonStatus.active) {
    throw new SeasonLifecycleError(
      'SEASON_NOT_ACTIVE',
      'Season is not active.',
    );
  }

  if (now.getTime() < season.startAt.getTime()) {
    throw new SeasonLifecycleError(
      'SEASON_NOT_STARTED',
      'Season has not started.',
    );
  }

  if (now.getTime() >= season.endAt.getTime()) {
    throw new SeasonLifecycleError('SEASON_ENDED', 'Season has ended.');
  }
}
