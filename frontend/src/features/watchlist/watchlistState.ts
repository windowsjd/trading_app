import type {
  WatchlistAddResultDto,
  WatchlistDto,
  WatchlistItemDto,
  WatchlistRemoveResultDto,
} from './api';

/** One requested target state for one asset — never "flip whatever it is". */
export type WatchlistChange = { assetId: string; watched: boolean };

/**
 * What one star shows. `watched: null` means the server state is unknown
 * (still loading, or the read failed): the star is then disabled rather than
 * claiming "not watched".
 */
export type WatchState = { watched: boolean | null; pending: boolean };

/** The server's order: newest first, then asset id descending. */
function newestFirst(left: WatchlistItemDto, right: WatchlistItemDto) {
  if (left.addedAt !== right.addedAt) return left.addedAt < right.addedAt ? 1 : -1;
  return left.assetId < right.assetId ? 1 : left.assetId > right.assetId ? -1 : 0;
}

/**
 * The cached list once the server confirmed a change, so a star never falls
 * back to the pre-change state while the list is being re-read. The re-read
 * that follows still replaces this with the server's own list.
 */
export function applyConfirmedChange(
  list: WatchlistDto,
  result: WatchlistAddResultDto | WatchlistRemoveResultDto,
): WatchlistDto {
  if ('item' in result) {
    if (list.items.some((item) => item.assetId === result.item.assetId)) return list;
    return { ...list, items: [...list.items, result.item].sort(newestFirst) };
  }
  const items = list.items.filter((item) => item.assetId !== result.assetId);
  return items.length === list.items.length ? list : { ...list, items };
}

/** A pending request shows its target; otherwise the server list decides. */
export function resolveWatchState(
  assetId: string,
  watchedIds: ReadonlySet<string> | null,
  pendingTargets: ReadonlyMap<string, boolean>,
): WatchState {
  const target = pendingTargets.get(assetId);
  if (target !== undefined) return { watched: target, pending: true };
  return { watched: watchedIds ? watchedIds.has(assetId) : null, pending: false };
}

export const WATCHLIST_DEFAULT_LIMIT = 50;

/** Reviewed copy for a failed change, by the server's error code. */
export function watchlistChangeMessage(
  watched: boolean,
  code: string | undefined,
  limit = WATCHLIST_DEFAULT_LIMIT,
): string {
  switch (code) {
    case 'WATCHLIST_LIMIT_EXCEEDED':
      return `관심종목은 최대 ${limit}개까지 추가할 수 있습니다. 다른 종목을 해제한 뒤 다시 시도해주세요.`;
    case 'ASSET_NOT_TRADABLE':
      return '거래가 중지되었거나 현물로 제공되지 않는 종목은 관심종목에 추가할 수 없습니다.';
    case 'ASSET_NOT_FOUND':
      return '종목 정보를 찾을 수 없습니다. 목록을 새로고침한 뒤 다시 시도해주세요.';
    default:
      return watched
        ? '관심종목에 추가하지 못했습니다. 잠시 후 다시 시도해주세요.'
        : '관심종목에서 해제하지 못했습니다. 잠시 후 다시 시도해주세요.';
  }
}
