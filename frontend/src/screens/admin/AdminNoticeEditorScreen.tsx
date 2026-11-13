import React, { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHeaderHeight } from '@react-navigation/elements';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MyStackParamList } from '../../app/navigation/types';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { createIdempotencyKey } from '../../utils/idempotency';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import { getApiErrorCode, getApiErrorDisplayMessage, getApiErrorInfo } from '../../services/api/errorMapper';
import {
  AdminNoticeResponseError, createAdminNotice, publishAdminNotice, type AdminNotice,
} from '../../features/admin/noticeAdminApi';
import { isAdminRole } from '../../features/admin/adminRole';
import { publishConsequences } from '../../features/admin/noticeAdminCopy';
import {
  DEFAULT_SECTION_HEADING, NOTICE_LIMITS, noticeTextLength, sameNoticeRequest, validateNoticeDraft, type NoticeDraftRequest,
} from '../../features/notice/noticeDraft';
import type { MeDto } from '../../features/me/api';
import AuthCheckbox from '../auth/AuthCheckbox';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import NoticeSections from '../../components/notice/NoticeSections';
import NoticePopupCard from '../../features/notice/NoticePopupCard';

type Props = NativeStackScreenProps<MyStackParamList, 'AdminNoticeEditor'>;
type Step = 'publish' | 'save';
/** The request being sent (or last sent with an unknown result) and its key; a saved draft keeps its notice. */
type Attempt = { request: NoticeDraftRequest; idempotencyKey: string; saved: AdminNotice | null };

/**
 * 관리자 전용 콘솔 › 공지 작성 (2026-11-13). The body is plain text: blank
 * lines separate paragraphs, "## " starts a section (noticeDraft.ts); the
 * preview shows exactly what members will read in 공지사항 and, if chosen,
 * the entry popup card. 초안 저장 creates a draft (members see nothing);
 * 게시하기 asks for a final confirmation, then creates the draft if needed
 * and publishes it. A retry with unchanged content reuses its idempotency key
 * (the server replays the same draft), so an unknown result never makes a
 * second notice; a publish that failed after the draft was saved publishes
 * that same draft on the next try.
 */
export default function AdminNoticeEditorScreen({ navigation }: Props) {
  const me = useQuery<MeDto>({ queryKey: QUERY_KEYS.me, enabled: false }).data;
  const userId = me?.id ?? null;
  if (!userId || !isAdminRole(me?.role)) {
    return <Text testID="admin-notice-editor-blocked" style={styles.blocked}>관리자 권한이 확인된 계정에서만 이용할 수 있습니다.</Text>;
  }
  return <Editor key={userId} userId={userId} navigation={navigation} />;
}

