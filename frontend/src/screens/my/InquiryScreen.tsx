import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHeaderHeight } from '@react-navigation/elements';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MyStackParamList } from '../../app/navigation/types';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { createIdempotencyKey } from '../../utils/idempotency';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import { getApiErrorCode, getApiErrorDisplayMessage, getApiErrorInfo } from '../../services/api/errorMapper';
import {
  canManageInquiries, createInquiry, formatInquiryTime as formatDate, getMyInquiries, INQUIRY_CATEGORIES, INQUIRY_LIMITS,
  inquiryCategoryLabel as categoryLabel, InquiryResponseError, inquiryTextLength as length,
  type InquiryCategory, type InquiryDto, type InquiryRequest,
} from '../../features/inquiry/api';
import type { MeDto } from '../../features/me/api';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import SegmentedControl from '../../components/common/SegmentedControl';
import WhaleLoader from '../../components/states/WhaleLoader';
import OperatorInquiryList from './OperatorInquiryList';

type Attempt = { request: InquiryRequest; running: boolean; uncertain?: boolean };
type InquiryView = 'mine' | 'manage';
const VIEWS = [
  { key: 'mine', label: '내 문의', testID: 'inquiry-tab-mine' },
  { key: 'manage', label: '문의 관리', testID: 'inquiry-tab-manage' },
] as const;

/**
 * 문의하기: type, title and body sent to the authenticated inquiry API. A
 * receipt is shown only for a server-confirmed inquiry. A repeated tap or a
 * retry after an unknown result reuses the same request id, so the same
 * inquiry is never filed twice; any edit starts a new request.
 *
 * 내 문의 내역 lists every page of the author's own inquiries (keyed by user,
 * read again on every visit and whenever the screen is focused again, or on
 * 새로고침). A row opens in place to the original text and, only once the
 * server holds an operator's answer, that answer and its time; until then it
 * says 답변 대기 and nothing else.
 *
 * An operator/admin session also gets 문의 관리 (every user's inquiries; one
 * opens 문의 답변). That tab is a display gate on the session's role; the
 * server's OperatorGuard decides every operator read and answer.
 */
export default function InquiryScreen({ navigation }: NativeStackScreenProps<MyStackParamList, 'Inquiry'>) {
  // Observes the session's `me` (seeded at sign-in, fetched by the account
  // provider); this screen never fetches it itself.
  const me = useQuery<MeDto>({ queryKey: QUERY_KEYS.me, enabled: false }).data;
  const userId = me?.id ?? null;
  const canManage = !!userId && canManageInquiries(me?.role);
  const queryClient = useQueryClient();
  // Losing the role drops this operator's cached 문의 관리 reads (the tab has
  // already unmounted, so nothing observes them).
  useEffect(() => {
    if (userId && !canManage) queryClient.removeQueries({ queryKey: QUERY_KEYS.inquiries.operator(userId) });
  }, [canManage, queryClient, userId]);
  const openAnswer = useCallback((inquiryId: string) => navigation.navigate('InquiryAnswer', { inquiryId }), [navigation]);
  // Form, receipt, open row and tab belong to one signed-in user.
  return <InquiryContent key={userId ?? ''} userId={userId} canManage={canManage} onOpenAnswer={openAnswer} />;
}

