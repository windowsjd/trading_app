import type { CommunityCommentDto } from './api';

/** Offset pages can repeat an item at a page edge (new posts, changed likes): keep the first. */
export function uniqueById<T extends { id: string }>(pages: readonly { items: readonly T[] }[] | undefined): T[] {
  const seen = new Set<string>();
  const items: T[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

/** A reply answers a top-level comment; 답글 on a reply answers that same top-level comment. */
export function replyTargetId(comment: Pick<CommunityCommentDto, 'id' | 'parentCommentId'>): string {
  return comment.parentCommentId ?? comment.id;
}

/** A like toggled before the server answers; the answer then replaces it. */
export function withLike<T extends { likedByMe: boolean; likeCount: number }>(item: T, liked: boolean): T {
  if (item.likedByMe === liked) return item;
  return { ...item, likedByMe: liked, likeCount: Math.max(0, item.likeCount + (liked ? 1 : -1)) };
}
