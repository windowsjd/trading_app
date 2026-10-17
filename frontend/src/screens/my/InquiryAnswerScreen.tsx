import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHeaderHeight } from '@react-navigation/elements';
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
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import {
  answerInquiry, canManageInquiries, formatInquiryTime, getOperatorInquiry, INQUIRY_ANSWER_LIMITS, inquiryAuthorLabel,
  inquiryCategoryLabel, InquiryResponseError, inquiryTextLength, isOperatorAccessDenied, type InquiryAnswerRequest,
} from '../../features/inquiry/api';
import type { MeDto } from '../../features/me/api';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import WhaleLoader from '../../components/states/WhaleLoader';

type Props = NativeStackScreenProps<MyStackParamList, 'InquiryAnswer'>;
type Attempt = { request: InquiryAnswerRequest; running: boolean };
/** A finished answer request: the stored answer, or why there is none (with its error). */
type Outcome = { kind: 'answered' | 'replayed' } | { kind: 'failed'; cause: unknown; text: string };

/**
 * 문의 관리 > 문의 답변 (operator/admin): the inquiry as filed, its author and
 * status, and its one official answer. A pending inquiry offers the answer
 * form; 답변 등록 asks for a final confirmation (an answer is never edited or
 * withdrawn) before anything is sent. Only the server's stored answer marks
 * it answered. A retry after an unknown result resends the same key and
 * text, so it replays instead of adding an answer; a 409 reads the inquiry
 * again and shows the answer that won. A 403 hides everything and drops the
 * cached operator reads.
 */
export default function InquiryAnswerScreen({ route }: Props) {
  // The session's `me` (seeded at sign-in, fetched by the account provider).
  const me = useQuery<MeDto>({ queryKey: QUERY_KEYS.me, enabled: false }).data;
  const userId = me?.id ?? null;
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.screen}>
      {userId && canManageInquiries(me?.role)
        // The text being written belongs to this operator only.
        ? <AnswerContent key={userId} userId={userId} inquiryId={route.params.inquiryId} />
        : <Text testID="inquiry-answer-blocked" style={[styles.body, styles.blocked]}>운영진만 문의에 답변할 수 있습니다.</Text>}
    </SafeAreaView>
  );
}