function InquiryContent({ userId, canManage, onOpenAnswer }: { userId: string | null; canManage: boolean; onOpenAnswer: (inquiryId: string) => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<InquiryView>('mine');
  const view = canManage && userId ? tab : 'mine';
  const [openId, setOpenId] = useState<string | null>(null);
  const headerHeight = useHeaderHeight();
  const inputScroll = useFocusedInputScroll();
  const titleRef = useRef<View>(null);
  const contentRef = useRef<View>(null);
  const [category, setCategory] = useState<InquiryCategory | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [receipt, setReceipt] = useState<InquiryDto | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const list = useInfiniteQuery({
    queryKey: QUERY_KEYS.inquiries.mine(userId ?? ''),
    queryFn: ({ pageParam, signal }) => getMyInquiries(pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled: !!userId,
  });
  const { refetch: refetchList } = list;
  // Back from another screen or tab: read every loaded page again, so an
  // answer posted meanwhile shows. The first visit joins the initial read.
  useFocusEffect(useCallback(() => {
    if (userId) void refetchList({ cancelRefetch: false });
  }, [refetchList, userId]));
  const refreshing = list.isRefetching && !list.isFetchingNextPage;
  // A row filed between page reads can repeat at a page edge: show it once.
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (list.data?.pages ?? []).flatMap((page) => page.items).filter((item) => !seen.has(item.id) && !!seen.add(item.id));
  }, [list.data]);
  const mutation = useMutation({
    mutationFn: createInquiry,
    retry: false,
    onSuccess: ({ inquiry }) => {
      attempt.current = null;
      setReceipt(inquiry);
      setCategory(null); setTitle(''); setContent(''); setFailure(null);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.inquiries.all });
    },
    onError: (error) => {
      const current = attempt.current;
      const status = getApiErrorInfo(error).status ?? 0;
      const uncertain = error instanceof InquiryResponseError || !getApiErrorInfo(error).hasResponse || status >= 500;
      if (current) current.uncertain = uncertain;
      const code = getApiErrorCode(error);
      // A rejected request id can never succeed again; the next submit gets a new one.
      if (!uncertain) attempt.current = null;
      setFailure(uncertain
        ? '문의 접수 결과를 확인하지 못했습니다. 같은 내용으로 다시 보내면 중복 없이 접수 여부를 확인합니다.'
        : code === 'INQUIRY_RATE_LIMITED' ? '짧은 시간에 많은 문의가 접수되었습니다. 잠시 후 다시 시도해주세요.'
          : code === 'INVALID_INQUIRY' ? '문의 유형과 제목·내용을 다시 확인해주세요.'
            : code === 'INQUIRY_IDEMPOTENCY_CONFLICT' ? '이전 요청과 내용이 달라 접수하지 못했습니다. 다시 보내주세요.'
              : getApiErrorDisplayMessage(error));
    },
    onSettled: () => { if (attempt.current) attempt.current.running = false; },
  });

  const trimmedTitle = title.trim();
  const trimmedContent = content.trim();
  const titleError = title && length(title) < INQUIRY_LIMITS.title.min ? `제목은 ${INQUIRY_LIMITS.title.min}자 이상 입력해주세요.` : null;
  const contentError = content && length(content) < INQUIRY_LIMITS.content.min ? `내용은 ${INQUIRY_LIMITS.content.min}자 이상 입력해주세요.` : null;
  const valid = !!category && length(title) >= INQUIRY_LIMITS.title.min && length(title) <= INQUIRY_LIMITS.title.max &&
    length(content) >= INQUIRY_LIMITS.content.min && length(content) <= INQUIRY_LIMITS.content.max;
  const locked = mutation.isPending || !!attempt.current?.running;

  const edit = (update: () => void) => {
    if (locked) return;
    update();
    setFailure(null);
  };
  const submit = () => {
    if (!valid || !category || locked) return;
    const previous = attempt.current;
    const same = previous && previous.request.category === category && previous.request.title === trimmedTitle && previous.request.content === trimmedContent;
    const request = same ? previous.request : { clientRequestId: createIdempotencyKey('inquiry'), category, title: trimmedTitle, content: trimmedContent };
    // Fence synchronously, before React Query reports the pending state.
    attempt.current = { request, running: true };
    Keyboard.dismiss();
    setFailure(null);
    mutation.mutate(request);
  };

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.screen}>
      {/* Android draws edge to edge, so the keyboard no longer resizes the
          window (adjustResize): pad for it on both platforms. */}
      <KeyboardAvoidingView style={styles.screen} keyboardVerticalOffset={headerHeight} behavior="padding">
        <ScrollView testID="inquiry-screen" ref={inputScroll.scrollRef} onLayout={inputScroll.revealFocusedInput}
          onContentSizeChange={inputScroll.revealFocusedInput} onScroll={inputScroll.onScroll} scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {canManage && userId ? (
            <SegmentedControl testID="inquiry-tabs" accessibilityLabel="문의 화면" options={VIEWS} value={view} onChange={setTab} />
          ) : null}
          {view === 'manage' && userId ? (
            <OperatorInquiryList key={userId} userId={userId} onOpen={onOpenAnswer} />
          ) : (
            <>
              {receipt ? (
                <View testID="inquiry-success" style={styles.card} accessibilityLiveRegion="polite">
                  <View style={styles.iconCircle} accessible={false}><Text style={styles.iconText}>✓</Text></View>
                  <Text accessibilityRole="header" style={styles.receiptTitle}>문의가 접수되었습니다</Text>
                  <Text style={styles.body}>{categoryLabel(receipt.category)} · {receipt.title}</Text>
                  <Text style={styles.caption}>접수 시각 {formatDate(receipt.createdAt)}</Text>
                  <CTAButton testID="inquiry-new" variant="neutral" label="새 문의 작성" onPress={() => setReceipt(null)} />
                </View>
              ) : (
                <View style={styles.card}>
                  <Text style={styles.heading}>문의 유형</Text>
                  <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="문의 유형">
                    {INQUIRY_CATEGORIES.map(item => {
                      const selected = category === item.key;
                      return (
                        <ActionPressable key={item.key} feedback="selection" testID={`inquiry-category-${item.key}`}
                          accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ selected, disabled: locked }}
                          aria-checked={selected} disabled={locked} onPress={() => edit(() => setCategory(item.key))}
                          style={[styles.chip, selected && styles.chipSelected]}>
                          <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{item.label}</Text>
                        </ActionPressable>
                      );
                    })}
                  </View>
                  <View style={styles.labelRow}>
                    <Text style={styles.heading}>제목</Text>
                    <Text style={styles.counter}>{length(title)}/{INQUIRY_LIMITS.title.max}</Text>
                  </View>
                  <View ref={titleRef} collapsable={false}>
                    <TextInput testID="inquiry-title" accessibilityLabel="문의 제목" value={title} editable={!locked}
                      maxLength={INQUIRY_LIMITS.title.max} placeholder="문의 제목을 입력해주세요" placeholderTextColor={semantic.placeholder}
                      onChangeText={value => edit(() => setTitle(value))} onFocus={() => inputScroll.onInputFocus(titleRef.current)}
                      onBlur={inputScroll.onInputBlur} style={styles.input} />
                  </View>
                  {titleError ? <Text style={styles.error}>{titleError}</Text> : null}
                  <View style={styles.labelRow}>
                    <Text style={styles.heading}>문의 내용</Text>
                    <Text style={styles.counter}>{length(content)}/{INQUIRY_LIMITS.content.max}</Text>
                  </View>
                  <View ref={contentRef} collapsable={false}>
                    <TextInput testID="inquiry-content" accessibilityLabel="문의 내용" value={content} editable={!locked} multiline
                      maxLength={INQUIRY_LIMITS.content.max} textAlignVertical="top" placeholder="어떤 화면에서 무엇이 궁금하거나 불편했는지 알려주세요"
                      placeholderTextColor={semantic.placeholder} onChangeText={value => edit(() => setContent(value))}
                      onFocus={() => inputScroll.onInputFocus(contentRef.current)} onBlur={inputScroll.onInputBlur}
                      style={[styles.input, styles.multiline]} />
                  </View>
                  {contentError ? <Text style={styles.error}>{contentError}</Text> : null}
                  {failure ? <Text testID="inquiry-error" accessibilityLiveRegion="polite" style={styles.error}>{failure}</Text> : null}
                  <View ref={inputScroll.submitRef} collapsable={false}>
                    <CTAButton testID="inquiry-submit" label="문의 보내기" state={locked ? 'loading' : valid ? 'enabled' : 'disabled'} onPress={submit} />
                  </View>
                  <Text style={styles.caption}>비밀번호 등 개인정보는 적지 말아 주세요.</Text>
                </View>
              )}
              <View style={styles.card} testID="inquiry-history">
                <View style={styles.headingRow}>
                  <Text style={styles.heading}>내 문의 내역</Text>
                  {userId && !list.isLoading ? (
                    <ActionPressable testID="inquiry-history-refresh" accessibilityRole="button" accessibilityLabel="내 문의 내역 새로고침"
                      accessibilityState={{ busy: refreshing, disabled: refreshing }} disabled={refreshing}
                      onPress={() => { if (!list.isFetching) void refetchList(); }} style={styles.refresh}>
                      <Text style={styles.refreshText}>{refreshing ? '불러오는 중' : '새로고침'}</Text>
                    </ActionPressable>
                  ) : null}
                </View>
                {!userId || list.isLoading ? <WhaleLoader size={28} accessibilityLabel="문의 내역을 불러오는 중" />
                  : list.isError && !items.length ? (
                    <View style={styles.historyError}>
                      <Text testID="inquiry-history-error" style={styles.error}>문의 내역을 불러오지 못했습니다.</Text>
                      <CTAButton testID="inquiry-history-retry" variant="neutral" label="다시 시도" onPress={() => void list.refetch()} />
                    </View>
                  ) : !items.length ? <Text style={styles.caption}>아직 접수한 문의가 없습니다.</Text>
                    : (
                      <>
                        {list.isRefetchError ? (
                          <Text testID="inquiry-history-stale" accessibilityLiveRegion="polite" style={styles.error}>
                            최신 문의 내역을 불러오지 못했습니다. 아래는 이전에 불러온 내역입니다.
                          </Text>
                        ) : null}
                        {items.map(item => (
                          <InquiryRow key={item.id} item={item} open={openId === item.id}
                            onToggle={() => setOpenId(current => (current === item.id ? null : item.id))} />
                        ))}
                        {list.isFetchNextPageError ? (
                          <Text testID="inquiry-history-more-error" accessibilityLiveRegion="polite" style={styles.error}>
                            이전 문의를 불러오지 못했습니다. 다시 눌러 주세요.
                          </Text>
                        ) : null}
                        {list.hasNextPage ? (
                          <CTAButton testID="inquiry-history-more" variant="neutral"
                            label={list.isFetchingNextPage ? '불러오는 중...' : '이전 문의 더 보기'}
                            state={list.isFetchingNextPage ? 'loading' : 'enabled'}
                            onPress={() => { if (!list.isFetchingNextPage) void list.fetchNextPage(); }} />
                        ) : null}
                      </>
                    )}
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** One inquiry: a summary that opens in place to the original and, once the
 * server has it, the operator's answer. */
