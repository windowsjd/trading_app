import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FriendUser } from './api.ts';
import {
  FRIEND_REQUEST_SEEN_MAX,
  enqueueFriendRequests,
  friendRequestBannerAllowed,
  friendRequestNoticeText,
  observeFriendRequests,
  pruneFriendRequestQueue,
  takeFriendRequestBaseline,
} from './friendRequestWatch.ts';

/** A pending request another member sent (the 받은 요청 row). */
const received = (id: string, nickname = id.toUpperCase()): FriendUser =>
  ({ userId: `user-${id}`, nickname, profileImageUrl: null, relationship: 'received', requestId: `request-${id}` });
const request = (id: string, nickname = id.toUpperCase()) => ({ requestId: `request-${id}`, userId: `user-${id}`, nickname });
const ids = (set: ReadonlySet<string>) => [...set].sort();

describe('친구 요청 배너: what is new', () => {
  it('the first read is a baseline: its requests are known and none is announced', () => {
    const seen = takeFriendRequestBaseline(null, [received('b'), received('a')]);
    assert.deepEqual(ids(seen), ['request-a', 'request-b']);
    assert.deepEqual(observeFriendRequests(seen, [received('b'), received('a')]).fresh, []);
  });

  it('a later read announces only ids not seen before, oldest first, each once', () => {
    let seen = takeFriendRequestBaseline(null, [received('a')]);
    // Newest first, as the server lists them.
    const read = [received('d'), received('c'), received('a')];
    const first = observeFriendRequests(seen, read);
    assert.deepEqual(first.fresh, [request('c'), request('d')]);
    seen = first.seen;
    assert.deepEqual(observeFriendRequests(seen, read).fresh, [], 'the same read again');
    // Accepted/rejected/withdrawn: no longer listed, never "new" — and back again it is still known.
    assert.deepEqual(observeFriendRequests(seen, [received('a')]).fresh, []);
    assert.deepEqual(observeFriendRequests(seen, [received('c'), received('a')]).fresh, []);
    // The same member asking again is a new request (a new id).
    const again = { ...received('c'), requestId: 'request-c-2' };
    assert.deepEqual(observeFriendRequests(seen, [again]).fresh, [{ requestId: 'request-c-2', userId: 'user-c', nickname: 'C' }]);
  });

  it('only received requests with an id count (never sent, friends or rows without an id)', () => {
    const others: FriendUser[] = [
      { ...received('s'), relationship: 'sent' }, { ...received('f'), relationship: 'friend' },
      { ...received('n'), requestId: null }, { ...received('e'), requestId: '' },
    ];
    assert.deepEqual(ids(takeFriendRequestBaseline(null, others)), []);
    assert.deepEqual(observeFriendRequests(new Set(), others).fresh, []);
  });

  it('remembers at most FRIEND_REQUEST_SEEN_MAX ids, dropping the oldest', () => {
    const many = Array.from({ length: FRIEND_REQUEST_SEEN_MAX + 2 }, (_, index) => received(`r${index}`));
    const seen = takeFriendRequestBaseline(null, many);
    assert.equal(seen.size, FRIEND_REQUEST_SEEN_MAX);
    assert.equal(seen.has('request-r0'), false);
    assert.equal(seen.has(`request-r${FRIEND_REQUEST_SEEN_MAX + 1}`), true);
  });
});

describe('친구 요청 배너: one on screen, at most one waiting', () => {
  it('a burst is one banner (외 N명); requests found while one shows join the single waiting banner', () => {
    let queue = enqueueFriendRequests([], [request('a'), request('b'), request('c')]);
    assert.equal(queue.length, 1);
    assert.deepEqual(friendRequestNoticeText(queue[0]), { title: '친구 요청', detail: 'A님 외 2명이 친구 요청을 보냈어요.' });
    queue = enqueueFriendRequests(queue, [request('d')]);
    queue = enqueueFriendRequests(queue, [request('e'), request('d')]);
    assert.deepEqual(queue.map((notice) => notice.requests.map((item) => item.requestId)),
      [['request-a', 'request-b', 'request-c'], ['request-d', 'request-e']]);
    assert.deepEqual(friendRequestNoticeText(queue[1]).detail, 'D님 외 1명이 친구 요청을 보냈어요.');
    assert.deepEqual(friendRequestNoticeText(enqueueFriendRequests([], [request('z', '긴닉네임')])[0]),
      { title: '친구 요청', detail: '긴닉네임님이 친구 요청을 보냈어요.' });
  });

  it('a waiting banner keeps only requests still listed; the one on screen is left as it is', () => {
    const queue = enqueueFriendRequests(enqueueFriendRequests([], [request('a')]), [request('b'), request('c')]);
    const pruned = pruneFriendRequestQueue(queue, [received('c')]);
    assert.deepEqual(pruned.map((notice) => [notice.key, notice.requests.map((item) => item.requestId)]),
      [['request-a', ['request-a']], ['request-c', ['request-c']]]);
    assert.deepEqual(pruneFriendRequestQueue(queue, []).map((notice) => notice.key), ['request-a'], 'all handled elsewhere');
  });
});

it('the banner follows the member\'s switches: 전체 알림 and 친구 요청 on; unknown settings show nothing', () => {
  const settings = (allEnabled: boolean | null, friendRequest: boolean) => ({
    allEnabled,
    preferences: { tradeFill: true, futuresLiquidation: true, orderFailure: true, friendRequest, importantNotice: true, seasonFinalResult: true, seasonEndingSoon: true },
  });
  assert.equal(friendRequestBannerAllowed(settings(true, true)), true);
  assert.equal(friendRequestBannerAllowed(settings(null, true)), true, 'a server without 전체 알림');
  assert.equal(friendRequestBannerAllowed(settings(false, true)), false);
  assert.equal(friendRequestBannerAllowed(settings(true, false)), false);
  assert.equal(friendRequestBannerAllowed(undefined), false);
});