function AnswerContent({ userId, inquiryId }: { userId: string; inquiryId: string }) {
  const queryClient = useQueryClient();
  const headerHeight = useHeaderHeight();
  const inputScroll = useFocusedInputScroll();
  const inputRef = useRef<View>(null);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [denied, setDenied] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const detailKey = QUERY_KEYS.inquiries.operatorDetail(userId, inquiryId);
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => getOperatorInquiry(inquiryId, signal),
    // Sticky: a dropped read must not be read straight back.
    enabled: !denied,
  });
  const deny = useCallback(() => {
    attempt.current = null;
    setDraft(''); setConfirming(false); setOutcome(null); setDenied(true);
  }, []);
  useEffect(() => {
    if (isOperatorAccessDenied(detail.error)) deny();
  }, [deny, detail.error]);
  useEffect(() => {
    if (!denied) return;
    queryClient.removeQueries({ queryKey: QUERY_KEYS.inquiries.operator(userId) });
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.me });
  }, [denied, queryClient, userId]);
  const { refetch } = detail;

  const mutation = useMutation({
    mutationFn: ({ request }: { request: InquiryAnswerRequest; owner: number }) => answerInquiry(inquiryId, request),
    retry: false,
    onSuccess: ({ inquiry, replayed }, { owner }) => {
      attempt.current = null;
      // A response that outlived its session is not written into the next one.
      if (!isCurrentSession(owner)) return;
      queryClient.setQueryData(detailKey, inquiry);
      // Both tabs' lists and this inquiry are read again from the server.
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.inquiries.all });
      setDraft(''); setConfirming(false);
      setOutcome({ kind: replayed ? 'replayed' : 'answered' });
    },
    onError: (error, { owner }) => {
      if (!isCurrentSession(owner)) { attempt.current = null; return; }
      const info = getApiErrorInfo(error);
      const status = info.status ?? 0;
      if (status === 403) { deny(); return; }
      const code = getApiErrorCode(error);
      const uncertain = error instanceof InquiryResponseError || !info.hasResponse || status >= 500;
      // A refused key can never succeed; the next request gets a new one.
      if (!uncertain) attempt.current = null;
      setConfirming(false);
      // The answer may be stored (unknown result), or another one is (409):
      // show what the server holds.
      if (uncertain || status === 409 || status === 404) void refetch();
      setOutcome({ kind: 'failed', cause: error, text: uncertain
        ? '답변 등록 결과를 확인하지 못했습니다. 같은 내용으로 다시 등록하면 중복 없이 처리 결과를 확인합니다.'
        : status === 409 ? '이미 답변이 등록된 문의라 새 답변을 등록하지 않았습니다. 등록된 답변을 확인해주세요.'
          : code === 'INQUIRY_NOT_FOUND' ? '문의를 찾을 수 없습니다. 목록에서 다시 확인해주세요.'
            : code === 'INVALID_INQUIRY_ANSWER' ? '답변은 2~2000자로 입력하고, 입력할 수 없는 문자가 있으면 지워주세요.'
              : getApiErrorDisplayMessage(error) });
    },
    onSettled: () => { if (attempt.current) attempt.current.running = false; },
  });

  const count = inquiryTextLength(draft);
  const valid = count >= INQUIRY_ANSWER_LIMITS.min && count <= INQUIRY_ANSWER_LIMITS.max;
  const locked = mutation.isPending || !!attempt.current?.running;
  const edit = (value: string) => {
    if (locked || confirming) return;
    setDraft(value);
    setOutcome(null);
  };
  const askToConfirm = () => {
    if (!valid || locked) return;
    Keyboard.dismiss();
    setOutcome(null);
    setConfirming(true);
  };
  const submit = () => {
    if (!valid || locked || !confirming) return;
    const content = draft.trim();
    const previous = attempt.current;
    // The same text after an unknown result is the same request (same key).
    const request = previous && previous.request.content === content
      ? previous.request : { content, idempotencyKey: createIdempotencyKey('inquiry_answer') };
    // Fence synchronously, before React Query reports the pending state.
    attempt.current = { request, running: true };
    setOutcome(null);
    mutation.mutate({ request, owner: getSessionGeneration() });
  };

  if (denied || isOperatorAccessDenied(detail.error)) {
    return (
      <Text testID="inquiry-answer-denied" accessibilityLiveRegion="polite" style={[styles.error, styles.blocked]}>
        운영진 권한이 확인되지 않아 문의를 표시할 수 없습니다. 권한이 바뀌었다면 다시 로그인해주세요.
      </Text>
    );
  }
  const inquiry = detail.data;
  if (!inquiry) {
    if (!detail.isError) return <View style={styles.blocked}><WhaleLoader size={32} accessibilityLabel="문의를 불러오는 중" /></View>;
    const missing = getApiErrorCode(detail.error) === 'INQUIRY_NOT_FOUND';
    return (
      <View style={[styles.content, styles.block]}>
        <ErrorNotice testID="inquiry-answer-load-error" error={detail.error} style={styles.error}
          message={missing ? '문의를 찾을 수 없습니다.' : '문의를 불러오지 못했습니다.'} />
        {missing ? null : <CTAButton testID="inquiry-answer-retry" variant="neutral" label="다시 시도" onPress={() => void refetch()} />}
      </View>
    );
  }
  const answer = inquiry.status === 'answered' ? inquiry.answer : null;
  const notice = outcome?.kind === 'failed'
    ? <ErrorNotice testID="inquiry-answer-error" error={outcome.cause} message={outcome.text} style={styles.error} />
    : outcome ? (
      <Text testID="inquiry-answer-done" accessibilityLiveRegion="polite" style={styles.done}>
        {outcome.kind === 'replayed' ? '앞서 보낸 답변이 이미 등록되어 있습니다.' : '답변을 등록했습니다.'}
      </Text>
    ) : null;

  return (
    // Android draws edge to edge: pad for the keyboard on both platforms.
    <KeyboardAvoidingView style={styles.screen} keyboardVerticalOffset={headerHeight} behavior="padding">
      <ScrollView testID="inquiry-answer-screen" ref={inputScroll.scrollRef} onLayout={inputScroll.revealFocusedInput}
        onContentSizeChange={inputScroll.revealFocusedInput} onScroll={inputScroll.onScroll} scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View testID="inquiry-answer-inquiry" style={styles.card}>
          <Text accessibilityRole="header" style={styles.title}>{inquiry.title}</Text>
          <View style={styles.meta}>
            <Text testID="inquiry-answer-status" style={[styles.status, answer ? styles.statusAnswered : styles.statusPending]}>
              {answer ? '답변 완료' : '답변 대기'}
            </Text>
            <Text style={styles.caption}>{inquiryCategoryLabel(inquiry.category)}</Text>
          </View>
          <Text testID="inquiry-answer-author" style={styles.caption}>작성자 {inquiryAuthorLabel(inquiry.user)}</Text>
          <Text style={styles.caption}>접수 시각 {formatInquiryTime(inquiry.createdAt)}</Text>
          <Text style={styles.label}>문의 내용</Text>
          <Text testID="inquiry-answer-content" selectable style={styles.paragraph}>{inquiry.content}</Text>
        </View>
        {detail.isRefetchError ? (
          <Text testID="inquiry-answer-stale" accessibilityLiveRegion="polite" style={styles.error}>
            최신 상태를 불러오지 못했습니다. 위 내용은 이전에 불러온 상태입니다.
          </Text>
        ) : null}
        {answer ? (
          <>
            {notice}
            <View testID="inquiry-answer-answer" style={styles.card}>
              <Text style={styles.heading}>운영팀 답변</Text>
              <Text testID="inquiry-answer-answered-by" style={styles.caption}>
                {answer.answeredByUserId === userId ? '내가 등록한 답변' : '다른 운영진이 등록한 답변'} · {formatInquiryTime(answer.answeredAt)}
              </Text>
              <Text testID="inquiry-answer-answer-content" selectable style={styles.paragraph}>{answer.content}</Text>
              <Text style={styles.caption}>등록된 답변은 수정하거나 삭제할 수 없습니다.</Text>
            </View>
          </>
        ) : (
          <View testID="inquiry-answer-form" style={styles.card}>
            <View style={styles.labelRow}>
              <Text style={styles.heading}>공식 답변</Text>
              <Text style={styles.counter}>{count}/{INQUIRY_ANSWER_LIMITS.max}</Text>
            </View>
            <View ref={inputRef} collapsable={false}>
              <TextInput testID="inquiry-answer-input" accessibilityLabel="공식 답변" value={draft} editable={!locked && !confirming}
                multiline maxLength={INQUIRY_ANSWER_LIMITS.max} textAlignVertical="top" placeholder="문의한 사용자에게 보낼 답변을 입력해주세요"
                placeholderTextColor={semantic.placeholder} onChangeText={edit} onFocus={() => inputScroll.onInputFocus(inputRef.current)}
                onBlur={inputScroll.onInputBlur} style={styles.input} />
            </View>
            {draft && count < INQUIRY_ANSWER_LIMITS.min
              ? <Text style={styles.error}>답변은 {INQUIRY_ANSWER_LIMITS.min}자 이상 입력해주세요.</Text> : null}
            <Text style={styles.caption}>등록한 답변은 수정하거나 삭제할 수 없고, 문의한 사용자에게 공식 답변으로 그대로 보입니다.</Text>
            {notice}
            <View ref={inputScroll.submitRef} collapsable={false}>
              {confirming ? (
                // The question sits where 답변 등록 was, so a double tap lands on text.
                <View testID="inquiry-answer-confirm" style={styles.confirm} accessibilityLiveRegion="polite">
                  <Text accessibilityRole="header" style={styles.confirmTitle}>이 답변을 등록할까요?</Text>
                  <Text style={styles.paragraph}>등록하면 수정하거나 삭제할 수 없습니다. 내용을 다시 확인한 뒤 등록해주세요.</Text>
                  <CTAButton testID="inquiry-answer-confirm-submit" label="등록하기" state={locked ? 'loading' : 'enabled'} onPress={submit} />
                  <CTAButton testID="inquiry-answer-confirm-cancel" variant="neutral" label="계속 작성" state={locked ? 'disabled' : 'enabled'}
                    onPress={() => { if (!locked) setConfirming(false); }} />
                </View>
              ) : (
                <CTAButton testID="inquiry-answer-submit" label="답변 등록" state={locked ? 'loading' : valid ? 'enabled' : 'disabled'}
                  onPress={askToConfirm} />
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getHeaderScreenContentStyle(Platform.OS), gap: 12 },
  blocked: { padding: 24 },
  block: { gap: 8 },
  card: { padding: 16, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface, gap: 8 },
  title: { fontSize: 18, lineHeight: 26, fontWeight: '700' },
  heading: { fontSize: 16, lineHeight: 24, fontWeight: '700' },
  labelRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: 8 },
  counter: { fontSize: 12, lineHeight: 18, color: semantic.secondary, fontVariant: ['tabular-nums'] },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 2 },
  status: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden', fontSize: 12, lineHeight: 18, fontWeight: '700', textAlign: 'center' },
  statusPending: { color: semantic.secondary, backgroundColor: semantic.raised },
  statusAnswered: { color: semantic.success, backgroundColor: semantic.successSurface },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '700', color: semantic.secondary, marginTop: 4 },
  paragraph: { fontSize: 15, lineHeight: 22 },
  body: { fontSize: 15, lineHeight: 22 },
  caption: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  error: { fontSize: 14, lineHeight: 21, color: semantic.warning },
  done: { fontSize: 14, lineHeight: 21, color: semantic.success, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: semantic.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, minHeight: 160, backgroundColor: semantic.input, color: semantic.text },
  confirm: { gap: 10, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: semantic.warning, backgroundColor: semantic.raised },
  confirmTitle: { fontSize: 16, lineHeight: 24, fontWeight: '700' },
});
