import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useHeaderHeight } from '@react-navigation/elements';
import { useFocusEffect } from '@react-navigation/native';
import {
  FlatList, Image, Keyboard, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View,
  type NativeScrollEvent, type NativeSyntheticEvent,
} from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { useCommunityNavigation, useRootNavigation } from '../../app/navigation/navigationHooks';
import { openInMarketTab } from '../../app/navigation/marketTabEntry';
import {
  COMMUNITY_LIMITS,
  createCommunityComment,
  deleteCommunityComment,
  deleteCommunityPost,
  getCommunityComments,
  getCommunityPost,
  removeCommunityComment,
  removeCommunityPost,
  reportCommunityTarget,
  setCommunityCommentLike,
  type CommunityCommentDto,
  type CommunityCommentSort,
  type CommunityPage,
  type CommunityPostDto,
  type CommunityReasonCode,
} from '../../features/community/api';
import { describeCommentAuthor, describePostAuthor } from '../../features/community/authorDisplay';
import { dropCommunityPost, patchCommunityPost, refreshCommunityLists } from '../../features/community/communityCache';
import { communityTextLength, formatCommunityTime } from '../../features/community/format';
import { commentAnonymityLocked } from '../../features/community/gates';
import { containsBlockedLink } from '../../features/community/linkCheck';
import { replyTargetId, uniqueById, withLike } from '../../features/community/listUtils';
import { createIdempotencyKey } from '../../utils/idempotency';
import { getApiErrorCode, getApiErrorInfo } from '../../services/api/errorMapper';
import ActionPressable from '../../components/common/ActionPressable';
import TopNoticeBanner from '../../components/common/TopNoticeBanner';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import CommunityIcon from '../../components/community/CommunityIcon';
import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import WhaleLoader from '../../components/states/WhaleLoader';
import CTAButton from '../../components/common/CTAButton';
import { AssetTagChip, CommunityAvatar, CountButton, PostAuthorTag, TierMark } from './CommunityParts';
import { CommunityNoticeText, type CommunityNotice } from './CommunityNotice';
import { AccountManageSheet, ActionList, CommunitySheet, ModerationSheet, ReportSheet, type SheetAction } from './CommunitySheets';
import { CommunityViewerError, useCommunityViewer, useCommunityWrite } from './useCommunityWrite';
import { useCommunityPostLike } from './useCommunityLikes';

type CommentPages = InfiniteData<CommunityPage<CommunityCommentDto>, number>;
type Target = { kind: 'post'; post: CommunityPostDto } | { kind: 'comment'; comment: CommunityCommentDto };
type Sheet =
  | { kind: 'menu'; target: Target }
  | { kind: 'admin'; target: Target }
  | { kind: 'confirm-delete'; target: Target }
  | { kind: 'report'; target: Target }
  | { kind: 'moderate'; target: Target }
  | { kind: 'account'; userId: string }
  | null;
type Reply = { id: string; name: string } | null;
const SORTS: readonly { key: CommunityCommentSort; label: string }[] = [
  { key: 'latest', label: '최신순' },
  { key: 'likes', label: '좋아요순' },
];
const REPORTED = { id: 'reported', title: '신고가 접수되었어요', detail: null };

/**
 * 글 상세 (contract §5.3): the post, its photos (paged), likes and the
 * comment thread with 최신순 · 좋아요순. The comment bar keeps 익명 on (locked)
 * for the anonymous post's own author. ⋯ offers 삭제 (mine), 신고 (others')
 * and, to operators, the removal with a reason and 계정 관리.
 */
