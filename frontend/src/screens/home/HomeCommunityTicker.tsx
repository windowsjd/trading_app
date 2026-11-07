import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { Animated, AppState, Platform, Text, View, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { openCommunityPostFromHome } from '../../app/navigation/communityPostEntry';
import { getMe, type MeDto } from '../../features/me/api';
import { COMMUNITY_HOT_PREVIEW_LIMIT, getCommunityPosts, type CommunityPostDto } from '../../features/community/api';
import { describePostAuthor } from '../../features/community/authorDisplay';
import {
  HOME_COMMUNITY_EMPTY_MESSAGE,
  HOME_COMMUNITY_UNAVAILABLE_MESSAGE,
  homeCommunityCard,
  homeCommunityCategory,
  needsLatestPreview,
} from '../../features/community/homeCommunityCard';
import {
  TICKER_FONT_CAP,
  TICKER_INTERVAL_MS,
  TICKER_SHIFT,
  TICKER_TRANSITION_MS,
  clampTickerIndex,
  nextTickerIndex,
  tickerDisplayIndex,
  tickerShouldRotate,
  tickerSlideLayout,
} from '../../features/community/tickerRotation';
import ActionPressable from '../../components/common/ActionPressable';
import CommunityIcon from '../../components/community/CommunityIcon';
import { TierMark } from '../community/CommunityParts';

const PREVIEW_STALE_MS = 60_000;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * Home's community card data. First the community's own HOT list
 * (`GET /community/posts?category=hot&limit=3`), never a separate ranking;
 * only when that list is empty, 전체's first posts (`category=all&limit=3`)
 * as plain posts. Both are keyed by the signed-in member like every
 * community read, and neither is read again within a minute.
 */
export function useHomeCommunityHot(enabled: boolean) {
  const me = useQuery<MeDto>({ queryKey: QUERY_KEYS.me, queryFn: getMe, staleTime: 60_000, enabled });
  const userId = me.data?.id ?? null;
  const active = enabled && !!userId;
  const hot = useQuery({
    queryKey: QUERY_KEYS.community.hotPreview(userId ?? ''),
    queryFn: ({ signal }) => getCommunityPosts('hot', 0, COMMUNITY_HOT_PREVIEW_LIMIT, signal),
    enabled: active,
    staleTime: PREVIEW_STALE_MS,
  });
  const latestActive = active && needsLatestPreview(hot.data);
  const latest = useQuery({
    queryKey: QUERY_KEYS.community.latestPreview(userId ?? ''),
    queryFn: ({ signal }) => getCommunityPosts('all', 0, COMMUNITY_HOT_PREVIEW_LIMIT, signal),
    enabled: latestActive,
    staleTime: PREVIEW_STALE_MS,
  });
  const card = homeCommunityCard({ page: hot.data, failed: hot.isError }, { page: latest.data, failed: latest.isError },
    !userId && me.isError);
  const { refetch: refetchHot } = hot;
  const { refetch: refetchLatest } = latest;
  const fetching = hot.isFetching || latest.isFetching;
  // Home's pull to refresh: HOT again, then the latest posts if HOT is (still) empty.
  const refreshQuery = useMemo(() => ({
    isFetching: fetching,
    refetch: async (options?: { cancelRefetch?: boolean }) => {
      const result = await refetchHot(options);
      if (needsLatestPreview(result.data)) await refetchLatest(options);
    },
    enabled: active,
  }), [active, fetching, refetchHot, refetchLatest]);
  return { card, hot, latest, latestActive, refreshQuery };
}
export type HomeCommunityHotData = ReturnType<typeof useHomeCommunityHot>;

/**
 * The rolling community card under the total assets (2026-11-07): HOT posts,
 * else the latest posts (same layout, no HOT mark), else an invitation to
 * write the first post. A failed read shows only the way into the community
 * (never "no posts"; Home never breaks for it); a same-height placeholder
 * while it is first read. Tapping a post opens THAT post's detail
 * (2026-11-07 (3)) on the member's community stack — the 커뮤니티 tab, or
 * 리그 for a season account — and back returns to Home; the invitation and
 * the way-in still open the list (전체).
 */
export default function HomeCommunityTicker({ hot: data, season }: { hot: HomeCommunityHotData; season: boolean }) {
  const { card, hot, latest, latestActive } = data;
  const focused = useIsFocused();
  const rootNavigation = useRootNavigation();
  // 68dp at the default font size; taller with larger system fonts (up to the card's cap).
  const layout = tickerSlideLayout(useWindowDimensions().fontScale);
  // Back on Home: a list last read (or last failed) over a minute ago is read
  // again (no polling). The latest posts only while they are the fallback in use.
  const { refetch: refetchHot } = hot;
  const hotReadAt = Math.max(hot.dataUpdatedAt, hot.errorUpdatedAt);
  useEffect(() => {
    if (focused && hotReadAt && Date.now() - hotReadAt > PREVIEW_STALE_MS) void refetchHot({ cancelRefetch: false });
  }, [focused, hotReadAt, refetchHot]);
  const { refetch: refetchLatest } = latest;
  const latestReadAt = Math.max(latest.dataUpdatedAt, latest.errorUpdatedAt);
  useEffect(() => {
    if (focused && latestActive && latestReadAt && Date.now() - latestReadAt > PREVIEW_STALE_MS) void refetchLatest({ cancelRefetch: false });
  }, [focused, latestActive, latestReadAt, refetchLatest]);

  if (card.kind === 'loading') {
    return (
      <View testID="home-community-ticker-loading" accessible={false} style={CARD}>
        <View style={{ height: layout.height, gap: 10, justifyContent: 'center' }}>
          <View style={{ width: '45%', height: 14, borderRadius: 7, backgroundColor: semantic.raised }} />
          <View style={{ width: '90%', height: 14, borderRadius: 7, backgroundColor: semantic.raised }} />
        </View>
      </View>
    );
  }
  if (card.kind === 'hot' || card.kind === 'latest') {
    // Keyed by kind: HOT replacing the latest posts (or back) starts at its own first post.
    return <TickerCard key={card.kind} kind={card.kind} posts={card.posts} focused={focused} layout={layout}
      onOpenPost={(postId) => rootNavigation.navigate('MainTabs', openCommunityPostFromHome(postId, season))} />;
  }
  const category = homeCommunityCategory(card);
  const open = () => rootNavigation.navigate('MainTabs', season
    ? { screen: 'RankingTab', params: { screen: 'Ranking', params: { section: 'community', category, at: Date.now() }, pop: true } }
    : { screen: 'CommunityTab', params: { screen: 'Community', params: { category, at: Date.now() }, pop: true } });
  return <InvitationCard kind={card.kind} layout={layout} onOpen={open} />;
}

const CARD = { backgroundColor: semantic.surface, borderRadius: 16, paddingTop: 14, paddingRight: 36, paddingBottom: 14, paddingLeft: 16 } as const;
const SPOKEN = {
  hot: { name: '커뮤니티 HOT 글', hint: '이 글의 본문과 댓글을 엽니다.' },
  latest: { name: '커뮤니티 최신 글', hint: '이 글의 본문과 댓글을 엽니다.' },
} as const;

type SlideLayout = ReturnType<typeof tickerSlideLayout>;

function TickerCard({ kind, posts, focused, layout, onOpenPost }: {
  kind: 'hot' | 'latest'; posts: CommunityPostDto[]; focused: boolean; layout: SlideLayout; onOpenPost: (postId: string) => void;
}) {
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
  const transitionStartedAt = useRef(0);
  useEffect(() => {
    if (previous === null) return undefined;
    transitionStartedAt.current = performance.now();
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1, duration: TICKER_TRANSITION_MS, easing: easeOutCubic, useNativeDriver: Platform.OS !== 'web', isInteraction: false,
    });
    animation.start(({ finished }) => { if (finished) setPrevious(null); });
    return () => animation.stop();
  }, [previous, progress]);

  const post = posts[shown];
  const author = describePostAuthor(post.author);
  const outgoing = previous !== null && previous !== shown && previous < count ? posts[previous] : null;
  // The post a tap opens is the one on screen when the finger went down. A
  // transition in progress settles at once on whichever post was more
  // visible, and the press holds the rotation, so the release always opens
  // the post the card shows — never one that rotated in meanwhile.
  const target = useRef<string | null>(null);
  const pressIn = () => {
    setPressed(true);
    let id = post.id;
    if (outgoing && previous !== null) {
      if (performance.now() - transitionStartedAt.current < TICKER_TRANSITION_MS / 2) {
        id = outgoing.id;
        setIndex(previous);
      }
      progress.stopAnimation();
      progress.setValue(1);
      setPrevious(null);
    }
    target.current = id;
  };
  // A screen reader's activation has no press-in: it opens the announced post.
  const press = () => {
    const id = target.current ?? post.id;
    target.current = null;
    onOpenPost(id);
  };
  // A release calls onPress right after onPressOut (or before it, for a quick
  // tap); a touch that became a scroll gets onPressOut only — its target must
  // not outlive it.
  const pressOut = () => {
    setPressed(false);
    setTimeout(() => { target.current = null; }, 0);
  };
  return (
    <ActionPressable testID="home-community-ticker" accessibilityRole="button"
      accessibilityLabel={`${SPOKEN[kind].name}, ${author.name}, 댓글 ${post.commentCount}. ${post.body}`}
      accessibilityHint={SPOKEN[kind].hint} onPress={press}
      onPressIn={pressIn} onPressOut={pressOut} style={CARD}>
      <View style={{ height: layout.height, overflow: 'hidden' }}>
        {outgoing ? (
          <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
            transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, -TICKER_SHIFT] }) }] }}>
            <Slide post={outgoing} layout={layout} />
          </Animated.View>
        ) : null}
        <Animated.View testID={`home-community-ticker-slide-${post.id}`} style={outgoing
          ? { position: 'absolute', left: 0, right: 0, top: 0, opacity: progress,
            transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [TICKER_SHIFT, 0] }) }] }
          : { position: 'absolute', left: 0, right: 0, top: 0 }}>
          <Slide post={post} layout={layout} />
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

