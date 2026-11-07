import type { NavigatorScreenParams } from '@react-navigation/native';

import type { CommunityStackParamList, MainTabParamList, RankingStackParamList } from './types';

/**
 * Opening one community post from Home's card (2026-11-07 (3)): that post's
 * existing PostDetail on the member's own community stack — 커뮤니티
 * (beginner, general) or 리그 (season) — without going through the list.
 *
 * As openInMarketTab: `initial: false` pushes the detail onto the stack's
 * list, so a stack never opened before still has its list underneath (no
 * orphan detail, a back button), and `returnTab` makes back (header, Android
 * back, iOS swipe) return to Home through `returnToEntryTab`.
 */
/**
 * PostDetail's header in either community stack. Opened from another tab,
 * back returns there: the arrow alone, and a generic 뒤로 for screen readers
 * instead of the list underneath (커뮤니티 / 리그).
 */
export function postDetailOptions(params: { returnTab?: string } | undefined) {
  return {
    title: '커뮤니티',
    ...(params?.returnTab ? { headerBackTitle: '뒤로', headerBackButtonDisplayMode: 'minimal' as const } : {}),
  };
}

/**
 * One PostDetail per post in either stack (`getId`): Home's card opening
 * another post while one is open pushes its own screen — the open one is
 * never re-used with that post's comment draft, reply target or sheet — and
 * the post already open is brought back instead of stacked twice.
 */
export function postDetailId({ params }: { params?: { postId?: string } }) {
  return params?.postId;
}

export function openCommunityPostFromHome(postId: string, season: boolean): NavigatorScreenParams<MainTabParamList> {
  const detail = { screen: 'PostDetail' as const, params: { postId, returnTab: 'HomeTab' as const }, initial: false };
  return season
    ? { screen: 'RankingTab', params: detail as NavigatorScreenParams<RankingStackParamList> }
    : { screen: 'CommunityTab', params: detail as NavigatorScreenParams<CommunityStackParamList> };
}