export default function PostDetailScreen({ route }: { route: { params: { postId: string } } }) {
  const { postId } = route.params;
  const navigation = useCommunityNavigation();
  const rootNavigation = useRootNavigation();
  const client = useQueryClient();
  const { colors } = useAppearance();
  const headerHeight = useHeaderHeight();
  const member = useCommunityViewer();
  const { userId, canModerate } = member;
  const viewer = userId ?? '';
  const write = useCommunityWrite(userId);
  const reasons = write.bootstrap.data?.reasons ?? [];
  const [sort, setSort] = useState<CommunityCommentSort>('latest');
  const [sheet, setSheet] = useState<Sheet>(null);
  // Local copy, or a failed request kept whole for the admin diagnostic.
  const [notice, setNotice] = useState<CommunityNotice | null>(null);
  const showFailure = useCallback((error: unknown) => setNotice({ error }), []);
  const [banner, setBanner] = useState<typeof REPORTED | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastTarget = useRef<Target | null>(null);

  const postQuery = useQuery({
    queryKey: QUERY_KEYS.community.post(viewer, postId),
    queryFn: ({ signal }) => getCommunityPost(postId, signal),
    enabled: !!userId,
  });
  const comments = useInfiniteQuery({
    queryKey: QUERY_KEYS.community.comments(viewer, postId, sort),
    queryFn: ({ pageParam, signal }) => getCommunityComments(postId, sort, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled: !!userId && !!postQuery.data,
  });
  const items = useMemo(() => uniqueById(comments.data?.pages), [comments.data]);
  const post = postQuery.data ?? null;
  const gone = getApiErrorCode(postQuery.error) === 'COMMUNITY_POST_NOT_FOUND';

  useFocusEffect(useCallback(() => setNow(Date.now()), []));
  const refresh = usePullToRefresh([{ ...postQuery, enabled: !!userId }, { ...comments, enabled: !!post }], () => setNow(Date.now()));
  const likes = useCommunityPostLike(userId, write, showFailure);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: post ? () => (
        <ActionPressable testID="community-post-more" accessibilityRole="button" accessibilityLabel="더보기"
          onPress={() => setSheet({ kind: 'menu', target: { kind: 'post', post } })}
          style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <CommunityIcon name="more" size={22} color={colors.text} />
        </ActionPressable>
      ) : undefined,
    });
  }, [colors.text, navigation, post]);

  const patchComments = useCallback((update: (comment: CommunityCommentDto) => CommunityCommentDto) => {
    client.setQueriesData<CommentPages>({ queryKey: ['community', 'comments', viewer, postId] }, (data) => data && {
      ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map(update) })),
    });
  }, [client, postId, viewer]);

  // Comment likes: shown at once, confirmed or undone by the server, one request at a time each.
  const commentBusy = useRef(new Set<string>());
  const [, setRevision] = useState(0);
  const toggleCommentLike = (comment: CommunityCommentDto) => {
    if (comment.deleted || comment.mine || commentBusy.current.has(comment.id)) return;
    const liked = !comment.likedByMe;
    const run = () => {
      commentBusy.current.add(comment.id);
      setRevision((value) => value + 1);
      patchComments((item) => (item.id === comment.id ? withLike(item, liked) : item));
      setCommunityCommentLike(comment.id, liked)
        .then(({ likeCount }) => patchComments((item) => (item.id === comment.id ? { ...item, likedByMe: liked, likeCount } : item)))
        .catch((error: unknown) => {
          patchComments((item) => (item.id === comment.id ? withLike(item, !liked) : item));
          write.handleWriteError(error);
          setNotice({ error });
        })
        .finally(() => { commentBusy.current.delete(comment.id); setRevision((value) => value + 1); });
    };
    if (liked) write.requireWrite(run);
    else run();
  };

  // The comment bar.
  const [text, setText] = useState('');
  const [anonymousChoice, setAnonymous] = useState(false);
  const [reply, setReply] = useState<Reply>(null);
  const attempt = useRef<{ key: string; body: string; anonymous: boolean; parent: string | null } | null>(null);
  const locked = commentAnonymityLocked(post);
  const anonymous = locked || anonymousChoice;
  const maxLength = write.bootstrap.data?.commentBodyMaxLength ?? COMMUNITY_LIMITS.commentBody;
  const restricted = write.gate.kind === 'restricted' ? write.gate.message : null;
  const send = useMutation({
    mutationFn: (draft: { key: string; body: string; anonymous: boolean; parent: string | null }) =>
      createCommunityComment(postId, { clientRequestId: draft.key, body: draft.body, anonymous: draft.anonymous, parentCommentId: draft.parent }),
    retry: false,
    onSuccess: ({ comment, replayed }) => {
      attempt.current = null;
      setText(''); setReply(null); setNotice(null);
      Keyboard.dismiss();
      if (!replayed) patchCommunityPost(client, viewer, postId, (current) => ({ ...current, commentCount: current.commentCount + 1 }));
      // The new comment's place depends on the sort: read the thread again.
      void client.invalidateQueries({ queryKey: ['community', 'comments', viewer, postId] });
      if (comment.parentCommentId === null && sort !== 'latest') setSort('latest');
    },
    onError: (error) => {
      const info = getApiErrorInfo(error);
      // An unknown result keeps the same request id: sending again replays instead of posting twice.
      if (info.hasResponse && (info.status ?? 500) < 500) attempt.current = null;
      write.handleWriteError(error);
      setNotice({ error });
    },
  });
  const body = text.trim();
  const tooLong = communityTextLength(text) > maxLength;
  const canSend = !!body && !tooLong && !send.isPending && !restricted && !!post;
  const submitComment = () => {
    if (!canSend) return;
    if (containsBlockedLink(body)) { setNotice({ message: '링크나 오픈채팅·메신저 주소는 올릴 수 없어요.' }); return; }
    write.requireWrite(() => {
      const parent = reply?.id ?? null;
      const previous = attempt.current;
      const same = previous && previous.body === body && previous.anonymous === anonymous && previous.parent === parent;
      const draft = same ? previous : { key: createIdempotencyKey('community_comment'), body, anonymous, parent };
      attempt.current = draft;
      setNotice(null);
      send.mutate(draft);
    });
  };

  // The tagged asset opens in the Market tab; back returns to this tab (리그 or 커뮤니티).
  const openAsset = (assetId: string) => {
    const tabs = navigation.getParent()?.getState();
    const returnTab = tabs?.routes[tabs.index]?.name === 'RankingTab' ? 'RankingTab' : 'CommunityTab';
    rootNavigation.navigate('MainTabs', openInMarketTab('AssetDetail', { assetId, returnTab }));
  };

  // ⋯ actions.
  const closeSheet = () => setSheet(null);
  const report = useMutation({
    mutationFn: (input: { target: Target; reason: CommunityReasonCode }) => reportCommunityTarget({
      targetType: input.target.kind, reason: input.reason,
      targetId: input.target.kind === 'post' ? input.target.post.id : input.target.comment.id,
    }),
    retry: false,
    onSuccess: () => { setSheet(null); setBanner(REPORTED); },
    onError: (error) => { write.handleWriteError(error); },
  });
  const removeOwn = useMutation({
    mutationFn: async (target: Target) => (target.kind === 'post'
      ? { post: await deleteCommunityPost(target.post.id) }
      : { comment: await deleteCommunityComment(target.comment.id) }),
    retry: false,
    onSuccess: (result) => {
      setSheet(null);
      if ('post' in result) {
        dropCommunityPost(client, viewer, postId);
        refreshCommunityLists(client, viewer);
        navigation.goBack();
        return;
      }
      patchComments((item) => (item.id === result.comment.id ? result.comment : item));
      patchCommunityPost(client, viewer, postId, (current) => ({ ...current, commentCount: Math.max(0, current.commentCount - 1) }));
    },
    onError: (error) => { setSheet(null); setNotice({ error }); },
  });
  const moderate = useMutation({
    mutationFn: (input: { target: Target; reason: CommunityReasonCode; note?: string }) => input.target.kind === 'post'
      ? removeCommunityPost(input.target.post.id, { reason: input.reason, note: input.note })
      : removeCommunityComment(input.target.comment.id, { reason: input.reason, note: input.note }),
    retry: false,
    onSuccess: ({ removal }) => {
      setSheet(null);
      refreshCommunityLists(client, viewer);
      if (removal.targetType === 'post') {
        dropCommunityPost(client, viewer, postId);
        navigation.goBack();
        return;
      }
      void client.invalidateQueries({ queryKey: ['community', 'comments', viewer, postId] });
      void client.invalidateQueries({ queryKey: QUERY_KEYS.community.post(viewer, postId) });
    },
  });

  const menuActions = (target: Target): SheetAction[] => {
    const mine = target.kind === 'post' ? target.post.mine : target.comment.mine;
    const actions: SheetAction[] = [];
    if (mine) actions.push({ key: 'delete', label: '삭제', danger: true, onPress: () => setSheet({ kind: 'confirm-delete', target }) });
    else actions.push({ key: 'report', label: '신고', onPress: () => {
      report.reset();
      setSheet(null);
      write.requireWrite(() => setSheet({ kind: 'report', target }));
    } });
    if (canModerate) actions.push({ key: 'admin', label: '관리자 메뉴', admin: true, chevron: true, onPress: () => setSheet({ kind: 'admin', target }) });
    return actions;
  };
  const authorOf = (target: Target): string | null => {
    if (target.kind === 'post') return target.post.author.kind === 'public' ? target.post.author.userId : target.post.adminAuthor?.userId ?? null;
    const author = target.comment.author;
    return author?.kind === 'public' ? author.userId : target.comment.adminAuthor?.userId ?? null;
  };
  const adminActions = (target: Target): SheetAction[] => {
    const authorId = authorOf(target);
    return [
      { key: 'remove', label: target.kind === 'post' ? '이 글 삭제' : '이 댓글 삭제', danger: true, onPress: () => { moderate.reset(); setSheet({ kind: 'moderate', target }); } },
      ...(authorId ? [{ key: 'account', label: '작성자 계정 관리', chevron: true, onPress: () => setSheet({ kind: 'account', userId: authorId }) }] : []),
    ];
  };

  if (member.failed) return <CommunityViewerError error={member.error} onRetry={member.retry} />;
  if (!userId || postQuery.isLoading) {
    return <View style={{ flex: 1, backgroundColor: semantic.screen, justifyContent: 'center' }}><WhaleLoader size={36} accessibilityLabel="글을 불러오는 중" /></View>;
  }
  if (!post) {
    return gone ? (
      <View testID="community-post-gone" style={{ flex: 1, backgroundColor: semantic.screen, padding: 16, gap: 12 }}>
        <InlineEmptyState title="삭제되었거나 볼 수 없는 글이에요." />
        <CTAButton variant="neutral" label="목록으로" onPress={() => { dropCommunityPost(client, viewer, postId); navigation.goBack(); }} />
      </View>
    ) : (
      <ErrorState error={postQuery.error} title="글을 불러오지 못했어요." message="잠시 후 다시 시도해주세요." onRetry={() => void postQuery.refetch()} />
    );
  }

  // A closing sheet keeps showing its target until it has slid away.
  const target = sheet && 'target' in sheet ? sheet.target : lastTarget.current;
  if (sheet && 'target' in sheet) lastTarget.current = sheet.target;
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: semantic.screen }}>
      <KeyboardAvoidingView style={{ flex: 1 }} keyboardVerticalOffset={headerHeight} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <FlatList
          testID="community-post-detail"
          data={items}
          keyExtractor={(item) => item.id}
          refreshControl={refresh.refreshControl}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 16 }}
          onEndReachedThreshold={0.4}
          onEndReached={() => { if (comments.hasNextPage && !comments.isFetchingNextPage && !comments.isError) void comments.fetchNextPage(); }}
          ListHeaderComponent={(
            <PostBody post={post} now={now} canModerate={canModerate} likeBusy={likes.isBusy(post.id)}
              onLike={() => { setNotice(null); likes.toggle(post); }}
              onOpenAuthor={(authorId) => navigation.navigate('UserSeasonSummary', { userId: authorId })}
              onOpenAccount={(authorId) => setSheet({ kind: 'account', userId: authorId })}
              onOpenAsset={openAsset}
              sort={sort} onSort={setSort} />
          )}
          renderItem={({ item }) => (
            <CommentRow comment={item} now={now} canModerate={canModerate} busy={commentBusy.current.has(item.id)}
              onLike={() => { setNotice(null); toggleCommentLike(item); }}
              onReply={() => { const display = describeCommentAuthor(item); setReply({ id: replyTargetId(item), name: display.name }); }}
              onMore={() => setSheet({ kind: 'menu', target: { kind: 'comment', comment: item } })}
              onOpenAuthor={(authorId) => navigation.navigate('UserSeasonSummary', { userId: authorId })}
              onOpenAccount={(authorId) => setSheet({ kind: 'account', userId: authorId })} />
          )}
          ListEmptyComponent={comments.isLoading ? <WhaleLoader size={24} accessibilityLabel="댓글을 불러오는 중" />
            : comments.isError ? (
              <ActionPressable testID="community-comments-retry" accessibilityRole="button" onPress={() => void comments.refetch()}
                style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 13, color: semantic.secondaryActionForeground, fontWeight: '600' }}>댓글을 불러오지 못했어요. 다시 시도</Text>
              </ActionPressable>
            ) : <Text testID="community-comments-empty" style={{ fontSize: 13, color: semantic.muted, paddingHorizontal: 16, paddingVertical: 20 }}>첫 댓글을 남겨보세요.</Text>}
          ListFooterComponent={comments.isFetchingNextPage ? <WhaleLoader size={22} accessibilityLabel="댓글을 더 불러오는 중" /> : null}
        />
        <View style={{ borderTopWidth: 1, borderTopColor: semantic.border, backgroundColor: semantic.surface }}>
          {notice ? (
            <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
              <CommunityNoticeText testID="community-detail-notice" notice={notice} style={{ fontSize: 13, lineHeight: 19, color: semantic.warning }} />
            </View>
          ) : null}
          {restricted ? <Text testID="community-detail-restricted" style={{ fontSize: 13, lineHeight: 19, color: semantic.warning,
            paddingHorizontal: 16, paddingTop: 8 }}>{restricted}</Text> : null}
          {reply ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
              <Text testID="community-reply-to" style={{ flex: 1, fontSize: 12, lineHeight: 17, color: semantic.secondary }}>{reply.name}에게 답글 남기는 중</Text>
              <ActionPressable testID="community-reply-cancel" accessibilityRole="button" accessibilityLabel="답글 취소" onPress={() => setReply(null)}
                style={{ minHeight: 32, justifyContent: 'center' }}>
                <Text style={{ fontSize: 12, fontWeight: '600', color: semantic.secondaryActionForeground }}>취소</Text>
              </ActionPressable>
            </View>
          ) : null}
          <View style={{ minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 12 }}>
            <TextInput testID="community-comment-input" accessibilityLabel="댓글 입력" value={text} onChangeText={setText}
              editable={!restricted && !send.isPending} placeholder={reply ? '답글을 입력하세요' : '댓글을 입력하세요'} multiline
              maxLength={maxLength + 50}
              style={{ flex: 1, minHeight: 44, maxHeight: 120, borderRadius: 22, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
                fontSize: 15, lineHeight: 20, backgroundColor: semantic.input }} />
            <ActionPressable feedback="selection" testID="community-comment-anonymous" accessibilityRole="checkbox"
              accessibilityLabel={locked ? '익명, 글쓴이는 익명으로만 댓글을 써요' : '익명'}
              accessibilityState={{ checked: anonymous, disabled: locked || !!restricted }} aria-checked={anonymous}
              disabled={locked || !!restricted} onPress={() => setAnonymous((value) => !value)}
              style={{ minHeight: 44, borderRadius: 22, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 4,
                backgroundColor: anonymous ? semantic.inverse : semantic.input, opacity: locked ? 0.85 : 1 }}>
              {anonymous ? <CommunityIcon name="check" size={14} color={colors.onInverse} strokeWidth={2.4} /> : null}
              <Text style={{ fontSize: 13, fontWeight: '700', color: anonymous ? semantic.onInverse : semantic.secondary }} maxFontSizeMultiplier={1.4}>익명</Text>
            </ActionPressable>
            <ActionPressable testID="community-comment-send" accessibilityRole="button" accessibilityLabel="댓글 보내기"
              accessibilityState={{ disabled: !canSend, busy: send.isPending }} aria-disabled={!canSend} disabled={!canSend}
              onPress={submitComment}
              style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
                backgroundColor: canSend ? semantic.inverse : semantic.input }}>
              {send.isPending ? <WhaleLoader size={20} tone="onAction" />
                : <CommunityIcon name="send" size={20} color={canSend ? colors.onInverse : colors.muted} strokeWidth={2.2} />}
            </ActionPressable>
          </View>
          {tooLong ? <Text style={{ fontSize: 12, color: semantic.warning, paddingHorizontal: 16, paddingBottom: 8 }}>
            댓글은 {maxLength}자까지 쓸 수 있어요.</Text> : null}
        </View>
      </KeyboardAvoidingView>

      <CommunitySheet testID="community-menu-sheet" title={target?.kind === 'comment' ? '댓글' : '글'} visible={sheet?.kind === 'menu'} onClose={closeSheet}>
        {target ? <ActionList testID="community-menu" actions={menuActions(target)} /> : null}
      </CommunitySheet>
      <CommunitySheet testID="community-admin-sheet" title="관리자 메뉴" admin visible={sheet?.kind === 'admin'} onClose={closeSheet}>
        {target ? <ActionList testID="community-admin" actions={adminActions(target)} /> : null}
      </CommunitySheet>
      <CommunitySheet testID="community-delete-sheet" title={target?.kind === 'comment' ? '댓글을 삭제할까요?' : '글을 삭제할까요?'}
        visible={sheet?.kind === 'confirm-delete'} onClose={closeSheet} dismissible={!removeOwn.isPending}>
        <Text style={{ fontSize: 14, lineHeight: 20, color: semantic.secondary }}>삭제하면 되돌릴 수 없어요.</Text>
        <ActionPressable testID="community-delete-confirm" accessibilityRole="button" accessibilityLabel="삭제"
          disabled={removeOwn.isPending} onPress={() => { if (target) removeOwn.mutate(target); }}
          style={{ minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: semantic.alert }}>
          {removeOwn.isPending ? <WhaleLoader size={22} tone="onAction" /> : <Text style={{ fontSize: 16, fontWeight: '700', color: semantic.onAlert }}>삭제</Text>}
        </ActionPressable>
      </CommunitySheet>
      <ReportSheet visible={sheet?.kind === 'report'} reasons={reasons} busy={report.isPending}
        error={report.isError ? report.error : null}
        onSubmit={(reason) => { if (target) report.mutate({ target, reason }); }} onClose={closeSheet} />
      <ModerationSheet visible={sheet?.kind === 'moderate'} target={target?.kind ?? 'post'} reasons={reasons} busy={moderate.isPending}
        error={moderate.isError ? moderate.error : null}
        onConfirm={(reason, note) => { if (target) moderate.mutate({ target, reason, note }); }} onClose={closeSheet} />
      <AccountManageSheet visible={sheet?.kind === 'account'} viewerId={viewer} targetUserId={sheet?.kind === 'account' ? sheet.userId : null}
        reasons={reasons} onClose={closeSheet} onChanged={() => {
          refreshCommunityLists(client, viewer);
          void client.invalidateQueries({ queryKey: ['community', 'comments', viewer, postId] });
          void client.invalidateQueries({ queryKey: QUERY_KEYS.community.post(viewer, postId) });
        }} />
      {write.rulesSheet}
      <SheetPortal>
        <TopNoticeBanner channel="community-report" notice={banner} visibleMs={2600} heldMs={2600}
          icon={{ glyph: '✓', tone: 'success' }} actionLabel="확인" actionTestID="community-report-banner-close"
          notOpened={{ held: '', unavailable: '' }} testID="community-report-banner"
          onAction={() => 'opened'} onDone={() => setBanner(null)} />
      </SheetPortal>
    </SafeAreaView>
  );
}