function CommunityPill() {
  return (
    <View style={{ height: 20, borderRadius: 10, paddingHorizontal: 8, justifyContent: 'center', backgroundColor: semantic.secondaryActionSurface }}>
      <Text maxFontSizeMultiplier={TICKER_FONT_CAP} style={{ fontSize: 11, lineHeight: 14, fontWeight: '700', color: semantic.secondaryActionForeground }}>커뮤니티</Text>
    </View>
  );
}

/** One post, centered vertically in the slide (2026-11-07 (3)); lines still start at the left. */
function Slide({ post, layout }: { post: CommunityPostDto; layout: SlideLayout }) {
  const author = describePostAuthor(post.author);
  return (
    <View style={{ height: layout.height, gap: 6, justifyContent: 'center' }}>
      <View style={{ height: layout.row, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <CommunityPill />
        <Text numberOfLines={1} maxFontSizeMultiplier={TICKER_FONT_CAP} style={{ fontSize: 13, lineHeight: 18, fontWeight: '700', flexShrink: 1,
          color: author.kind === 'public' ? semantic.text : semantic.muted }}>{author.name}</Text>
        <TierMark tier={author.tier} name={author.tierName} maxFontSizeMultiplier={TICKER_FONT_CAP} />
        <View style={{ flex: 1 }} />
        <Text numberOfLines={1} maxFontSizeMultiplier={TICKER_FONT_CAP} style={{ fontSize: 12, lineHeight: 16, color: semantic.muted, flexShrink: 0 }}>
          댓글 {post.commentCount}</Text>
      </View>
      <Text numberOfLines={2} maxFontSizeMultiplier={TICKER_FONT_CAP} style={{ fontSize: 14, lineHeight: 21, color: semantic.text }}>{post.body}</Text>
    </View>
  );
}

/** No post to show: the first-post invitation, or (a failed read) only the way in. Same box as a post. */
function InvitationCard({ kind, layout, onOpen }: { kind: 'empty' | 'unavailable'; layout: SlideLayout; onOpen: () => void }) {
  const { colors } = useAppearance();
  const message = kind === 'empty' ? HOME_COMMUNITY_EMPTY_MESSAGE : HOME_COMMUNITY_UNAVAILABLE_MESSAGE;
  return (
    <ActionPressable testID={`home-community-${kind}`} accessibilityRole="button" accessibilityLabel={message}
      accessibilityHint="커뮤니티를 엽니다." onPress={onOpen} style={CARD}>
      <View style={{ height: layout.height, gap: 6, justifyContent: 'center' }}>
        <View style={{ height: layout.row, flexDirection: 'row', alignItems: 'center' }}>
          <CommunityPill />
        </View>
        <Text numberOfLines={2} maxFontSizeMultiplier={TICKER_FONT_CAP} style={{ fontSize: 14, lineHeight: 21, color: semantic.text }}>{message}</Text>
      </View>
      <View pointerEvents="none" accessible={false}
        style={{ position: 'absolute', right: 12, top: 0, bottom: 0, justifyContent: 'center' }}>
        <CommunityIcon name="chevron" size={16} color={colors.muted} />
      </View>
    </ActionPressable>
  );
}
