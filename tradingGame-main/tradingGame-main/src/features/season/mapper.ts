import type { CurrentSeasonDto } from '@/models/dto/season';
import type {
  HomeViewState,
  SeasonDomainState,
  SeasonJoinViewState,
} from '@/models/enums/viewState';

export function toSeasonDomainState(season: CurrentSeasonDto): SeasonDomainState {
  if (season.status === 'upcoming') return 'season_upcoming';
  if (season.status === 'active' && season.joined) return 'season_active_joined';
  if (season.status === 'active' && !season.joined) return 'season_active_not_joined';
  if (season.status === 'ended') return 'season_ended_unsettled';
  return 'season_settled';
}

export function toSeasonJoinViewState(
  season: CurrentSeasonDto,
): SeasonJoinViewState {
  if (season.status === 'upcoming') return 'season_upcoming_view';
  if (season.status === 'active' && !season.joined) {
    return 'season_active_not_joined_view';
  }
  return 'season_settled_view';
}

export function toHomeViewState(
  season: CurrentSeasonDto,
  hasPositions: boolean,
): HomeViewState {
  if (season.status === 'upcoming') return 'home_upcoming';
  if (season.status === 'ended') return 'home_ended_unsettled';
  if (season.status === 'settled') return 'home_settled';
  if (season.status === 'active' && !season.joined) return 'home_active_not_joined';
  if (season.status === 'active' && season.joined && !hasPositions) {
    return 'home_no_positions';
  }
  return 'home_active_joined';
}