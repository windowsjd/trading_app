import { useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getFriends } from './api';

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
 */
export function usePendingFriendRequests() {
  const query = useInfiniteQuery({
    queryKey: QUERY_KEYS.friends.requests,
    queryFn: ({ pageParam, signal }) => getFriends('requests', '', pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.pagination.nextOffset ?? undefined,
  });
  const { refetch } = query;
  // Joins the first read when it is still running; every return reads again.
  useFocusEffect(useCallback(() => {
    void refetch({ cancelRefetch: false });
  }, [refetch]));
  return !query.isError && (query.data?.pages[0]?.users.length ?? 0) > 0;
}