function Editor({ userId, navigation }: { userId: string; navigation: Props['navigation'] }) {
  const queryClient = useQueryClient();
  const headerHeight = useHeaderHeight();
  const scroll = useFocusedInputScroll();
  const titleRef = useRef<View>(null);
  const summaryRef = useRef<View>(null);
  const bodyRef = useRef<View>(null);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [showPopup, setShowPopup] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<{ error: unknown; text: string } | null>(null);
  const [denied, setDenied] = useState(false);
  const attempt = useRef<Attempt | null>(null);

  const draft = validateNoticeDraft({ title, summary, body, showPopup });
  const mutation = useMutation({
    mutationFn: async ({ step, current }: { step: Step; current: Attempt }) => {
      const notice = current.saved ?? await createAdminNotice({ ...current.request, idempotencyKey: current.idempotencyKey });
      current.saved = notice;
      if (step === 'save' || notice.status !== 'draft') return notice;
      return publishAdminNotice(notice.id);
    },
    retry: false,
    onSuccess: (notice, { step }) => {
      attempt.current = null;
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.notices.admin(userId) });
      if (notice.status === 'published') void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.notices.important });
      // Back to the list, which reads the server's state on focus.
      if (step === 'save' || notice.status !== 'draft') navigation.goBack();
    },
    onError: (error, { step, current }) => {
      const info = getApiErrorInfo(error);
      if (info.status === 403) { attempt.current = null; setDenied(true); return; }
      const code = getApiErrorCode(error);
      const uncertain = error instanceof AdminNoticeResponseError || !info.hasResponse || (info.status ?? 0) >= 500;
      // A refused request can never succeed with this key; an unknown result is resent as is.
      if (!uncertain && !current.saved) attempt.current = null;
      setConfirming(false);
      const saved = current.saved;
      setFailure({ error, text:
        saved && step === 'publish'
          ? code === 'NOTICE_ALREADY_PUBLISHED' ? '이미 게시된 공지입니다. 공지사항 관리 목록에서 확인해주세요.'
            : '초안은 저장했지만 게시하지 못했습니다. 다시 게시하거나 공지사항 관리 목록에서 게시해주세요.'
          : code === 'NOTICE_IDEMPOTENCY_CONFLICT' ? '같은 요청 키로 다른 내용이 저장되어 있습니다. 다시 시도하면 새 초안으로 저장합니다.'
            : code === 'INVALID_NOTICE' ? '서버가 공지 형식을 받아들이지 않았습니다. 제목·요약·본문의 길이를 확인해주세요.'
              : uncertain ? '저장 결과를 확인하지 못했습니다. 내용을 바꾸지 않고 다시 시도하면 같은 초안으로 처리되어 중복 저장되지 않습니다.'
                : getApiErrorDisplayMessage(error) });
    },
  });
  const busy = mutation.isPending;

  const edit = (setter: (value: string) => void) => (value: string) => {
    if (busy || confirming) return;
    setter(value);
    setErrors([]);
    setFailure(null);
  };
  /** The request for the current content: the same key while the content is unchanged. */
  const currentAttempt = (request: NoticeDraftRequest): Attempt => {
    const previous = attempt.current;
    if (previous && sameNoticeRequest(previous.request, request)) return previous;
    return (attempt.current = { request, idempotencyKey: createIdempotencyKey('notice'), saved: null });
  };
  const start = (step: Step) => {
    if (busy) return;
    Keyboard.dismiss();
    setFailure(null);
    if (!draft.request) { setErrors(draft.errors); return; }
    setErrors([]);
    if (step === 'publish' && !confirming) { setConfirming(true); return; }
    mutation.mutate({ step, current: currentAttempt(draft.request) });
  };

  if (denied) {
    return (
      <Text testID="admin-notice-editor-denied" accessibilityLiveRegion="polite" style={styles.blocked}>
        관리자 권한이 확인되지 않아 공지를 저장할 수 없습니다. 권한이 바뀌었다면 다시 로그인해주세요.
      </Text>
    );
  }
  const counter = (value: string, max: number) => `${noticeTextLength(value)}/${max}`;
  const sections = draft.request?.sections ?? null;
  return (
    // Android draws edge to edge: pad for the keyboard on both platforms.
    <KeyboardAvoidingView style={styles.screen} keyboardVerticalOffset={headerHeight} behavior="padding">
      <ScrollView testID="admin-notice-editor" ref={scroll.scrollRef} onLayout={scroll.revealFocusedInput}
        onContentSizeChange={scroll.revealFocusedInput} onScroll={scroll.onScroll} scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>제목</Text>
            <Text style={styles.counter}>{counter(title, NOTICE_LIMITS.title)}</Text>
          </View>
          <View ref={titleRef} collapsable={false}>
            <TextInput testID="admin-notice-title" accessibilityLabel="공지 제목" value={title} editable={!busy && !confirming}
              maxLength={NOTICE_LIMITS.title} placeholder="예: 11월 20일 서버 점검 안내" placeholderTextColor={semantic.placeholder}
              onChangeText={edit(setTitle)} onFocus={() => scroll.onInputFocus(titleRef.current)} onBlur={scroll.onInputBlur} style={styles.input} />
          </View>
          <View style={styles.labelRow}>
            <Text style={styles.label}>요약</Text>
            <Text style={styles.counter}>{counter(summary, NOTICE_LIMITS.summary)}</Text>
          </View>
          <Text style={styles.caption}>공지사항 목록·팝업·푸시 알림에 쓰이는 핵심 요약입니다.</Text>
          <View ref={summaryRef} collapsable={false}>
            <TextInput testID="admin-notice-summary" accessibilityLabel="공지 요약" value={summary} editable={!busy && !confirming}
              multiline maxLength={NOTICE_LIMITS.summary} textAlignVertical="top" placeholderTextColor={semantic.placeholder}
              placeholder="회원에게 가장 먼저 보여 줄 한두 문장" onChangeText={edit(setSummary)}
              onFocus={() => scroll.onInputFocus(summaryRef.current)} onBlur={scroll.onInputBlur} style={[styles.input, styles.summaryInput]} />
          </View>
          <Text style={styles.label}>본문</Text>
          <Text style={styles.caption}>
            빈 줄로 문단을 나눕니다(줄바꿈은 그대로 표시). ‘## 소제목’으로 시작하는 줄은 단락 제목이 되고, 소제목이 없으면 ‘{DEFAULT_SECTION_HEADING}’로 표시됩니다. 문단은 {NOTICE_LIMITS.paragraph.toLocaleString('ko-KR')}자, 소제목은 {NOTICE_LIMITS.sections}개까지 쓸 수 있습니다.
          </Text>
          <View ref={bodyRef} collapsable={false}>
            <TextInput testID="admin-notice-body" accessibilityLabel="공지 본문" value={body} editable={!busy && !confirming}
              multiline textAlignVertical="top" placeholderTextColor={semantic.placeholder} placeholder={'공지 내용을 입력하세요.\n\n## 소제목\n내용'}
              onChangeText={edit(setBody)} onFocus={() => scroll.onInputFocus(bodyRef.current)} onBlur={scroll.onInputBlur}
              style={[styles.input, styles.bodyInput]} />
          </View>
          <AuthCheckbox testID="admin-notice-popup" label="앱에 들어올 때 팝업으로도 표시 (회원마다 한 번)" checked={showPopup}
            disabled={busy || confirming} onChange={(checked) => { setShowPopup(checked); setFailure(null); }} />
          <Text style={styles.caption}>
            팝업은 게시 후 아직 확인하지 않은 회원에게 앱에 들어올 때 화면 가운데에 한 번 보이고, 푸시 알림 설정과 관계없습니다. 저장 후에는 바꿀 수 없습니다.
          </Text>
        </View>

        <CTAButton testID="admin-notice-preview" variant="neutral" label={previewing ? '미리보기 닫기' : '미리보기'}
          onPress={() => { Keyboard.dismiss(); setPreviewing((open) => !open); }} />
        {previewing ? (
          <View testID="admin-notice-preview-panel" style={styles.block}>
            <Text style={styles.label}>공지사항 목록에서</Text>
            <View style={styles.card}>
              <Text style={styles.previewTitle}>{title.trim() || '(제목 없음)'}</Text>
              <Text style={styles.caption}>중요 · 게시 전</Text>
              {sections ? <NoticeSections sections={sections} /> : (
                <Text style={styles.error}>미리볼 수 없습니다: {draft.errors.join(' ')}</Text>
              )}
            </View>
            {showPopup ? (
              <>
                <Text style={styles.label}>앱에 들어올 때 팝업</Text>
                <View style={styles.popupStage}>
                  <NoticePopupCard testID="admin-notice-popup-preview" title={title.trim() || '(제목 없음)'} summary={summary.trim() || '(요약 없음)'} />
                </View>
              </>
            ) : null}
          </View>
        ) : null}

        {errors.length ? (
          <View testID="admin-notice-errors" accessibilityLiveRegion="polite" style={styles.block}>
            {errors.map((line) => <Text key={line} style={styles.error}>{line}</Text>)}
          </View>
        ) : null}
        {failure ? <ErrorNotice testID="admin-notice-failure" error={failure.error} message={failure.text} style={styles.error} /> : null}

        <View ref={scroll.submitRef} collapsable={false} style={styles.block}>
          {confirming ? (
            <View testID="admin-notice-confirm" style={styles.confirm} accessibilityLiveRegion="polite">
              <Text accessibilityRole="header" style={styles.confirmTitle}>이 공지를 게시할까요?</Text>
              {publishConsequences(showPopup).map((line) => <Text key={line} style={styles.caption}>• {line}</Text>)}
              <CTAButton testID="admin-notice-confirm-submit" label="게시 확정" state={busy ? 'loading' : 'enabled'} onPress={() => start('publish')} />
              <CTAButton testID="admin-notice-confirm-cancel" variant="neutral" label="계속 작성" state={busy ? 'disabled' : 'enabled'}
                onPress={() => { if (!busy) setConfirming(false); }} />
            </View>
          ) : (
            <>
              <CTAButton testID="admin-notice-publish" label="게시하기" state={busy ? 'loading' : 'enabled'} onPress={() => start('publish')} />
              <CTAButton testID="admin-notice-save" variant="neutral" label="초안 저장" state={busy ? 'disabled' : 'enabled'} onPress={() => start('save')} />
              <Text style={styles.caption}>초안은 회원에게 보이지 않습니다. 저장한 초안은 공지사항 관리 목록에서 게시할 수 있습니다.</Text>
            </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getHeaderScreenContentStyle(Platform.OS), paddingBottom: 40 },
  blocked: { padding: 24, fontSize: 15, lineHeight: 22, color: semantic.secondary },
  block: { gap: 8 },
  card: { gap: 8, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface },
  labelRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: 8 },
  label: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.text },
  counter: { fontSize: 12, lineHeight: 18, color: semantic.secondary, fontVariant: ['tabular-nums'] },
  caption: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  input: {
    borderWidth: 1, borderColor: semantic.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 16, lineHeight: 22, backgroundColor: semantic.input, color: semantic.text,
  },
  summaryInput: { minHeight: 72 },
  bodyInput: { minHeight: 220 },
  previewTitle: { fontSize: 17, lineHeight: 25, fontWeight: '700', color: semantic.text },
  popupStage: { padding: 16, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center' },
  confirm: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: semantic.raised },
  confirmTitle: { fontSize: 16, lineHeight: 23, fontWeight: '700', color: semantic.text },
  error: { fontSize: 14, lineHeight: 20, color: semantic.error },
});
