import type {
  HomeDashboardDto,
  HomeEquityChartSectionDto,
  HomeEquityPointDto,
  HomeRankingSectionDto,
  HomeSectionDto,
  HomeTopPositionDto,
  HomeTopPositionsSectionDto,
} from './api';
import type { SectionState } from '../../models/dto/common';
import type { HomeViewState } from '../../models/enums/viewState';

type QueryState = {
  isLoading?: boolean;
  isError?: boolean;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSectionState(value: unknown): value is SectionState {
  return (
    value === 'available' ||
    value === 'empty' ||
    value === 'blocked' ||
    value === 'unavailable' ||
    value === 'error'
  );
}

function getRecordData(section: unknown): UnknownRecord | null {
  if (!isRecord(section)) return null;

  const data = section.data;
  return isRecord(data) ? data : section;
}

function getSectionState(section: unknown): SectionState | null {
  if (Array.isArray(section)) {
    return section.length > 0 ? 'available' : 'empty';
  }

  if (!isRecord(section)) return null;
  return isSectionState(section.state) ? section.state : null;
}

function getStringValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function extractArray<T>(section: unknown, keys: string[]): T[] {
  if (Array.isArray(section)) return section as T[];
  if (!isRecord(section)) return [];

  const containers = [section, getRecordData(section)].filter(Boolean);

  for (const container of containers) {
    if (!container) continue;

    for (const key of keys) {
      const value = container[key];
      if (Array.isArray(value)) return value as T[];
    }
  }

  return [];
}

function hasUnavailableOrError(section: unknown) {
  const state = getSectionState(section);
  return state === 'unavailable' || state === 'error';
}

function hasPartialSectionError(home: HomeDashboardDto) {
  return [
    home.walletSummary,
    home.ranking,
    home.allocation,
    home.topPositions,
    home.equityChart,
  ].some(hasUnavailableOrError);
}

export function isSectionAvailable(section?: HomeSectionDto | unknown[] | null) {
  const state = getSectionState(section);
  if (state) return state === 'available';
  return !!section;
}

export function isSectionEmpty(section?: HomeSectionDto | unknown[] | null) {
  return getSectionState(section) === 'empty';
}

export function isSectionUnavailable(
  section?: HomeSectionDto | unknown[] | null,
) {
  const state = getSectionState(section);
  return state === 'blocked' || state === 'unavailable' || state === 'error';
}

export function getHomeRankingDisplay(
  section?: HomeRankingSectionDto | null,
) {
  if (!section || isSectionUnavailable(section) || isSectionEmpty(section)) {
    return { tier: '-', rank: '-', percentile: '-' };
  }

  const data = getRecordData(section);
  const tier =
    getStringValue(data?.finalTier) ??
    getStringValue(data?.provisionalTier) ??
    getStringValue(data?.tier) ??
    '-';
  const rank = getStringValue(data?.rank) ?? '-';
  const percentile = getStringValue(data?.percentile) ?? '-';

  return { tier, rank, percentile };
}

export function getHomeTopPositions(
  section?: HomeTopPositionsSectionDto | HomeTopPositionDto[] | null,
) {
  return extractArray<HomeTopPositionDto>(section, ['items', 'positions']);
}

export function getHomeEquityPoints(
  section?: HomeEquityChartSectionDto | HomeEquityPointDto[] | null,
) {
  return extractArray<HomeEquityPointDto>(section, ['items', 'points']);
}

export function getHomeViewState(
  home?: HomeDashboardDto | null,
  queryState?: QueryState,
): HomeViewState {
  if (queryState?.isLoading) return 'home_loading';
  if (queryState?.isError || !home) return 'home_error';

  switch (home.mode) {
    case 'no_current_season':
      return 'home_no_current_season';
    case 'upcoming':
      return 'home_upcoming';
    case 'active_not_joined':
      return 'home_active_not_joined';
    case 'ended':
      return 'home_ended_unsettled';
    case 'settled_joined':
      return 'home_settled';
    case 'settled_not_joined':
      return 'home_settled_not_joined';
    case 'active_joined':
      if (hasPartialSectionError(home)) return 'home_partial_error';
      if (
        isSectionEmpty(home.topPositions) ||
        getHomeTopPositions(home.topPositions).length === 0
      ) {
        return 'home_no_positions';
      }
      return 'home_active_joined';
    default:
      return 'home_error';
  }
}