function InquiryRow({ item, open, onToggle }: { item: InquiryDto; open: boolean; onToggle: () => void }) {
  const answered = item.status === 'answered' && !!item.answer;
  const status = answered ? '답변 완료' : '답변 대기';
  return (
    <View testID={`inquiry-item-${item.id}`} style={styles.historyRow}>
      <ActionPressable testID={`inquiry-item-${item.id}-toggle`} accessibilityRole="button"
        accessibilityLabel={`${item.title}, ${categoryLabel(item.category)}, ${status}`}
        accessibilityHint={open ? '문의 내용을 접습니다.' : '문의 내용과 답변을 펼칩니다.'}
        accessibilityState={{ expanded: open }} aria-expanded={open} onPress={onToggle} style={styles.rowHeader}>
        {/* The title keeps the full width; the status sits on the meta line
            so large text never squeezes it into a narrow column. */}
        <View style={styles.rowText}>
          <Text style={styles.historyTitle}>{item.title}</Text>
          <View style={styles.meta}>
            <Text testID={`inquiry-item-${item.id}-status`} style={[styles.status, answered ? styles.statusAnswered : styles.statusPending]}>{status}</Text>
            <Text style={styles.caption}>{categoryLabel(item.category)} · {formatDate(item.createdAt)}</Text>
          </View>
        </View>
        <Text style={styles.chevron} accessible={false}>{open ? '▲' : '▼'}</Text>
      </ActionPressable>
      {open ? (
        <View testID={`inquiry-item-${item.id}-body`} style={styles.rowBody}>
          <Text style={styles.label}>문의 내용</Text>
          <Text selectable style={styles.paragraph}>{item.content}</Text>
          {answered && item.answer ? (
            <View testID={`inquiry-item-${item.id}-answer`} style={styles.answer}>
              <Text style={styles.label}>운영팀 답변</Text>
              <Text selectable style={styles.paragraph}>{item.answer.content}</Text>
              <Text style={styles.caption}>답변 시각 {formatDate(item.answer.answeredAt)}</Text>
            </View>
          ) : (
            <Text testID={`inquiry-item-${item.id}-waiting`} style={styles.caption}>
              아직 답변을 준비하고 있어요. 답변이 등록되면 이곳에서 확인할 수 있어요.
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getHeaderScreenContentStyle(Platform.OS), gap: 12 },
  card: { padding: 16, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface, gap: 10 },
  heading: { fontSize: 16, lineHeight: 24, fontWeight: '700' },
  headingRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 4 },
  refresh: { minHeight: 44, paddingHorizontal: 4, justifyContent: 'center' },
  refreshText: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: semantic.secondaryActionForeground },
  labelRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginTop: 4 },
  counter: { fontSize: 12, lineHeight: 18, color: semantic.secondary, fontVariant: ['tabular-nums'] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 40, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.raised, justifyContent: 'center' },
  chipSelected: { borderColor: semantic.secondaryActionForeground, backgroundColor: semantic.secondaryActionSurface },
  chipText: { fontSize: 14, lineHeight: 20, color: semantic.secondary, fontWeight: '600' },
  chipTextSelected: { color: semantic.secondaryActionForeground, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: semantic.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, minHeight: 48, backgroundColor: semantic.input, color: semantic.text },
  multiline: { minHeight: 140 },
  error: { fontSize: 14, lineHeight: 21, color: semantic.warning },
  body: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  caption: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  iconCircle: { width: 52, height: 52, borderRadius: 26, backgroundColor: semantic.successSurface, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  iconText: { fontSize: 24, fontWeight: '700', color: semantic.success },
  receiptTitle: { fontSize: 20, lineHeight: 28, fontWeight: '700', textAlign: 'center' },
  historyError: { gap: 8 },
  historyRow: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: semantic.border, gap: 8 },
  rowHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, minHeight: 44 },
  rowText: { flex: 1, minWidth: 0, gap: 4 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 2 },
  historyTitle: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  status: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden', fontSize: 12, lineHeight: 18, fontWeight: '700', textAlign: 'center' },
  statusPending: { color: semantic.secondary, backgroundColor: semantic.raised },
  statusAnswered: { color: semantic.success, backgroundColor: semantic.successSurface },
  chevron: { flexShrink: 0, fontSize: 12, lineHeight: 22, color: semantic.secondary },
  rowBody: { gap: 6, paddingTop: 2 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '700', color: semantic.secondary },
  paragraph: { fontSize: 15, lineHeight: 22 },
  answer: { gap: 4, marginTop: 4, padding: 12, borderRadius: 10, backgroundColor: semantic.raised },
});
