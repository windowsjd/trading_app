import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from '@react-navigation/native';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  formatInquiryTime, getOperatorInquiries, inquiryAuthorLabel, inquiryCategoryLabel, isOperatorAccessDenied,
  type OperatorInquiryDto, type OperatorInquiryFilter,
} from '../../features/inquiry/api';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import SegmentedControl from '../../components/common/SegmentedControl';
import ErrorNotice from '../../components/states/ErrorNotice';
import WhaleLoader from '../../components/states/WhaleLoader';

const FILTERS = [
  { key: 'pending', label: '답변 대기', testID: 'operator-inquiry-filter-pending' },
  { key: 'answered', label: '답변 완료', testID: 'operator-inquiry-filter-answered' },
  { key: 'all', label: '전체', testID: 'operator-inquiry-filter-all' },
] as const;
const ORDER: Record<OperatorInquiryFilter, string> = {
  pending: '오래 기다린 문의부터 보여요.',
  answered: '최근에 답변한 문의부터 보여요.',
  all: '최근에 접수된 문의부터 보여요.',
};
const EMPTY: Record<OperatorInquiryFilter, string> = {
  pending: '답변을 기다리는 문의가 없습니다.',
  answered: '답변한 문의가 없습니다.',
  all: '접수된 문의가 없습니다.',
};

/**
 * 문의 관리: every user's inquiries for an operator/admin, 답변 대기 first.
 * Pages come from the operator API (OperatorGuard), keyed by this operator,
 * and are read again whenever the screen is focused or an answer is posted.
 * A 403 means the server no longer accepts this session as an operator: the
 * rows are hidden and dropped, and the session's role is read again.
 */
export default function OperatorInquiryList({ userId, onOpen }: { userId: string; onOpen: (inquiryId: string) => void }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<OperatorInquiryFilter>('pending');
  const [denied, setDenied] = useState(false);
  const list = useInfiniteQuery({
    queryKey: QUERY_KEYS.inquiries.operatorList(userId, filter),
    queryFn: ({ pageParam, signal }) => getOperatorInquiries(filter, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    // Sticky until asked again: a dropped page must not be read straight back.
    enabled: !denied,
  });
  const forbidden = denied || isOperatorAccessDenied(list.error);
  useEffect(() => {
    if (isOperatorAccessDenied(list.error)) setDenied(true);
  }, [list.error]);
  useEffect(() => {
    if (!denied) return;
    queryClient.removeQueries({ queryKey: QUERY_KEYS.inquiries.operator(userId) });
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.me });
  }, [denied, queryClient, userId]);
  const { refetch } = list;
  useFocusEffect(useCallback(() => {
    // Joins the first read when it is still running; every return reads again.
    if (!denied) void refetch({ cancelRefetch: false });
  }, [denied, refetch]));
  // A row answered between page reads can repeat at a page edge: show it once.
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (list.data?.pages ?? []).flatMap((page) => page.items).filter((item) => !seen.has(item.id) && !!seen.add(item.id));
  }, [list.data]);
  const refreshing = list.isRefetching && !list.isFetchingNextPage;

  return (
    <View testID="operator-inquiries" style={styles.card}>
      <View style={styles.headingRow}>
        <Text accessibilityRole="header" style={styles.heading}>문의 관리</Text>
        {forbidden ? null : (
          <ActionPressable testID="operator-inquiries-refresh" accessibilityRole="button" accessibilityLabel="문의 관리 새로고침"
            accessibilityState={{ busy: refreshing, disabled: refreshing }} disabled={refreshing}
            onPress={() => { if (!list.isFetching) void refetch(); }} style={styles.refresh}>
            <Text style={styles.refreshText}>{refreshing ? '불러오는 중' : '새로고침'}</Text>
          </ActionPressable>
        )}
      </View>
      {forbidden ? (
        <View testID="operator-inquiries-denied" style={styles.block}>
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            운영진 권한이 확인되지 않아 문의 관리를 열 수 없습니다. 권한이 바뀌었다면 다시 로그인해주세요.
          </Text>
          <CTAButton testID="operator-inquiries-recheck" variant="neutral" label="권한 다시 확인" onPress={() => setDenied(false)} />
        </View>
      ) : (
        <>
          <SegmentedControl testID="operator-inquiry-filter" accessibilityLabel="답변 상태" compact options={FILTERS}
            value={filter} onChange={setFilter} />
          <Text style={styles.caption}>{ORDER[filter]}</Text>
          {list.isLoading ? <WhaleLoader size={28} accessibilityLabel="문의를 불러오는 중" />
            : list.isError && !items.length ? (
              <View style={styles.block}>
                <ErrorNotice testID="operator-inquiries-error" error={list.error} message="문의를 불러오지 못했습니다." style={styles.error} />
                <CTAButton testID="operator-inquiries-retry" variant="neutral" label="다시 시도" onPress={() => void refetch()} />
              </View>
            ) : !items.length ? <Text testID="operator-inquiries-empty" style={styles.caption}>{EMPTY[filter]}</Text>
              : (
                <>
                  {list.isRefetchError ? (
                    <Text testID="operator-inquiries-stale" accessibilityLiveRegion="polite" style={styles.error}>
                      최신 문의를 불러오지 못했습니다. 아래는 이전에 불러온 목록입니다.
                    </Text>
                  ) : null}
                  {items.map((item) => <OperatorInquiryRow key={item.id} item={item} onOpen={() => onOpen(item.id)} />)}
                  {list.isFetchNextPageError ? (
                    <Text testID="operator-inquiries-more-error" accessibilityLiveRegion="polite" style={styles.error}>
                      문의를 더 불러오지 못했습니다. 다시 눌러 주세요.
                    </Text>
                  ) : null}
                  {list.hasNextPage ? (
                    <CTAButton testID="operator-inquiries-more" variant="neutral"
                      label={list.isFetchingNextPage ? '불러오는 중...' : '문의 더 보기'}
                      state={list.isFetchingNextPage ? 'loading' : 'enabled'}
                      onPress={() => { if (!list.isFetchingNextPage) void list.fetchNextPage(); }} />
                  ) : null}
                </>
              )}
        </>
      )}
    </View>
  );
}

