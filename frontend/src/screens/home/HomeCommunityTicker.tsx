import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { Animated, AppState, Platform, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { getMe, type MeDto } from '../../features/me/api';
import { COMMUNITY_HOT_PREVIEW_LIMIT, getCommunityPosts, type CommunityPostDto } from '../../features/community/api';
import { describePostAuthor } from '../../features/community/authorDisplay';
import {
  TICKER_INTERVAL_MS,
  TICKER_SHIFT,
  TICKER_TRANSITION_MS,
  clampTickerIndex,
  nextTickerIndex,
  tickerDisplayIndex,
  tickerShouldRotate,
} from '../../features/community/tickerRotation';
import ActionPressable from '../../components/common/ActionPressable';
import { TierMark } from '../community/CommunityParts';

const SLIDE_HEIGHT = 68;
const PREVIEW_STALE_MS = 60_000;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * Home's HOT community card data: the first three of the community's own HOT
 * list (`GET /community/posts?category=hot&limit=3`), never a separate
 * ranking. Keyed by the signed-in member like every community read.
 */
export function useHomeCommunityHot(enabled: boolean) {
  const me = useQuery<MeDto>({ queryKey: QUERY_KEYS.me, queryFn: getMe, staleTime: 60_000, enabled });
  const userId = me.data?.id ?? null;
  const active = enabled && !!userId;
  const query = useQuery({
    queryKey: QUERY_KEYS.community.hotPreview(userId ?? ''),
    queryFn: ({ signal }) => getCommunityPosts('hot', 0, COMMUNITY_HOT_PREVIEW_LIMIT, signal),
    enabled: active,
    staleTime: PREVIEW_STALE_MS,
  });
  return { query, refreshQuery: { isFetching: query.isFetching, refetch: query.refetch, enabled: active } };
}
export type HomeCommunityHotData = ReturnType<typeof useHomeCommunityHot>;

/**
 * The rolling community card under the total assets (2026-11-07). Hidden
 * when the HOT list is empty or could not be read (Home never breaks for
 * it); a same-height placeholder while it is first read. Tapping opens the
 * community with HOT selected: the 커뮤니티 tab, or 리그 › 커뮤니티 for a
 * season account.
 */
export default function HomeCommunityTicker({ hot, season }: { hot: HomeCommunityHotData; season: boolean }) {
  const { query } = hot;
  const posts = query.data?.items ?? [];
  const focused = useIsFocused();
  const { refetch, dataUpdatedAt } = query;
  // Back on Home: a list older than a minute is read again (no polling).
  useEffect(() => {
    if (focused && dataUpdatedAt && Date.now() - dataUpdatedAt > PREVIEW_STALE_MS) void refetch({ cancelRefetch: false });
  }, [dataUpdatedAt, focused, refetch]);
  if (query.isLoading) {
    return (
      <View testID="home-community-ticker-loading" accessible={false} style={CARD}>
        <View style={{ height: SLIDE_HEIGHT, gap: 10, justifyContent: 'center' }}>
          <View style={{ width: '45%', height: 14, borderRadius: 7, backgroundColor: semantic.raised }} />
          <View style={{ width: '90%', height: 14, borderRadius: 7, backgroundColor: semantic.raised }} />
        </View>
      </View>
    );
  }
  if (!posts.length) return null;
  return <TickerCard posts={posts} season={season} focused={focused} />;
}

const CARD = { backgroundColor: semantic.surface, borderRadius: 16, paddingTop: 14, paddingRight: 36, paddingBottom: 14, paddingLeft: 16 } as const;

function TickerCard({ posts, season, focused }: { posts: CommunityPostDto[]; season: boolean; focused: boolean }) {
  const rootNavigation = useRootNavigation();
  const reduced = useReducedMotion();
  const [appActive, setAppActive] = useState(() => AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  const [pressed, setPressed] = useState(false);
  const [index, setIndex] = useState(0);
  const [previous, setPrevious] = useState<number | null>(null);
  const progress = useRef(new Animated.Value(1)).current;
  const count = posts.length;
  const shown = tickerDisplayIndex(index, count, reduced);
  const rotate = tickerShouldRotate({ count, focused, appActive, pressed, reducedMotion: reduced });

  // One timer at a time, cleared on every pause, change and unmount.
  useEffect(() => {
    if (!rotate) return undefined;
    const timer = setTimeout(() => {
      setPrevious(clampTickerIndex(index, count));
      setIndex((current) => nextTickerIndex(current, count));
    }, TICKER_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [count, index, rotate]);

  // The outgoing post fades while rising; the next one rises in from below.
  useEffect(() => {
    if (previous === null) return undefined;
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1, duration: TICKER_TRANSITION_MS, easing: easeOutCubic, useNativeDriver: Platform.OS !== 'web', isInteraction: false,
    });
    animation.start(({ finished }) => { if (finished) setPrevious(null); });
    return () => animation.stop();
  }, [previous, progress]);

  const post = posts[shown];
  const author = describePostAuthor(post.author);
  const open = () => rootNavigation.navigate('MainTabs', season
    ? { screen: 'RankingTab', params: { screen: 'Ranking', params: { section: 'community', category: 'hot', at: Date.now() }, pop: true } }
    : { screen: 'CommunityTab', params: { screen: 'Community', params: { category: 'hot', at: Date.now() }, pop: true } });
  const outgoing = previous !== null && previous !== shown && previous < count ? posts[previous] : null;
  return (
    <ActionPressable testID="home-community-ticker" accessibilityRole="button"
      accessibilityLabel={`커뮤니티 HOT 글, ${author.name}, 댓글 ${post.commentCount}. ${post.body}`}
      accessibilityHint="커뮤니티 HOT 글 목록을 엽니다." onPress={open}
      onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)} style={CARD}>
      <View style={{ height: SLIDE_HEIGHT, overflow: 'hidden' }}>
        {outgoing ? (
          <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
            transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, -TICKER_SHIFT] }) }] }}>
            <Slide post={outgoing} />
          </Animated.View>
        ) : null}
        <Animated.View testID={`home-community-ticker-slide-${post.id}`} style={outgoing
          ? { position: 'absolute', left: 0, right: 0, top: 0, opacity: progress,
            transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [TICKER_SHIFT, 0] }) }] }
          : { position: 'absolute', left: 0, right: 0, top: 0 }}>
          <Slide post={post} />
        </Animated.View>
      </View>
      {count > 1 ? (
        <View testID="home-community-ticker-dots" pointerEvents="none" accessible={false}
          style={{ position: 'absolute', right: 14, top: 0, bottom: 0, justifyContent: 'center', gap: 6 }}>
          {posts.map((item, position) => (
            <View key={item.id} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: position === shown ? semantic.text : semantic.border }} />
          ))}
        </View>
      ) : null}
    </ActionPressable>
  );
}

