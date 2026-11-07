import type { CommunityFeedCategory, CommunityPage, CommunityPostDto } from './api';

/**
 * What Home's community card shows (React-free, so `node --test` covers it).
 *
 * The HOT list stays the server's own (24 h, score ≥ 3); Home never ranks
 * posts itself. While that list is empty the card shows 전체's latest posts
 * instead — plain posts, never marked HOT — so a community with posts is
 * never invisible on Home; with no post at all it invites the first one. A
 * read that failed is never taken for "no posts": the card then only offers
 * the way into the community, without claiming anything about its posts.
 */
export type HomeCommunityCard =
  | { kind: 'loading' }
  | { kind: 'hot'; posts: CommunityPostDto[] }
  | { kind: 'latest'; posts: CommunityPostDto[] }
  | { kind: 'empty' }
  | { kind: 'unavailable' };

/** One preview read: its last page (kept through a failed refresh) and whether reading it failed. */
export type HomePreviewRead = { page: CommunityPage<CommunityPostDto> | undefined; failed: boolean };

export const HOME_COMMUNITY_EMPTY_MESSAGE = '커뮤니티에서 첫 이야기를 시작해 보세요.';
/** No claim about the posts: the reads failed, so only the way in is offered. */
export const HOME_COMMUNITY_UNAVAILABLE_MESSAGE = '커뮤니티에서 투자 이야기를 확인해 보세요.';

/** The latest posts are read only once the HOT list is known to be empty. */
export function needsLatestPreview(hot: CommunityPage<CommunityPostDto> | undefined): boolean {
  return !!hot && hot.items.length === 0;
}

/**
 * HOT first; then the latest posts; then the invitation. `viewerFailed`: the
 * member could not be read, so neither list can be (both are the member's view).
 */
export function homeCommunityCard(hot: HomePreviewRead, latest: HomePreviewRead, viewerFailed = false): HomeCommunityCard {
  if (hot.page?.items.length) return { kind: 'hot', posts: hot.page.items };
  if (!hot.page) return hot.failed || viewerFailed ? { kind: 'unavailable' } : { kind: 'loading' };
  if (latest.page?.items.length) return { kind: 'latest', posts: latest.page.items };
  if (!latest.page) return latest.failed ? { kind: 'unavailable' } : { kind: 'loading' };
  return { kind: 'empty' };
}

/** The chip the card opens: HOT for HOT posts, otherwise 전체 (the posts shown, or where the first one goes). */
export function homeCommunityCategory(card: HomeCommunityCard): CommunityFeedCategory {
  return card.kind === 'hot' ? 'hot' : 'all';
}
