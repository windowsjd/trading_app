import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import type { CommunityPage, CommunityPostDto } from './api';

type FeedData = InfiniteData<CommunityPage<CommunityPostDto>, number>;

/** Home's two single-page reads: the HOT preview and, while HOT is empty, the latest posts. */
const homePreviewKeys = (userId: string) => [QUERY_KEYS.community.hotPreview(userId), QUERY_KEYS.community.latestPreview(userId)];

/**
 * One post appears in several reads of the same member: every feed category,
 * Home's previews and its own detail. A like or a new comment updates all
 * of them at once, so going back never shows an older count.
 */
export function patchCommunityPost(client: QueryClient, userId: string, postId: string,
  update: (post: CommunityPostDto) => CommunityPostDto) {
  const apply = (post: CommunityPostDto) => (post.id === postId ? update(post) : post);
  client.setQueriesData<FeedData>({ queryKey: ['community', 'feed', userId] }, (data) => data && {
    ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map(apply) })),
  });
  for (const key of homePreviewKeys(userId)) {
    client.setQueryData<CommunityPage<CommunityPostDto>>(key, (page) => page && { ...page, items: page.items.map(apply) });
  }
  client.setQueryData<CommunityPostDto>(QUERY_KEYS.community.post(userId, postId), (post) => post && update(post));
}

/** A deleted post leaves every list now; the next reads confirm it. */
export function dropCommunityPost(client: QueryClient, userId: string, postId: string) {
  client.setQueriesData<FeedData>({ queryKey: ['community', 'feed', userId] }, (data) => data && {
    ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.filter((post) => post.id !== postId) })),
  });
  for (const key of homePreviewKeys(userId)) {
    client.setQueryData<CommunityPage<CommunityPostDto>>(key, (page) => page && { ...page, items: page.items.filter((post) => post.id !== postId) });
  }
  client.removeQueries({ queryKey: QUERY_KEYS.community.post(userId, postId), exact: true });
  client.removeQueries({ queryKey: ['community', 'comments', userId, postId] });
}

/** After a new post, a deletion or a moderation: every list is read again. */
export function refreshCommunityLists(client: QueryClient, userId: string) {
  void client.invalidateQueries({ queryKey: ['community', 'feed', userId] });
  for (const key of homePreviewKeys(userId)) void client.invalidateQueries({ queryKey: key });
}
