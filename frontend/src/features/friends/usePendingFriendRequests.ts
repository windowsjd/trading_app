import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from '../../theme/native';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getFriends } from './api';

/** How often MY 전체 re-reads while in front with the app active (a request sent without a push still shows). */
export const FRIEND_REQUESTS_POLL_MS = 30_000;

/**
 * Whether the signed-in member has received friend requests still waiting for
 * an answer. The server's 받은 요청 list is the source of truth: it holds only
 * pending requests other members sent (never the member's own), so no read
 * state is kept here. This is the 친구 screen's 받은 요청 query (same key and
 * pages), so accepting or rejecting there (refreshFriendship) and a
 * friend-request push (pushRefresh) update it; every return to the screen
 * using it reads again. Sign-out and sign-in clear the whole cache, so another
 * member's requests never carry over. Loading or a failed read is not "has
 * requests".
 *
 * While the screen is in front and the app active it also re-reads every
 * FRIEND_REQUESTS_POLL_MS, so a request whose push never came (permission off,
 * late delivery) still shows; coming back from the background reads at once.
 * Another screen in front or the app in the background stops it.
 */
export function usePendingFriendRequests() {
  const focused = useIsFocused();
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);
  const query = useInfiniteQuery({
    queryKey: QUERY_KEYS.friends.requests,
    queryFn: ({ pageParam, signal }) => getFriends('requests', '', pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.pagination.nextOffset ?? undefined,
    refetchInterval: focused && appState === 'active' ? FRIEND_REQUESTS_POLL_MS : false,
    refetchIntervalInBackground: false,
  });
  const { refetch } = query;
  // Joins the first read when it is still running; every return reads again.
  useFocusEffect(useCallback(() => {
    void refetch({ cancelRefetch: false });
  }, [refetch]));
  const wasActive = useRef(appState === 'active');
  useEffect(() => {
    const active = appState === 'active';
    if (active && !wasActive.current && focused) void refetch({ cancelRefetch: false });
    wasActive.current = active;
  }, [appState, focused, refetch]);
  return !query.isError && (query.data?.pages[0]?.users.length ?? 0) > 0;
}
