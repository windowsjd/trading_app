import type { NotificationSettings } from '../notifications/types';
import type { FriendUser } from './api';

/**
 * 친구 요청 in-app banner rules (2026-11-06). Pure: runs under `node --test`.
 *
 * The server's 받은 요청 list (pending requests other members sent, newest
 * first) is the only source. A request is identified by its request id
 * (the friendship row), never by a nickname. The first read after the app
 * becomes active is a baseline: what it lists — also what arrived while the
 * app was away, which the OS push and the 친구 dot cover — is not new. Later
 * reads announce request ids not seen before, each once per session; a
 * request accepted, rejected or withdrawn is simply no longer listed.
 */

/** Ids remembered per session; old ones go first beyond this. */
export const FRIEND_REQUEST_SEEN_MAX = 500;

export type FriendRequestNotice = {
  /** The first request's id: one banner per key. */
  key: string;
  /** Still-waiting requests it announces, oldest first. */
  requests: Array<{ requestId: string; userId: string; nickname: string }>;
};

function incoming(users: readonly FriendUser[]) {
  return users.filter((user): user is FriendUser & { requestId: string } =>
    user.relationship === 'received' && typeof user.requestId === 'string' && user.requestId.length > 0);
}

function remember(seen: ReadonlySet<string> | null, ids: readonly string[]) {
  const next = new Set(seen ?? []);
  for (const id of ids) {
    next.delete(id);
    next.add(id);
  }
  while (next.size > FRIEND_REQUEST_SEEN_MAX) next.delete(next.values().next().value as string);
  return next;
}

/** The baseline: everything listed now is known, nothing is announced. */
export function takeFriendRequestBaseline(seen: ReadonlySet<string> | null, users: readonly FriendUser[]) {
  return remember(seen, incoming(users).map((user) => user.requestId));
}

/** A later read: the requests not seen before (oldest first), and the ids now known. */
export function observeFriendRequests(seen: ReadonlySet<string>, users: readonly FriendUser[]) {
  const listed = incoming(users);
  const fresh = listed.filter((user) => !seen.has(user.requestId)).reverse();
  return {
    seen: remember(seen, listed.map((user) => user.requestId)),
    fresh: fresh.map((user) => ({ requestId: user.requestId, userId: user.userId, nickname: user.nickname })),
  };
}

/**
 * One banner on screen and at most one waiting: requests found while a banner
 * shows join the waiting one (외 N명), so a burst never queues banner after
 * banner over the screen.
 */
export function enqueueFriendRequests(queue: readonly FriendRequestNotice[], fresh: FriendRequestNotice['requests']): FriendRequestNotice[] {
  const queued = new Set(queue.flatMap((notice) => notice.requests.map((request) => request.requestId)));
  const added = fresh.filter((request) => !queued.has(request.requestId));
  if (!added.length) return [...queue];
  if (queue.length < 2) return [...queue, { key: added[0].requestId, requests: added }];
  const [head, waiting] = queue;
  return [head, { ...waiting, requests: [...waiting.requests, ...added] }];
}

/**
 * The latest read: a waiting banner keeps only requests still listed (one
 * accepted, rejected or withdrawn meanwhile is not announced); the banner on
 * screen is left as it is.
 */
export function pruneFriendRequestQueue(queue: readonly FriendRequestNotice[], users: readonly FriendUser[]): FriendRequestNotice[] {
  if (queue.length < 2) return [...queue];
  const listed = new Set(incoming(users).map((user) => user.requestId));
  const [head, ...rest] = queue;
  const kept = rest.flatMap((notice) => {
    const requests = notice.requests.filter((request) => listed.has(request.requestId));
    return requests.length ? [{ key: requests[0].requestId, requests }] : [];
  });
  return [head, ...kept];
}

/** The banner's copy: 친구 요청 / {닉네임}님이 친구 요청을 보냈어요. */
export function friendRequestNoticeText(notice: FriendRequestNotice) {
  const [first] = notice.requests;
  const others = notice.requests.length - 1;
  return {
    title: '친구 요청',
    detail: others > 0 ? `${first.nickname}님 외 ${others}명이 친구 요청을 보냈어요.` : `${first.nickname}님이 친구 요청을 보냈어요.`,
  };
}

/**
 * The member's own switches (설정 > 알림): 전체 알림 and 친구 요청 must be on.
 * Settings not read yet (or not readable) show nothing rather than guess.
 */
export function friendRequestBannerAllowed(settings: NotificationSettings | undefined) {
  if (!settings) return false;
  return settings.allEnabled !== false && settings.preferences.friendRequest === true;
}
