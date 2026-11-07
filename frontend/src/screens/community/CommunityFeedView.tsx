import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useFocusEffect } from '@react-navigation/native';
import { FlatList, ScrollView, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { useCommunityNavigation } from '../../app/navigation/navigationHooks';
import type { CommunityFeedRouteParams } from '../../app/navigation/types';
import {
  COMMUNITY_FEED_CATEGORIES,
  COMMUNITY_PAGE_SIZE,
  getCommunityPosts,
  type CommunityFeedCategory,
} from '../../features/community/api';
import { uniqueById } from '../../features/community/listUtils';
import ActionPressable from '../../components/common/ActionPressable';
import CommunityIcon from '../../components/community/CommunityIcon';
import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import WhaleLoader from '../../components/states/WhaleLoader';
import CommunityPostCard from './CommunityPostCard';
import BannerAdSlot from '../../components/ads/BannerAdSlot';
import { CategoryChip } from './CommunityParts';
import { CommunityNoticeText, type CommunityNotice } from './CommunityNotice';
import { CommunityViewerError, useCommunityViewer, useCommunityWrite } from './useCommunityWrite';
import { useCommunityPostLike } from './useCommunityLikes';

/** A feed older than this is read again when the screen is focused (back from a post). */
const FEED_FOCUS_REFRESH_MS = 30_000;
const HOT_CAPTION = '최근 24시간 동안 반응이 많은 글';

/**
 * The community feed: the 커뮤니티 tab's root and the 리그 tab's 커뮤니티
 * section (the same view, so both behave alike). Chips 전체 · 자유 · 이론 ·
 * HOT; offset pages joined without repeats; 글쓰기 opens the composer after
 * the rules consent, never while the member is restricted.
 */
export default function CommunityFeedView({ request, testID = 'community-feed' }: { request?: CommunityFeedRouteParams; testID?: string }) {
  const navigation = useCommunityNavigation();
  const { colors } = useAppearance();
  const viewer = useCommunityViewer();
  const { userId, canModerate } = viewer;
  const write = useCommunityWrite(userId);
  const [category, setCategory] = useState<CommunityFeedCategory>(request?.category ?? 'all');
  // A failed like, kept whole for the admin diagnostic.
  const [failure, setFailure] = useState<unknown>(null);
  // An entry with a category (Home's HOT card) selects it, again after another chip.
  useEffect(() => {
    if (request?.category) setCategory(request.category);
  }, [request?.category, request?.at]);

  const feed = useInfiniteQuery({
    queryKey: QUERY_KEYS.community.feed(userId ?? '', category),
    queryFn: ({ pageParam, signal }) => getCommunityPosts(category, pageParam, COMMUNITY_PAGE_SIZE, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled: !!userId,
  });
  const posts = useMemo(() => uniqueById(feed.data?.pages), [feed.data]);
  const [now, setNow] = useState(() => Date.now());
  const { refetch, dataUpdatedAt } = feed;
  useFocusEffect(useCallback(() => {
    setNow(Date.now());
    if (userId && dataUpdatedAt && Date.now() - dataUpdatedAt > FEED_FOCUS_REFRESH_MS) void refetch({ cancelRefetch: false });
  }, [dataUpdatedAt, refetch, userId]));
  const refresh = usePullToRefresh([{ ...feed, enabled: !!userId }, { ...write.bootstrap, enabled: !!userId }],
    () => setNow(Date.now()));
  const likes = useCommunityPostLike(userId, write, setFailure);

  const restricted = write.gate.kind === 'restricted' ? write.gate.message : null;
  const notice: CommunityNotice | null = failure ? { error: failure }
    : write.notice && write.notice !== restricted ? { message: write.notice } : null;
  const compose = () => write.requireWrite(() => navigation.navigate('PostCompose', category === 'theory' ? { category: 'theory' } : undefined));
  const empty = category === 'hot' ? '최근 24시간 동안 반응이 많은 글이 아직 없어요.'
    : category === 'all' ? '아직 글이 없어요. 첫 글을 남겨보세요.' : '이 카테고리에는 아직 글이 없어요.';

  // Every community read is keyed by the member: without one, 다시 시도 (never an endless loader).
  if (viewer.failed) {
    return (
      <View testID={testID} style={{ flex: 1, backgroundColor: semantic.screen }}>
        <CommunityViewerError error={viewer.error} onRetry={viewer.retry} />
      </View>
    );
  }

  return (
    <View testID={testID} style={{ flex: 1, backgroundColor: semantic.screen }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: category === 'hot' ? 6 : 10, gap: 6 }}
        accessibilityRole="tablist" accessibilityLabel="커뮤니티 카테고리">
        {COMMUNITY_FEED_CATEGORIES.map((item) => (
          <CategoryChip key={item.key} testID={`community-chip-${item.key}`} category={item.key} label={item.label}
            selected={category === item.key} onPress={() => { setFailure(null); setCategory(item.key); }} />
        ))}
      </ScrollView>
      {category === 'hot' ? (
        <Text testID="community-hot-caption" style={{ fontSize: 12, lineHeight: 16, color: semantic.muted, paddingHorizontal: 16, paddingBottom: 8 }}>
          {HOT_CAPTION}
        </Text>
      ) : null}
      {restricted ? (
        <Text testID="community-restricted" style={{ marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 12,
          backgroundColor: semantic.warningSurface, color: semantic.warning, fontSize: 13, lineHeight: 19 }}>{restricted}</Text>
      ) : null}
      {notice ? (
        <View style={{ marginHorizontal: 16, marginBottom: 8 }}>
          <CommunityNoticeText testID="community-feed-notice" notice={notice} style={{ fontSize: 13, lineHeight: 19, color: semantic.warning }} />
        </View>
      ) : null}
      {/* The list and its 글쓰기 button share one area; the banner (2026-11-07)
          is the band under it, so 글쓰기 sits 24dp above the banner and
          neither covers the list. */}
      <View style={{ flex: 1 }}>
        <FlatList
          testID="community-feed-list"
          data={posts}
          keyExtractor={(post) => post.id}
          refreshControl={refresh.refreshControl}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 104, gap: 8, flexGrow: 1 }}
          onEndReachedThreshold={0.4}
          onEndReached={() => { if (feed.hasNextPage && !feed.isFetchingNextPage && !feed.isError) void feed.fetchNextPage(); }}
          renderItem={({ item }) => (
            <CommunityPostCard post={item} now={now} canModerate={canModerate} likeBusy={likes.isBusy(item.id)}
              onOpen={() => navigation.navigate('PostDetail', { postId: item.id })}
              onOpenAuthor={(authorId) => navigation.navigate('UserSeasonSummary', { userId: authorId })}
              onToggleLike={() => { setFailure(null); likes.toggle(item); }} />
          )}
          ListEmptyComponent={!userId || feed.isLoading ? (
            <WhaleLoader size={32} accessibilityLabel="글을 불러오는 중" style={{ marginTop: 32 }} />
          ) : feed.isError ? (
            <ErrorState error={feed.error} title="글을 불러오지 못했어요." message="잠시 후 다시 시도해주세요."
              onRetry={() => void feed.refetch()} />
          ) : <InlineEmptyState testID="community-feed-empty" message={empty} />}
          ListFooterComponent={feed.isFetchingNextPage ? <WhaleLoader size={24} accessibilityLabel="글을 더 불러오는 중" />
            : feed.isFetchNextPageError ? (
              <ActionPressable testID="community-feed-more-retry" accessibilityRole="button" onPress={() => void feed.fetchNextPage()}
                style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 13, color: semantic.secondaryActionForeground, fontWeight: '600' }}>글을 더 불러오지 못했어요. 다시 시도</Text>
              </ActionPressable>
            ) : null}
        />
        <ActionPressable testID="community-compose" accessibilityRole="button" accessibilityLabel="글쓰기"
          accessibilityState={{ disabled: !!restricted }} aria-disabled={!!restricted} onPress={compose}
          style={{ position: 'absolute', right: 16, bottom: 24, minHeight: 48, borderRadius: 24, paddingHorizontal: 18,
            flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: semantic.inverse, opacity: restricted ? 0.5 : 1,
            shadowColor: '#000', shadowOpacity: 0.16, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 4 }}>
          <CommunityIcon name="pencil" size={18} color={colors.onInverse} />
          <Text style={{ fontSize: 15, lineHeight: 20, fontWeight: '700', color: semantic.onInverse }} maxFontSizeMultiplier={1.4}>글쓰기</Text>
        </ActionPressable>
      </View>
      <BannerAdSlot testID={`${testID}-banner-ad`} />
      {write.rulesSheet}
    </View>
  );
}
