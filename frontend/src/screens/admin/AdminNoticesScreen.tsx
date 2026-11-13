import React, { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MyStackParamList } from '../../app/navigation/types';
import { Platform, ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { formatKstDateTime } from '../../utils/format';
import { getApiErrorCode, getApiErrorDisplayMessage, getApiErrorInfo } from '../../services/api/errorMapper';
import {
  AdminNoticeResponseError, getAdminNotices, publishAdminNotice, withdrawAdminNotice, type AdminNotice,
} from '../../features/admin/noticeAdminApi';
import { isAdminRole } from '../../features/admin/adminRole';
import { NOTICE_STATUS_LABEL, WITHDRAW_CONSEQUENCES, describeNoticeDelivery, publishConsequences } from '../../features/admin/noticeAdminCopy';
import type { MeDto } from '../../features/me/api';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import WhaleLoader from '../../components/states/WhaleLoader';
import NoticeSections from '../../components/notice/NoticeSections';

type Props = NativeStackScreenProps<MyStackParamList, 'AdminNotices'>;
type Action = 'publish' | 'withdraw';
type Outcome = { noticeId: string; text: string; error?: unknown };

/**
 * 관리자 전용 콘솔 › 공지사항 관리 (2026-11-13): every notice with its status
 * (초안 / 게시됨 / 철회됨), popup choice, dates and push delivery counts, a
 * preview of its full text, and — after an explicit confirmation stating
 * what happens — 게시하기 for a draft or 철회하기 for a published notice. A
 * 403 hides everything (the server no longer accepts this session's role).
 */
export default function AdminNoticesScreen({ navigation }: Props) {
  const me = useQuery<MeDto>({ queryKey: QUERY_KEYS.me, enabled: false }).data;
  const userId = me?.id ?? null;
  if (!userId || !isAdminRole(me?.role)) {
    return <Text testID="admin-notices-blocked" style={styles.blocked}>관리자 권한이 확인된 계정에서만 이용할 수 있습니다.</Text>;
  }
  return <NoticeList key={userId} userId={userId} navigation={navigation} />;
}

function NoticeList({ userId, navigation }: { userId: string; navigation: Props['navigation'] }) {
  const queryClient = useQueryClient();
  const [denied, setDenied] = useState(false);
  const [confirming, setConfirming] = useState<{ noticeId: string; action: Action } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const listKey = QUERY_KEYS.notices.admin(userId);
  const list = useQuery({ queryKey: listKey, queryFn: ({ signal }) => getAdminNotices(signal), enabled: !denied });
  const { refetch } = list;
  // Back from the editor: the server's list again (a new draft or a publish there).
  useEffect(() => navigation.addListener('focus', () => { if (!denied) void refetch({ cancelRefetch: false }); }), [denied, navigation, refetch]);
  const deny = useCallback(() => { setConfirming(null); setOutcome(null); setDenied(true); }, []);
  useEffect(() => { if (getApiErrorInfo(list.error).status === 403) deny(); }, [deny, list.error]);
  useEffect(() => {
    if (!denied) return;
    queryClient.removeQueries({ queryKey: listKey });
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.me });
    // listKey is derived from userId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denied, queryClient, userId]);

  const mutation = useMutation({
    mutationFn: ({ noticeId, action }: { noticeId: string; action: Action }) =>
      action === 'publish' ? publishAdminNotice(noticeId) : withdrawAdminNotice(noticeId),
    retry: false,
    onSuccess: (notice, { action }) => {
      setConfirming(null);
      setOutcome({ noticeId: notice.id, text: action === 'publish' ? '게시했습니다. 공지사항 목록에 표시됩니다.' : '철회했습니다.' });
      void queryClient.invalidateQueries({ queryKey: listKey });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.notices.important });
    },
    onError: (error, { noticeId }) => {
      if (getApiErrorInfo(error).status === 403) { deny(); return; }
      const info = getApiErrorInfo(error);
      const code = getApiErrorCode(error);
      const uncertain = error instanceof AdminNoticeResponseError || !info.hasResponse || (info.status ?? 0) >= 500;
      setConfirming(null);
      // Whatever happened, show the state the server holds now.
      void refetch();
      setOutcome({ noticeId, error, text:
        code === 'NOTICE_ALREADY_PUBLISHED' ? '이미 게시된 공지입니다. 목록을 새로 불러왔습니다.'
          : code === 'NOTICE_WITHDRAWN' ? '이미 철회된 공지입니다. 목록을 새로 불러왔습니다.'
            : code === 'NOTICE_NOT_PUBLISHED' ? '게시 중인 공지가 아니어서 철회하지 않았습니다.'
              : code === 'NOTICE_NOT_FOUND' ? '공지를 찾을 수 없습니다.'
                : uncertain ? '처리 결과를 확인하지 못했습니다. 목록의 상태를 확인한 뒤 필요하면 다시 시도해주세요.'
                  : getApiErrorDisplayMessage(error) });
    },
  });
  const busy = mutation.isPending;

  if (denied) {
    return (
      <Text testID="admin-notices-denied" accessibilityLiveRegion="polite" style={styles.blocked}>
        관리자 권한이 확인되지 않아 공지를 관리할 수 없습니다. 권한이 바뀌었다면 다시 로그인해주세요.
      </Text>
    );
  }
  return (
    <ScrollView testID="admin-notices-screen" style={styles.screen} contentContainerStyle={styles.content}>
      <CTAButton testID="admin-notices-new" label="새 공지 작성" onPress={() => navigation.navigate('AdminNoticeEditor')} />
      {list.isPending ? (
        <View style={styles.center}><WhaleLoader size={32} accessibilityLabel="공지 목록을 불러오는 중" /></View>
      ) : list.isError && !list.data ? (
        <View style={styles.block}>
          <ErrorNotice testID="admin-notices-load-error" error={list.error} message="공지 목록을 불러오지 못했습니다." style={styles.error} />
          <CTAButton testID="admin-notices-retry" variant="neutral" label="다시 시도" onPress={() => void refetch()} />
        </View>
      ) : !list.data?.length ? (
        <Text testID="admin-notices-empty" style={styles.caption}>작성한 공지가 없습니다.</Text>
      ) : list.data.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} busy={busy}
          previewOpen={preview === notice.id}
          onPreview={() => setPreview((current) => (current === notice.id ? null : notice.id))}
          confirming={confirming?.noticeId === notice.id ? confirming.action : null}
          onAsk={(action) => { setOutcome(null); setConfirming({ noticeId: notice.id, action }); }}
          onCancel={() => { if (!busy) setConfirming(null); }}
          onConfirm={(action) => { if (!busy) mutation.mutate({ noticeId: notice.id, action }); }}
          outcome={outcome?.noticeId === notice.id ? outcome : null} />
      ))}
    </ScrollView>
  );
}

