import type {
  CurrentSeasonDto,
  SeasonEffectiveMode,
} from '@/models/dto/season';
import type {
  HomeViewState,
  SeasonDomainState,
  SeasonJoinViewState,
} from '@/models/enums/viewState';

export type SeasonEntryRoute = 'home' | 'season_join';

export function getEffectiveSeasonMode(
  season: CurrentSeasonDto | null | undefined,
  now = new Date(),
): SeasonEffectiveMode | null {
  if (!season) return null;

  const serverMode = season.effectiveMode ?? season.effectiveStatus;
  if (serverMode) return serverMode;

  if (season.status === 'settled') return 'settled';

  const nowMs = now.getTime();
  const startAtMs = Date.parse(season.startAt);
  const endAtMs = Date.parse(season.endAt);

  if (Number.isFinite(startAtMs) && nowMs < startAtMs) {
    return 'upcoming';
  }

  if (Number.isFinite(endAtMs) && nowMs >= endAtMs) {
    return 'ended';
  }

  if (season.status === 'active') return 'active';
  if (season.status === 'ended') return 'ended';

  return 'upcoming';
}

export function toSeasonDomainState(
  season: CurrentSeasonDto | null | undefined,
  now = new Date(),
): SeasonDomainState {
  const effectiveMode = getEffectiveSeasonMode(season, now);

  if (!season || !effectiveMode) return 'season_not_configured';

  if (effectiveMode === 'upcoming') return 'season_upcoming';

  if (effectiveMode === 'active') {
    return season.joined ? 'season_active_joined' : 'season_active_not_joined';
  }

  if (effectiveMode === 'ended') return 'season_ended_unsettled';

  return season.joined ? 'season_settled_joined' : 'season_settled_not_joined';
}

export function toSeasonEntryRoute(
  season: CurrentSeasonDto | null | undefined,
  now = new Date(),
): SeasonEntryRoute {
  const seasonState = toSeasonDomainState(season, now);

  if (
    seasonState === 'season_upcoming' ||
    seasonState === 'season_active_not_joined' ||
    seasonState === 'season_not_configured'
  ) {
    return 'season_join';
  }

  return 'home';
}

export function toSeasonJoinViewState(
  season: CurrentSeasonDto | null | undefined,
  now = new Date(),
): SeasonJoinViewState {
  const seasonState = toSeasonDomainState(season, now);

  if (seasonState === 'season_not_configured') {
    return 'season_not_configured_view';
  }

  if (seasonState === 'season_upcoming') return 'season_upcoming_view';

  if (seasonState === 'season_active_not_joined') {
    return 'season_active_not_joined_view';
  }

  if (seasonState === 'season_active_joined') return 'season_join_success';

  if (seasonState === 'season_ended_unsettled') {
    return 'season_ended_unsettled_view';
  }

  return 'season_settled_view';
}

export function toHomeViewState(
  season: CurrentSeasonDto | null | undefined,
  hasPositions: boolean,
  now = new Date(),
): HomeViewState {
  const seasonState = toSeasonDomainState(season, now);

  if (seasonState === 'season_not_configured') return 'home_error';
  if (seasonState === 'season_upcoming') return 'home_upcoming';
  if (seasonState === 'season_ended_unsettled') return 'home_ended_unsettled';
  if (seasonState === 'season_settled_joined') return 'home_settled';
  if (seasonState === 'season_settled_not_joined') return 'home_settled';
  if (seasonState === 'season_active_not_joined') return 'home_active_not_joined';
  if (seasonState === 'season_active_joined' && !hasPositions) {
    return 'home_no_positions';
  }

  return 'home_active_joined';
}
