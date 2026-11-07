import type { CommunityCommentDto, CommunityPostAuthor, CommunityTier } from './api';
import { getHomeTierName } from '../../screens/home/tierPresentation.ts';

/**
 * How one author is shown, from the server's author object only (contract §3).
 * Only a public author carries an identity: a user id to open 유저 시즌 요약,
 * a photo and a tier. 익명, 익명N, 탈퇴계정 and a deleted comment carry none,
 * so nothing on screen can lead to who wrote them.
 */
export type CommunityAuthorDisplay = {
  kind: 'public' | 'anonymous' | 'deleted_member' | 'deleted';
  name: string;
  userId: string | null;
  profileImageUrl: string | null;
  tier: CommunityTier | null;
  tierName: string | null;
  /** Opens 유저 시즌 요약 (public authors only). */
  pressable: boolean;
  /** 글쓴이: the anonymous post's own author commenting on it. */
  postAuthorTag: boolean;
};

const hidden = (kind: CommunityAuthorDisplay['kind'], name: string): CommunityAuthorDisplay => ({
  kind, name, userId: null, profileImageUrl: null, tier: null, tierName: null, pressable: false, postAuthorTag: false,
});

export function describePostAuthor(author: CommunityPostAuthor): CommunityAuthorDisplay {
  if (author.kind === 'anonymous') return hidden('anonymous', author.label || '익명');
  return {
    kind: 'public', name: author.nickname, userId: author.userId, profileImageUrl: author.profileImageUrl,
    tier: author.tier, tierName: getHomeTierName(author.tier), pressable: true, postAuthorTag: false,
  };
}

export function describeCommentAuthor(comment: Pick<CommunityCommentDto, 'deleted' | 'author'>): CommunityAuthorDisplay {
  const author = comment.author;
  if (comment.deleted || !author) return hidden('deleted', '삭제된 댓글');
  if (author.kind === 'deleted_member') return hidden('deleted_member', author.label || '탈퇴계정');
  if (author.kind === 'anonymous') {
    return { ...hidden('anonymous', author.label || '익명'), postAuthorTag: author.isPostAuthor };
  }
  return describePostAuthor(author);
}
