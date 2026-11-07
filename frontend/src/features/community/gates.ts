import type { CommunityBootstrapDto, CommunityPostDto, CommunitySanctionNotice } from './api';
import { formatKstDate } from './format.ts';

/**
 * Whether the signed-in member may write now (contract §6.4–6.5). The server
 * decides every write; this only tells the app what to offer: the rules
 * sheet before a first write, the restriction notice instead of the inputs.
 * Reads and removing one's own posts, comments and likes are never gated.
 */
export type CommunityWriteGate =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'restricted'; message: string }
  | { kind: 'rules' }
  | { kind: 'open' };

export function communityWriteGate(bootstrap: CommunityBootstrapDto | null | undefined, failed = false): CommunityWriteGate {
  if (!bootstrap) return failed ? { kind: 'unavailable' } : { kind: 'loading' };
  if (bootstrap.activeSanction) return { kind: 'restricted', message: restrictionMessage(bootstrap.activeSanction) };
  return bootstrap.rulesAccepted ? { kind: 'open' } : { kind: 'rules' };
}

/** 커뮤니티 이용이 제한되었어요 (2026.12.07까지 / 영구). */
export function restrictionMessage(notice: Pick<CommunitySanctionNotice, 'until'>): string {
  return `커뮤니티 이용이 제한되었어요 (${notice.until ? `${formatKstDate(notice.until)}까지` : '영구'})`;
}

/** 사진에 닉네임이나 프로필이 보이면… — anonymous posts with at least one photo only. */
export function showAnonymousPhotoNotice(anonymous: boolean, photoCount: number): boolean {
  return anonymous && photoCount > 0;
}

/**
 * The author of an anonymous post always comments anonymously (the server
 * stores it so whatever is sent): the app keeps 익명 checked and locked.
 */
export function commentAnonymityLocked(post: Pick<CommunityPostDto, 'mine' | 'author'> | null | undefined): boolean {
  return !!post?.mine && post.author.kind === 'anonymous';
}
