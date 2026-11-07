import {
  COMMUNITY_HOT_POLICY,
  communityHotScore,
  isCommunityHot,
} from './community-hot.policy';

describe('community HOT policy', () => {
  const now = new Date('2026-11-07T12:00:00.000Z');
  const hoursAgo = (hours: number) =>
    new Date(now.getTime() - hours * 3_600_000);

  it('is the current contract policy', () => {
    expect(COMMUNITY_HOT_POLICY).toEqual({
      windowHours: 24,
      likeWeight: 1,
      commentWeight: 2,
      minScore: 3,
      maxPosts: 30,
    });
  });

  it('weights other members comments twice their likes', () => {
    expect(communityHotScore({ likesByOthers: 1, commentsByOthers: 1 })).toBe(
      3,
    );
    expect(communityHotScore({ likesByOthers: 3, commentsByOthers: 0 })).toBe(
      3,
    );
    expect(communityHotScore({ likesByOthers: 0, commentsByOthers: 1 })).toBe(
      2,
    );
  });

  it('needs the minimum score inside the 24-hour window', () => {
    const hot = (createdAt: Date, likes: number, comments: number) =>
      isCommunityHot({
        createdAt,
        now,
        likesByOthers: likes,
        commentsByOthers: comments,
      });
    expect(hot(hoursAgo(1), 1, 1)).toBe(true);
    expect(hot(hoursAgo(1), 0, 1)).toBe(false);
    expect(hot(hoursAgo(1), 2, 0)).toBe(false);
    expect(hot(hoursAgo(23.99), 3, 0)).toBe(true);
    // Exactly at the window start is outside (created_at > now − 24h).
    expect(hot(hoursAgo(24), 3, 0)).toBe(false);
    expect(hot(hoursAgo(30), 50, 50)).toBe(false);
  });
});
