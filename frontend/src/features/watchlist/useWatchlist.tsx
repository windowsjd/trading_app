import { useCallback, useEffect, useMemo } from 'react';
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Alert, AppState } from '../../theme/native';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getApiErrorCode } from '../../services/api/errorMapper';
import { getSessionGeneration } from '../../services/api/sessionOwnership';
import { getMe } from '../me/api';
import type { AssetType } from '../market/api';
import {
  addToWatchlist,
  getWatchlist,
  getWatchlistAssets,
  removeFromWatchlist,
  type WatchlistAddResultDto,
  type WatchlistDto,
  type WatchlistRemoveResultDto,
} from './api';
import {
  applyConfirmedChange,
  resolveWatchState,
  watchlistChangeMessage,
  type WatchlistChange,
} from './watchlistState';

/** The signed-in user from the session's `me` entry (seeded at login). */
function useSessionUserId() {
  return useQuery({ queryKey: QUERY_KEYS.me, queryFn: getMe, staleTime: 60_000 }).data?.id;
}

type WatchlistChangeResult = WatchlistAddResultDto | WatchlistRemoveResultDto;
const changeKey = (userId: string) => [...QUERY_KEYS.watchlist.all(userId), 'change'] as const;

/**
 * The signed-in user's watchlist, shared by every screen through the query
 * cache. The server list is the only membership source: a change shows its
 * target as pending until the server answers and writes nothing before that,
 * so a failed request leaves the server state on screen.
 */
export function useWatchlist() {
  const userId = useSessionUserId() ?? '';
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEYS.watchlist.items(userId),
    queryFn: ({ signal }) => getWatchlist(signal),
    enabled: !!userId,
  });

  // Callbacks live on the mutation, not on mutate(): they still run after the
  // screen is left, and for every request rather than only the latest one.
  const { mutate } = useMutation({
    mutationKey: changeKey(userId),
    mutationFn: ({ assetId, watched }: WatchlistChange): Promise<WatchlistChangeResult> =>
      watched ? addToWatchlist(assetId) : removeFromWatchlist(assetId),
    onMutate: () => ({ generation: getSessionGeneration() }),
    onSuccess: async (result) => {
      const key = QUERY_KEYS.watchlist.items(userId);
      // Drop any list read that began before this commit. Invalidation alone
      // would reuse an unfinished first read and keep its pre-change answer.
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.setQueryData<WatchlistDto>(key, (list) => list && applyConfirmedChange(list, result));
    },
    onError: (error, change, context) => {
      // A request of a session that has since ended reports nothing.
      if (context?.generation !== getSessionGeneration()) return;
      Alert.alert(
        change.watched ? '관심종목 추가 실패' : '관심종목 해제 실패',
        watchlistChangeMessage(change.watched, getApiErrorCode(error), query.data?.limit),
      );
    },
    // Re-read either way: a request whose answer was lost may have committed.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.watchlist.all(userId) });
    },
  });

  const pendingChanges = useMutationState({
    filters: { mutationKey: changeKey(userId), status: 'pending' },
    select: (mutation) => mutation.state.variables as WatchlistChange,
  });
  const watchedIds = useMemo(
    () => (query.data ? new Set(query.data.items.map((item) => item.assetId)) : null),
    [query.data],
  );
  const pendingTargets = useMemo(
    () => new Map(pendingChanges.map((change) => [change.assetId, change.watched])),
    [pendingChanges],
  );
  const watchStateOf = useCallback(
    (assetId: string) => resolveWatchState(assetId, watchedIds, pendingTargets),
    [watchedIds, pendingTargets],
  );

  /** Requests a target state. While one request for this asset is unanswered,
   * further taps (from any screen) are ignored instead of queued or raced. */
  const setWatched = useCallback(
    (assetId: string, watched: boolean) => {
      if (!userId) return;
      const busy = queryClient
        .getMutationCache()
        .findAll({ mutationKey: changeKey(userId), status: 'pending' })
        .some((mutation) => (mutation.state.variables as WatchlistChange | undefined)?.assetId === assetId);
      if (!busy) mutate({ assetId, watched });
    },
    [mutate, queryClient, userId],
  );

  // React Query has no native focus source in this app: re-read on return.
  useEffect(() => {
    if (!userId) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void queryClient.invalidateQueries(
          { queryKey: QUERY_KEYS.watchlist.all(userId) },
          { cancelRefetch: false },
        );
      }
    });
    return () => subscription.remove();
  }, [queryClient, userId]);

  return { query, watchStateOf, setWatched };
}

/** One Spot market's watched assets as priced market rows (watchlist order). */
export function useWatchlistAssets(assetType: AssetType, enabled: boolean) {
  const userId = useSessionUserId() ?? '';
  return useQuery({
    queryKey: QUERY_KEYS.watchlist.assets(userId, assetType),
    queryFn: ({ signal }) => getWatchlistAssets(assetType, signal),
    enabled: enabled && !!userId,
  });
}