function OperatorInquiryRow({ item, onOpen }: { item: OperatorInquiryDto; onOpen: () => void }) {
  const answered = item.status === 'answered';
  const status = answered ? '답변 완료' : '답변 대기';
  const author = inquiryAuthorLabel(item.user);
  return (
    <ActionPressable testID={`operator-inquiry-${item.id}`} accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${inquiryCategoryLabel(item.category)}, 작성자 ${author}, ${status}, 접수 ${formatInquiryTime(item.createdAt)}`}
      accessibilityHint={answered ? '문의와 등록된 답변을 엽니다.' : '문의를 열어 답변을 작성합니다.'}
      onPress={onOpen} style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.title}>{item.title}</Text>
        <View style={styles.meta}>
          <Text testID={`operator-inquiry-${item.id}-status`} style={[styles.status, answered ? styles.statusAnswered : styles.statusPending]}>{status}</Text>
          <Text style={styles.caption}>{inquiryCategoryLabel(item.category)} · {author}</Text>
        </View>
        <Text style={styles.caption}>접수 {formatInquiryTime(item.createdAt)}</Text>
      </View>
      <Text style={styles.chevron} accessible={false}>›</Text>
    </ActionPressable>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface, gap: 10 },
  headingRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 4 },
  heading: { fontSize: 16, lineHeight: 24, fontWeight: '700' },
  refresh: { minHeight: 44, paddingHorizontal: 4, justifyContent: 'center' },
  refreshText: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: semantic.secondaryActionForeground },
  block: { gap: 8 },
  error: { fontSize: 14, lineHeight: 21, color: semantic.warning },
  caption: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, minHeight: 44, paddingVertical: 10, borderTopWidth: 1, borderTopColor: semantic.border },
  rowText: { flex: 1, minWidth: 0, gap: 4 },
  title: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 2 },
  status: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden', fontSize: 12, lineHeight: 18, fontWeight: '700', textAlign: 'center' },
  statusPending: { color: semantic.secondary, backgroundColor: semantic.raised },
  statusAnswered: { color: semantic.success, backgroundColor: semantic.successSurface },
  chevron: { flexShrink: 0, fontSize: 20, lineHeight: 22, color: semantic.secondary },
});
