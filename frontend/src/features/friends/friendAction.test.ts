import assert from 'node:assert/strict';
import { it } from 'node:test';
import { FRIEND_ACTION_BUSY, friendActionFailureMessage, friendCommandUser } from './friendAction.ts';

const user = { id: 'user-2', nickname: '다른유저', profileImageUrl: null };

it('a command targets the summary user only with the relationship read for that same id', () => {
  assert.deepEqual(friendCommandUser(user, { userId: 'user-2', relationship: 'received', requestId: 'req-1' }), {
    userId: 'user-2', nickname: '다른유저', profileImageUrl: null, relationship: 'received', requestId: 'req-1',
  });
  // Another id's answer, or the member's own summary: no command at all.
  assert.equal(friendCommandUser(user, { userId: 'user-3', relationship: 'none', requestId: null }), null);
  assert.equal(friendCommandUser(user, { userId: 'user-2', relationship: 'self', requestId: null }), null);
});

it('a refusal says why in reviewed copy; anything else is a plain retry line', () => {
  assert.match(friendActionFailureMessage('request', 'FRIENDSHIP_EXISTS'), /이미 친구이거나 대기 중인 요청/);
  assert.match(friendActionFailureMessage('request', 'USER_NOT_FOUND'), /친구 요청을 할 수 없는 사용자/);
  for (const action of ['accept', 'reject'] as const)
    assert.match(friendActionFailureMessage(action, 'FRIEND_REQUEST_NOT_FOUND'), /이미 처리되었거나 취소된 요청/);
  for (const code of [null, 'INTERNAL_SERVER_ERROR', 'NETWORK_ERROR'])
    assert.equal(friendActionFailureMessage('request', code), '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
  assert.deepEqual(FRIEND_ACTION_BUSY, { request: '요청 중...', accept: '수락 중...', reject: '거절 중...' });
});