function NoticeCard({ notice, busy, previewOpen, onPreview, confirming, onAsk, onCancel, onConfirm, outcome }: {
  notice: AdminNotice;
  busy: boolean;
  previewOpen: boolean;
  onPreview: () => void;
  confirming: Action | null;
  onAsk: (action: Action) => void;
  onCancel: () => void;
  onConfirm: (action: Action) => void;
  outcome: Outcome | null;
}) {
  const delivery = describeNoticeDelivery(notice.delivery);
  const action: Action | null = notice.status === 'draft' ? 'publish' : notice.status === 'published' ? 'withdraw' : null;
  return (
    <View testID={`admin-notice-${notice.id}`} style={styles.card}>
      <View style={styles.meta}>
        <Text testID={`admin-notice-${notice.id}-status`} style={[styles.chip, notice.status === 'published' ? styles.chipLive : styles.chipIdle]}>
          {NOTICE_STATUS_LABEL[notice.status]}
        </Text>
        {notice.showPopup ? <Text testID={`admin-notice-${notice.id}-popup`} style={[styles.chip, styles.chipIdle]}>팝업</Text> : null}
      </View>
      <Text accessibilityRole="header" style={styles.title}>{notice.title}</Text>
      <Text style={styles.summary}>{notice.summary}</Text>
      <Text style={styles.caption}>
        작성 {formatKstDateTime(notice.createdAt)}
        {notice.publishedAt ? ` · 게시 ${formatKstDateTime(notice.publishedAt)}` : ''}
        {notice.withdrawnAt ? ` · 철회 ${formatKstDateTime(notice.withdrawnAt)}` : ''}
      </Text>
      {delivery ? <Text testID={`admin-notice-${notice.id}-delivery`} style={styles.caption}>{delivery}</Text> : null}
      <ActionPressable testID={`admin-notice-${notice.id}-preview`} accessibilityRole="button" accessibilityState={{ expanded: previewOpen }}
        aria-expanded={previewOpen} onPress={onPreview} style={styles.link}>
        <Text style={styles.linkText}>{previewOpen ? '본문 접기' : '본문 미리보기'}</Text>
      </ActionPressable>
      {previewOpen ? <View testID={`admin-notice-${notice.id}-body`} style={styles.preview}><NoticeSections sections={notice.sections} /></View> : null}
      {confirming ? (
        <View testID={`admin-notice-${notice.id}-confirm`} style={styles.confirm} accessibilityLiveRegion="polite">
          <Text accessibilityRole="header" style={styles.confirmTitle}>{confirming === 'publish' ? '이 공지를 게시할까요?' : '이 공지를 철회할까요?'}</Text>
          {(confirming === 'publish' ? publishConsequences(notice.showPopup) : WITHDRAW_CONSEQUENCES).map((line) => (
            <Text key={line} style={styles.caption}>• {line}</Text>
          ))}
          <CTAButton testID={`admin-notice-${notice.id}-confirm-submit`} label={confirming === 'publish' ? '게시 확정' : '철회 확정'}
            state={busy ? 'loading' : 'enabled'} onPress={() => onConfirm(confirming)} />
          <CTAButton testID={`admin-notice-${notice.id}-confirm-cancel`} variant="neutral" label="취소" state={busy ? 'disabled' : 'enabled'} onPress={onCancel} />
        </View>
      ) : action ? (
        <CTAButton testID={`admin-notice-${notice.id}-${action}`} variant={action === 'publish' ? 'primary' : 'neutral'}
          label={action === 'publish' ? '게시하기' : '철회하기'} state={busy ? 'disabled' : 'enabled'} onPress={() => onAsk(action)} />
      ) : null}
      {outcome ? (outcome.error
        ? <ErrorNotice testID={`admin-notice-${notice.id}-error`} error={outcome.error} message={outcome.text} style={styles.error} />
        : <Text testID={`admin-notice-${notice.id}-done`} accessibilityLiveRegion="polite" style={styles.done}>{outcome.text}</Text>) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: getHeaderScreenContentStyle(Platform.OS),
  center: { paddingVertical: 24, alignItems: 'center' },
  blocked: { padding: 24, fontSize: 15, lineHeight: 22, color: semantic.secondary },
  block: { gap: 8 },
  card: { gap: 8, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  chipLive: { backgroundColor: semantic.selected, color: semantic.onAccent },
  chipIdle: { backgroundColor: semantic.raised, color: semantic.text },
  title: { fontSize: 17, lineHeight: 25, fontWeight: '700', color: semantic.text },
  summary: { fontSize: 15, lineHeight: 22, color: semantic.text },
  caption: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  link: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  linkText: { fontSize: 14, fontWeight: '700', color: semantic.secondaryActionForeground },
  preview: { borderTopWidth: 1, borderTopColor: semantic.border },
  confirm: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: semantic.raised },
  confirmTitle: { fontSize: 16, lineHeight: 23, fontWeight: '700', color: semantic.text },
  error: { fontSize: 14, lineHeight: 20, color: semantic.error },
  done: { fontSize: 14, lineHeight: 20, color: semantic.success },
});