function PostBody({ post, now, canModerate, likeBusy, onLike, onOpenAuthor, onOpenAccount, onOpenAsset, sort, onSort }: {
  post: CommunityPostDto; now: number; canModerate: boolean; likeBusy: boolean; onLike: () => void;
  onOpenAuthor: (userId: string) => void; onOpenAccount: (userId: string) => void; onOpenAsset: (assetId: string) => void;
  sort: CommunityCommentSort; onSort: (sort: CommunityCommentSort) => void;
}) {
  const { colors } = useAppearance();
  const author = describePostAuthor(post.author);
  const [page, setPage] = useState(0);
  const [width, setWidth] = useState(0);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width > 0) setPage(Math.max(0, Math.min(post.photos.length - 1, Math.round(event.nativeEvent.contentOffset.x / width))));
  };
  const head = (
    <>
      <CommunityAvatar display={author} size={36} testID="community-detail-avatar" />
      <View style={{ flexShrink: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text style={{ fontSize: 14, lineHeight: 20, fontWeight: '700', color: author.kind === 'public' ? semantic.text : semantic.muted }}>{author.name}</Text>
          <TierMark tier={author.tier} name={author.tierName} />
        </View>
        <Text style={{ fontSize: 12, lineHeight: 16, color: semantic.muted }}>{formatCommunityTime(post.createdAt, now)}</Text>
      </View>
    </>
  );
  return (
    <View style={{ backgroundColor: semantic.surface, paddingTop: 16, gap: 12 }}>
      <View style={{ paddingHorizontal: 16, gap: 12 }}>
        {author.pressable && author.userId ? (
          <ActionPressable testID="community-detail-author" accessibilityRole="button" accessibilityLabel={`${author.name}, 시즌 요약 보기`}
            onPress={() => onOpenAuthor(author.userId)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, alignSelf: 'flex-start' }}>
            {head}
          </ActionPressable>
        ) : <View testID="community-detail-author" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>{head}</View>}
        {canModerate && post.adminAuthor ? (
          <ActionPressable testID="community-admin-author" accessibilityRole="button"
            accessibilityLabel={`작성 계정 ${post.adminAuthor.nickname}, 관리자에게만 보여요, 계정 관리`}
            onPress={() => onOpenAccount(post.adminAuthor?.userId ?? '')}
            style={{ minHeight: 44, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: semantic.border,
              backgroundColor: semantic.input, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 }}>
            <CommunityIcon name="shield" size={16} color={colors.secondary} />
            <Text style={{ fontSize: 12, color: semantic.muted }}>작성 계정</Text>
            <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '700', flexShrink: 1 }}>{post.adminAuthor.nickname}</Text>
            <View style={{ flex: 1 }} />
            <Text style={{ fontSize: 11, color: semantic.muted }}>관리자에게만 보여요</Text>
            <CommunityIcon name="chevron" size={14} color={colors.muted} />
          </ActionPressable>
        ) : null}
        <Text selectable testID="community-detail-body" style={{ fontSize: 16, lineHeight: 25 }}>{post.body}</Text>
        {post.asset ? <AssetTagChip asset={post.asset} testID="community-detail-asset" onPress={() => onOpenAsset(post.asset?.id ?? '')} /> : null}
        {canModerate && (post.reportCount ?? 0) > 0 ? (
          <Text testID="community-detail-reports" style={{ fontSize: 11, color: semantic.error }}>신고 {post.reportCount}</Text>
        ) : null}
      </View>
      {post.photos.length ? (
        <View style={{ paddingHorizontal: 16 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width - 32)}>
          <View style={{ height: 190, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.raised }}>
            <ScrollView testID="community-detail-photos" horizontal pagingEnabled showsHorizontalScrollIndicator={false}
              onMomentumScrollEnd={onScroll} onScroll={Platform.OS === 'web' ? onScroll : undefined} scrollEventThrottle={32}>
              {post.photos.map((photo, index) => (
                <Image key={photo.url} testID={`community-detail-photo-${index}`} source={{ uri: photo.url }} resizeMode="cover"
                  accessible accessibilityLabel={`사진 ${index + 1}/${post.photos.length}`} style={{ width: Math.max(width, 1), height: 190 }} />
              ))}
            </ScrollView>
            <View pointerEvents="none" style={{ position: 'absolute', right: 8, bottom: 8, minHeight: 24, borderRadius: 12, paddingHorizontal: 8,
              justifyContent: 'center', backgroundColor: semantic.scrim }}>
              <Text testID="community-detail-photo-page" style={{ fontSize: 12, fontWeight: '700', color: semantic.onScrim }}>{page + 1}/{post.photos.length}</Text>
            </View>
          </View>
        </View>
      ) : null}
      <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12,
        borderTopWidth: 1, borderBottomWidth: 1, borderColor: semantic.border }}>
        <CountButton testID="community-detail-like" icon="heart" label="좋아요" count={post.likeCount} active={post.likedByMe}
          disabled={likeBusy} onPress={post.mine ? undefined : onLike} height={44} />
        <CountButton testID="community-detail-comment-count" icon="comment" label="댓글" count={post.commentCount} height={44} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 4, gap: 8 }}>
        <Text accessibilityRole="header" style={{ fontSize: 15, fontWeight: '700', flex: 1 }}>댓글 {post.commentCount}</Text>
        {SORTS.map((item) => {
          const on = item.key === sort;
          return (
            <ActionPressable key={item.key} feedback="selection" testID={`community-comments-sort-${item.key}`} accessibilityRole="tab"
              accessibilityLabel={item.label} accessibilityState={{ selected: on }} aria-selected={on} onPress={() => { if (!on) onSort(item.key); }}
              style={{ minHeight: 36, borderRadius: 18, paddingHorizontal: 12, justifyContent: 'center', backgroundColor: on ? semantic.inverse : semantic.input }}>
              <Text style={{ fontSize: 13, fontWeight: on ? '700' : '400', color: on ? semantic.onInverse : semantic.text }} maxFontSizeMultiplier={1.4}>{item.label}</Text>
            </ActionPressable>
          );
        })}
      </View>
    </View>
  );
}

