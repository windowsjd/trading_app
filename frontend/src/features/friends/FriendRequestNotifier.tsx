import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from '../../theme/native';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { rootNavigationRef } from '../../app/navigation/navigationRef';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import TopNoticeBanner, { type BannerActionOutcome } from '../../components/common/TopNoticeBanner';
import { questNavigationAllowed } from '../quest/questNavigationGuard';
import { getNotificationPreferences } from '../notifications/api';
import { MAIN_ROUTES, navigateTo, useRootRouteName, useSessionUserId } from '../notifications/PushNotificationsHost';
import { getFriends } from './api';
import { FRIEND_REQUESTS_POLL_MS } from './usePendingFriendRequests';
import {
  enqueueFriendRequests,
  friendRequestBannerAllowed,
  friendRequestNoticeText,
  observeFriendRequests,
  pruneFriendRequestQueue,
  takeFriendRequestBaseline,
  type FriendRequestNotice,
} from './friendRequestWatch';

/** Visible time after the entrance (the fill banner's). */
export const FRIEND_REQUEST_BANNER_VISIBLE_MS = 4000;
/** After a held 받은 요청 보기: time to read why, end the guide and press again. */
export const FRIEND_REQUEST_BANNER_HELD_MS = 10_000;

const NOT_OPENED: Record<Exclude<BannerActionOutcome, 'opened'>, string> = {
  held: '학습 안내 중이라 받은 요청을 열지 않았어요. 안내를 종료한 뒤 다시 눌러 주세요.',
  unavailable: '지금은 받은 요청을 열 수 없어요. 잠시 후 다시 눌러 주세요.',
};

/**
 * 친구 요청 in-app banner (2026-11-06), mounted once beside the root navigator
 * like the fill banner, so it shows over every tab and pushed screen. Works
 * without any push (a server with push off, a device without permission): it
 * reads the same 받은 요청 list as the 친구 screen and the MY 전체 dot (one
 * cache entry, the dot's 30 s pace — observers on one key share one read), only
 * while the app is active on the main screens, signed in, and the member's
 * 친구 요청 notification switch is on. A foreground friend-request push
 * refreshes that list at once (pushRefresh). The first read after becoming
 * active is a baseline (friendRequestWatch): only requests arriving while the
 * app is in use are announced, each once; what came while it was away is the
 * OS push's and the dot's. One session = one watcher: sign-out or another
 * user remounts it with nothing carried over. The banner shares the app's one
 * top place with the fill banner (TopNoticeBanner) and opens 친구 > 받은 요청
 * as the push tap does.
 */
export default function FriendRequestNotifier() {
  const client = useQueryClient();
  const userId = useSessionUserId(client);
  const route = useRootRouteName();
  const generation = getSessionGeneration();
  const main = !!route && MAIN_ROUTES.has(route);
  return userId
    ? <FriendRequestSession key={`${generation}:${userId}`} generation={generation} userId={userId} main={main} />
    : null;
}

function useAppActive() {
  const [state, setState] = useState<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', setState);
    return () => subscription.remove();
  }, []);
  // Web and an unknown initial state count as foreground.
  return state === 'active' || state == null || state === 'unknown';
}

function FriendRequestSession({ generation, userId, main }: { generation: number; userId: string; main: boolean }) {
  const client = useQueryClient();
  const active = useAppActive() && main;
  // The switches as 설정 > 알림 saves them (same key: a change there applies at
  // once); read again on a return once a minute old.
  const settings = useQuery({
    queryKey: QUERY_KEYS.notifications.preferences(userId),
    queryFn: ({ signal }) => getNotificationPreferences(signal),
    enabled: active,
    staleTime: 60_000,
  });
  const watching = active && friendRequestBannerAllowed(settings.data);
  const requests = useInfiniteQuery({
    queryKey: QUERY_KEYS.friends.requests,
    queryFn: ({ pageParam, signal }) => getFriends('requests', '', pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.pagination.nextOffset ?? undefined,
    enabled: watching,
    refetchInterval: watching ? FRIEND_REQUESTS_POLL_MS : false,
    refetchIntervalInBackground: false,
  });
  const [queue, setQueue] = useState<FriendRequestNotice[]>([]);
  const seen = useRef<ReadonlySet<string> | null>(null);
  // A read newer than this is the next baseline; null once it is taken.
  const baselineAfter = useRef<number | null>(0);

  // Each start of watching (sign-in, back from the background or another
  // screen, the switch turned on) takes a new baseline from a fresh read.
  const { dataUpdatedAt, refetch } = requests;
  const wasWatching = useRef(false);
  useEffect(() => {
    if (watching && !wasWatching.current) {
      baselineAfter.current = dataUpdatedAt;
      void refetch({ cancelRefetch: false });
    }
    wasWatching.current = watching;
  }, [dataUpdatedAt, refetch, watching]);

  const pages = requests.data?.pages;
  useEffect(() => {
    if (!watching || !pages || !isCurrentSession(generation)) return;
    const users = pages.flatMap((page) => page.users);
    if (baselineAfter.current !== null) {
      // Only a read made after watching started.
      if (dataUpdatedAt <= baselineAfter.current) return;
      seen.current = takeFriendRequestBaseline(seen.current, users);
      baselineAfter.current = null;
      setQueue((previous) => pruneFriendRequestQueue(previous, users));
      return;
    }
    const result = observeFriendRequests(seen.current ?? new Set(), users);
    seen.current = result.seen;
    setQueue((previous) => pruneFriendRequestQueue(enqueueFriendRequests(previous, result.fresh), users));
    // An open season summary of a sender shows 수락 / 거절 at once.
    if (result.fresh.length) void client.invalidateQueries({ queryKey: ['friends', 'relationship'] });
  }, [client, dataUpdatedAt, generation, pages, watching]);

  const head = queue[0] ?? null;
  const done = useCallback(() => setQueue((previous) => previous.slice(1)), []);
  const open = useCallback((): BannerActionOutcome => {
    if (!rootNavigationRef.isReady()) return 'unavailable';
    // An active beginner guide holds the 전체 tab, as for a push tap.
    if (!questNavigationAllowed('MyTab')) return 'held';
    navigateTo({ kind: 'friend_requests', type: 'friend_request', uid: userId }, Date.now());
    return 'opened';
  }, [userId]);
  return (
    <TopNoticeBanner
      channel="friend-request"
      notice={head ? { id: head.key, ...friendRequestNoticeText(head) } : null}
      visibleMs={FRIEND_REQUEST_BANNER_VISIBLE_MS}
      heldMs={FRIEND_REQUEST_BANNER_HELD_MS}
      icon={{ glyph: '+', tone: 'info' }}
      actionLabel="받은 요청 보기"
      actionTestID="friend-request-banner-open"
      notOpened={NOT_OPENED}
      testID="friend-request-banner"
      onAction={open}
      onDone={done}
    />
  );
}
