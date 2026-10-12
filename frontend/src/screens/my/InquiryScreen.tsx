import React, { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHeaderHeight } from '@react-navigation/elements';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { createIdempotencyKey } from '../../utils/idempotency';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import { getApiErrorCode, getApiErrorDisplayMessage, getApiErrorInfo } from '../../services/api/errorMapper';
import {
  createInquiry, getMyInquiries, INQUIRY_CATEGORIES, INQUIRY_LIMITS, InquiryResponseError,
  type InquiryCategory, type InquiryDto, type InquiryRequest,
} from '../../features/inquiry/api';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import WhaleLoader from '../../components/states/WhaleLoader';

type Attempt = { request: InquiryRequest; running: boolean; uncertain?: boolean };
const length = (value: string) => [...value.trim()].length;
const categoryLabel = (key: InquiryCategory) => INQUIRY_CATEGORIES.find(item => item.key === key)?.label ?? '기타';
const formatDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

/**
 * 문의하기: type, title and body sent to the authenticated inquiry API. A
 * receipt is shown only for a server-confirmed inquiry. A repeated tap or a
 * retry after an unknown result reuses the same request id, so the same
 * inquiry is never filed twice; any edit starts a new request.
 */
export default function InquiryScreen() {
  const queryClient = useQueryClient();
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
  const list = useQuery({ queryKey: QUERY_KEYS.inquiries.mine, queryFn: ({ signal }) => getMyInquiries(signal) });
  const mutation = useMutation({
    mutationFn: createInquiry,
    retry: false,
    onSuccess: ({ inquiry }) => {
      attempt.current = null;
      setReceipt(inquiry);
      setCategory(null); setTitle(''); setContent(''); setFailure(null);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.inquiries.mine });
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
      <KeyboardAvoidingView style={styles.screen} keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView testID="inquiry-screen" ref={inputScroll.scrollRef} onLayout={inputScroll.revealFocusedInput}
          onContentSizeChange={inputScroll.revealFocusedInput} onScroll={inputScroll.onScroll} scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
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
            <Text style={styles.heading}>내 문의 내역</Text>
            {list.isLoading ? <WhaleLoader size={28} accessibilityLabel="문의 내역을 불러오는 중" />
              : list.isError ? (
                <View style={styles.historyError}>
                  <Text style={styles.error}>문의 내역을 불러오지 못했습니다.</Text>
                  <CTAButton variant="neutral" label="다시 시도" onPress={() => void list.refetch()} />
                </View>
              ) : !list.data?.length ? <Text style={styles.caption}>아직 접수한 문의가 없습니다.</Text>
                : list.data.map(item => (
                  <View key={item.id} testID={`inquiry-item-${item.id}`} style={styles.historyRow}>
                    <Text style={styles.historyTitle}>{item.title}</Text>
                    <Text style={styles.caption}>{categoryLabel(item.category)} · {formatDate(item.createdAt)} · 접수됨</Text>
                  </View>
                ))}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getHeaderScreenContentStyle(Platform.OS), gap: 12 },
  card: { padding: 16, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface, gap: 10 },
  heading: { fontSize: 16, lineHeight: 24, fontWeight: '700' },
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
  historyRow: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: semantic.border, gap: 2 },
  historyTitle: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
});