function CommentRow({ comment, now, canModerate, busy, onLike, onReply, onMore, onOpenAuthor, onOpenAccount }: {
  comment: CommunityCommentDto; now: number; canModerate: boolean; busy: boolean; onLike: () => void; onReply: () => void;
  onMore: () => void; onOpenAuthor: (userId: string) => void; onOpenAccount: (userId: string) => void;
}) {
  const { colors } = useAppearance();
  const author = describeCommentAuthor(comment);
  const reply = comment.parentCommentId !== null;
  const name = (
    <>
      <CommunityAvatar display={author} size={28} />
      <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, fontWeight: '700', flexShrink: 1,
        color: author.kind === 'public' ? semantic.text : semantic.muted }}>{author.name}</Text>
      <TierMark tier={author.tier} name={author.tierName} />
      {author.postAuthorTag ? <PostAuthorTag /> : null}
    </>
  );
  return (
    <View testID={`community-comment-${comment.id}`} style={{ backgroundColor: semantic.surface, paddingLeft: reply ? 52 : 16, paddingRight: 8, paddingTop: 10 }}>
      {comment.deleted ? (
        <View style={{ minHeight: 36, justifyContent: 'center', paddingBottom: 8 }}>
          <Text testID={`community-comment-${comment.id}-deleted`} style={{ fontSize: 13, color: semantic.muted }}>삭제된 댓글입니다</Text>
          {canModerate && comment.adminAuthor ? <AdminAuthorPill nickname={comment.adminAuthor.nickname}
            onPress={() => onOpenAccount(comment.adminAuthor?.userId ?? '')} /> : null}
        </View>
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 }}>
            {author.pressable && author.userId ? (
              <ActionPressable testID={`community-comment-${comment.id}-author`} accessibilityRole="button" accessibilityLabel={`${author.name}, 시즌 요약 보기`}
                onPress={() => onOpenAuthor(author.userId)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, flexShrink: 1, marginVertical: -6 }}>
                {name}
              </ActionPressable>
            ) : <View testID={`community-comment-${comment.id}-author`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>{name}</View>}
            {canModerate && comment.adminAuthor ? <AdminAuthorPill nickname={comment.adminAuthor.nickname}
              onPress={() => onOpenAccount(comment.adminAuthor?.userId ?? '')} /> : null}
            <View style={{ flex: 1 }} />
            <Text numberOfLines={1} style={{ fontSize: 12, color: semantic.muted, flexShrink: 0 }}>{formatCommunityTime(comment.createdAt, now)}</Text>
          </View>
          <Text selectable style={{ fontSize: 14, lineHeight: 21, marginLeft: 36, marginTop: 2 }}>{comment.body}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 36, gap: 12 }}>
            <ActionPressable testID={`community-comment-${comment.id}-like`} accessibilityRole="button" accessibilityLabel={`좋아요 ${comment.likeCount}`}
              accessibilityState={{ selected: comment.likedByMe, disabled: comment.mine || busy }} aria-selected={comment.likedByMe}
              disabled={comment.mine || busy} onPress={onLike} style={{ minHeight: 32, justifyContent: 'center' }}>
              <Text style={{ fontSize: 12, fontWeight: comment.likedByMe ? '700' : '400', color: comment.likedByMe ? semantic.text : semantic.muted }}>
                좋아요 {comment.likeCount}</Text>
            </ActionPressable>
            <ActionPressable testID={`community-comment-${comment.id}-reply`} accessibilityRole="button" accessibilityLabel="답글" onPress={onReply}
              style={{ minHeight: 32, justifyContent: 'center' }}>
              <Text style={{ fontSize: 12, color: semantic.muted }}>답글</Text>
            </ActionPressable>
            {canModerate && (comment.reportCount ?? 0) > 0 ? (
              <Text style={{ fontSize: 11, color: semantic.error }}>신고 {comment.reportCount}</Text>
            ) : null}
            <View style={{ flex: 1 }} />
            {/* 삭제 (mine), 신고 (anyone else's, 탈퇴계정 included), operators' 관리자 메뉴. */}
            <ActionPressable testID={`community-comment-${comment.id}-more`} accessibilityRole="button" accessibilityLabel="댓글 더보기" onPress={onMore}
              style={{ minHeight: 32, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}>
              <CommunityIcon name="more" size={16} color={colors.muted} />
            </ActionPressable>
          </View>
        </>
      )}
    </View>
  );
}

/** An anonymous comment's real account, to operators only (a dashed 18dp pill). */
function AdminAuthorPill({ nickname, onPress }: { nickname: string; onPress: () => void }) {
  return (
    <ActionPressable accessibilityRole="button" accessibilityLabel={`작성 계정 ${nickname}, 관리자에게만 보여요`} onPress={onPress} hitSlop={13}
      style={{ minHeight: 18, borderRadius: 9, borderWidth: 1, borderStyle: 'dashed', borderColor: semantic.border, paddingHorizontal: 6,
        justifyContent: 'center', backgroundColor: semantic.input, flexShrink: 0 }}>
      <Text numberOfLines={1} style={{ fontSize: 11, lineHeight: 15, fontWeight: '700' }} maxFontSizeMultiplier={1.4}>{nickname}</Text>
    </ActionPressable>
  );
}