function Slide({ post }: { post: CommunityPostDto }) {
  const author = describePostAuthor(post.author);
  return (
    <View style={{ height: SLIDE_HEIGHT, gap: 6 }}>
      <View style={{ height: 20, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View style={{ height: 20, borderRadius: 10, paddingHorizontal: 8, justifyContent: 'center', backgroundColor: semantic.secondaryActionSurface }}>
          <Text maxFontSizeMultiplier={1.3} style={{ fontSize: 11, lineHeight: 14, fontWeight: '700', color: semantic.secondaryActionForeground }}>커뮤니티</Text>
        </View>
        <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={{ fontSize: 13, lineHeight: 18, fontWeight: '700', flexShrink: 1,
          color: author.kind === 'public' ? semantic.text : semantic.muted }}>{author.name}</Text>
        <TierMark tier={author.tier} name={author.tierName} />
        <View style={{ flex: 1 }} />
        <Text maxFontSizeMultiplier={1.3} style={{ fontSize: 12, lineHeight: 16, color: semantic.muted }}>댓글 {post.commentCount}</Text>
      </View>
      <Text numberOfLines={2} maxFontSizeMultiplier={1.3} style={{ fontSize: 14, lineHeight: 21, color: semantic.text }}>{post.body}</Text>
    </View>
  );
}
