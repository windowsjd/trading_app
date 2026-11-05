import type { FriendAction, FriendRelationship, FriendUser } from './api';

/**
 * The friend action on a user's season summary (2026-11-06): pure rules,
 * run under `node --test`. The relationship is always the server's answer
 * for that user id; nothing here guesses one.
 */

/** The FriendUser a command needs: the summary's own user and the relationship read for that id. */
export function friendCommandUser(
  user: { id: string; nickname: string; profileImageUrl: string | null },
  relationship: FriendRelationship,
): FriendUser | null {
  if (relationship.userId !== user.id || relationship.relationship === 'self') return null;
  return {
    userId: user.id,
    nickname: user.nickname,
    profileImageUrl: user.profileImageUrl,
    relationship: relationship.relationship,
    requestId: relationship.requestId,
  };
}

/** What a refused command says; the relationship is read again either way. */
export function friendActionFailureMessage(action: FriendAction['action'], code: string | null) {
  if (code === 'FRIENDSHIP_EXISTS') return '이미 친구이거나 대기 중인 요청이 있어요. 최신 상태로 다시 확인했어요.';
  if (code === 'USER_NOT_FOUND') return '현재 친구 요청을 할 수 없는 사용자예요.';
  if (code === 'FRIEND_REQUEST_NOT_FOUND')
    return action === 'accept' || action === 'reject'
      ? '이미 처리되었거나 취소된 요청이에요. 최신 상태로 다시 확인했어요.'
      : '요청을 찾을 수 없어요. 최신 상태로 다시 확인했어요.';
  return '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.';
}

/** The busy label of the pressed button. */
export const FRIEND_ACTION_BUSY: Record<'request' | 'accept' | 'reject', string> = {
  request: '요청 중...',
  accept: '수락 중...',
  reject: '거절 중...',
};
