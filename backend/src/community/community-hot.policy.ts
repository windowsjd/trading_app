/**
 * HOT (current policy, docs/community-api-contract.md §7). Tune by changing
 * the numbers only: the feed query and `isHot` both read this object.
 *
 * score = likeWeight × likes by members other than the author
 *       + commentWeight × visible comments/replies by members other than the
 *         author (anonymous and deleted-member comments count).
 * A post qualifies inside the window with score ≥ minScore; the HOT list is
 * score desc → created_at desc → id desc, at most maxPosts.
 */
export const COMMUNITY_HOT_POLICY = {
  windowHours: 24,
  likeWeight: 1,
  commentWeight: 2,
  minScore: 3,
  maxPosts: 30,
} as const;

export function communityHotScore(input: {
  likesByOthers: number;
  commentsByOthers: number;
}): number {
  return (
    COMMUNITY_HOT_POLICY.likeWeight * input.likesByOthers +
    COMMUNITY_HOT_POLICY.commentWeight * input.commentsByOthers
  );
}

/** Whether a post passes the HOT criteria at `now` (not whether it is in
 * the capped top list). */
export function isCommunityHot(input: {
  createdAt: Date;
  now: Date;
  likesByOthers: number;
  commentsByOthers: number;
}): boolean {
  const windowStart =
    input.now.getTime() - COMMUNITY_HOT_POLICY.windowHours * 3_600_000;
  return (
    input.createdAt.getTime() > windowStart &&
    communityHotScore(input) >= COMMUNITY_HOT_POLICY.minScore
  );
}
