import React, { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useHeaderHeight } from '@react-navigation/elements';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MyStackParamList } from '../../app/navigation/types';
import {
  isOnMembershipDeletionResult,
  resetToMembershipDeletionResultFromRef,
} from '../../app/navigation/navigationRef';
import { KeyboardAvoidingView, Keyboard, Platform, ScrollView, StyleSheet, Text, TextInput, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import { getApiErrorCode } from '../../services/api/errorMapper';
import { endSession } from '../../features/auth/session';
import { clearSelectedAccountId } from '../../features/tradingAccount/selectionStorage';
import type { MeDto } from '../../features/me/api';
import {
  checkMembershipPassword,
  deleteMembership,
  getMembershipDeletionStatus,
} from '../../features/me/membershipDeletionApi';
import {
  confirmMembershipDeletion,
  createMembershipDeletionKey,
  rememberMembershipDeletion,
  settleMembershipDeletion,
  type MembershipDeletionOutcome,
  type MembershipDeletionReceipt,
} from '../../features/me/membershipDeletionFlow';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';

type Step = 'notice' | 'verify' | 'confirm';
// Fixed copy for outcomes the server could not explain; ErrorNotice still gets the original error.
const OUTCOME_COPY = {
  not_deleted: '탈퇴가 처리되지 않았습니다. 계정은 그대로 유지됩니다. 다시 시도해주세요.',
  unknown: '탈퇴 처리 결과를 확인하지 못했습니다. 네트워크 연결을 확인한 뒤 결과를 다시 확인해주세요.',
} as const;
type Failure = { error: unknown; outcome?: keyof typeof OUTCOME_COPY };

const DELETED = [
  '탈퇴하면 이 계정으로 다시 로그인할 수 없습니다.',
  '초보·일반·시즌 가상 투자계정과 보유 가상자산(현금, 주식, 코인, 선물 포지션)이 모두 삭제됩니다.',
  '미체결 주문, 조건주문, 지정가 예약금은 체결하거나 청산하지 않고 함께 삭제됩니다.',
  '주문·체결·환전·이체 기록과 수익률 등 투자 성과가 삭제됩니다.',
  '친구 관계, 닉네임과 프로필 사진, 알림 설정, 문의 내역, 보상과 배지가 삭제됩니다.',
  '삭제된 계정과 기록은 복구할 수 없습니다. 같은 이메일로 다시 가입하면 새 계정으로 시작합니다.',
];
const KEPT = [
  '이미 정산이 끝난 시즌의 최종 순위표에는 다른 참가자의 확정 순위와 등급을 지키기 위해 회원님의 최종 순위·총자산·수익률만 닉네임과 프로필 사진 없이 "탈퇴한 회원"으로 남습니다.',
  '진행 중이거나 정산 전인 시즌의 기록은 삭제되고 이후 순위에서 제외됩니다.',
  '서버 백업과 운영 기록에 남은 정보는 별도의 보존·파기 정책에 따라 처리됩니다.',
];

/**
 * 회원탈퇴: 안내 확인 → 비밀번호 본인 확인 → 최종 확인. Nothing is sent
 * until 본인 확인, and nothing changes until the final 탈퇴하기; leaving or
 * cancelling at any step changes nothing.
 *
 * The outcome is the server's: a lost response is resolved by the receipt
 * stored under this attempt's request key, and a retry reuses that key. Once
 * deleted, the session ends exactly like logout (cache, tokens, this user's
 * account selection; push release and sockets follow the ended session) and
 * the auth stack opens on the result. The password lives only in this
 * screen's state.
 */
export default function MembershipDeletionScreen({ navigation }: NativeStackScreenProps<MyStackParamList, 'MembershipDeletion'>) {
  const queryClient = useQueryClient();
  // Read once: the userId keys this user's local account selection.
  const userId = useRef(queryClient.getQueryData<MeDto>(QUERY_KEYS.me)?.id ?? null).current;
  const headerHeight = useHeaderHeight();
  const inputScroll = useFocusedInputScroll();
  const passwordRef = useRef<View>(null);
  const [step, setStep] = useState<Step>('notice');
  const [acknowledged, setAcknowledged] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [recheck, setRecheck] = useState(false);
  const requestKey = useRef<string | null>(null);
  const fence = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const finish = async (receipt: MembershipDeletionReceipt, key: string) => {
    rememberMembershipDeletion(key);
    const params = { status: receipt.status, deletedAt: receipt.deletedAt, completedAt: receipt.completedAt };
    try {
      await endSession(queryClient, userId, { resetToLogin: () => resetToMembershipDeletionResultFromRef(params) });
    } finally {
      // An expiry teardown that won the race skipped both of these.
      if (userId) await clearSelectedAccountId(userId);
      if (!isOnMembershipDeletionResult()) resetToMembershipDeletionResultFromRef(params);
    }
  };

  const apply = async (outcome: MembershipDeletionOutcome, key: string) => {
    if (outcome.kind === 'deleted') {
      await finish(outcome.receipt, key);
      return;
    }
    fence.current = false;
    if (!mounted.current) return;
    setBusy(false);
    setRecheck(outcome.kind === 'unknown');
    if (outcome.kind === 'refused') {
      // The password changed since 본인 확인: confirm it again.
      if (outcome.code === 'ACCOUNT_DELETION_PASSWORD_MISMATCH') {
        setPassword('');
        setStep('verify');
      }
      setFailure({ error: outcome.error });
    } else {
      setFailure({ error: outcome.error, outcome: outcome.kind });
    }
  };

  const verify = async () => {
    if (fence.current || !password) return;
    fence.current = true;
    Keyboard.dismiss();
    setBusy(true);
    setFailure(null);
    try {
      await checkMembershipPassword(password);
      if (mounted.current) setStep('confirm');
    } catch (error) {
      if (mounted.current) {
        setFailure({ error });
        if (getApiErrorCode(error) === 'ACCOUNT_DELETION_PASSWORD_MISMATCH') setPassword('');
      }
    } finally {
      fence.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const submit = async () => {
    if (fence.current) return;
    fence.current = true;
    setBusy(true);
    setFailure(null);
    setRecheck(false);
    const key = (requestKey.current ??= createMembershipDeletionKey());
    await apply(await settleMembershipDeletion(
      () => deleteMembership({ password, requestKey: key }),
      () => getMembershipDeletionStatus(key),
    ), key);
  };

  const checkAgain = async () => {
    const key = requestKey.current;
    if (fence.current || !key) return;
    fence.current = true;
    setBusy(true);
    setFailure(null);
    await apply(await confirmMembershipDeletion(() => getMembershipDeletionStatus(key), null), key);
  };

  const errorNotice = failure ? (
    <ErrorNotice testID="membership-deletion-error" error={failure.error} message={failure.outcome ? OUTCOME_COPY[failure.outcome] : undefined} style={styles.error} />
  ) : null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.screen}>
      <KeyboardAvoidingView style={styles.screen} keyboardVerticalOffset={headerHeight} behavior="padding">
        <ScrollView testID="membership-deletion-screen" ref={inputScroll.scrollRef} onLayout={inputScroll.revealFocusedInput}
          onContentSizeChange={inputScroll.revealFocusedInput} onScroll={inputScroll.onScroll} scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {step === 'notice' ? (
            <View style={styles.card} testID="membership-deletion-notice">
              <Text accessibilityRole="header" style={styles.title}>회원탈퇴 전에 확인해주세요</Text>
              <Text style={styles.heading}>삭제되는 정보</Text>
              {DELETED.map((line) => <Bullet key={line} text={line} />)}
              <Text style={styles.heading}>남는 정보와 이유</Text>
              {KEPT.map((line) => <Bullet key={line} text={line} />)}
              <ActionPressable feedback="selection" testID="membership-deletion-acknowledge" accessibilityRole="checkbox"
                accessibilityLabel="위 내용을 모두 확인했습니다" accessibilityState={{ checked: acknowledged }} aria-checked={acknowledged}
                onPress={() => setAcknowledged((value) => !value)} style={styles.check}>
                <View style={[styles.box, acknowledged && styles.boxChecked]}>
                  <Text style={styles.boxMark}>{acknowledged ? '✓' : ''}</Text>
                </View>
                <Text style={styles.checkText}>위 내용을 모두 확인했습니다</Text>
              </ActionPressable>
              <CTAButton testID="membership-deletion-next" label="다음" state={acknowledged ? 'enabled' : 'disabled'}
                onPress={() => { setFailure(null); setStep('verify'); }} />
            </View>
          ) : step === 'verify' ? (
            <View style={styles.card} testID="membership-deletion-verify">
              <Text accessibilityRole="header" style={styles.title}>본인 확인</Text>
              <Text style={styles.body}>계정을 보호하기 위해 현재 비밀번호를 입력해주세요.</Text>
              <View ref={passwordRef} collapsable={false}>
                <TextInput testID="membership-deletion-password" accessibilityLabel="현재 비밀번호" value={password}
                  onChangeText={(value) => { setPassword(value); setFailure(null); }} editable={!busy} secureTextEntry
                  autoCapitalize="none" autoComplete="current-password" textContentType="password" placeholder="현재 비밀번호"
                  placeholderTextColor={semantic.placeholder} onSubmitEditing={() => void verify()}
                  onFocus={() => inputScroll.onInputFocus(passwordRef.current)} onBlur={inputScroll.onInputBlur} style={styles.input} />
              </View>
              {errorNotice}
              <View ref={inputScroll.submitRef} collapsable={false} style={styles.actions}>
                <CTAButton testID="membership-deletion-verify-submit" label="확인"
                  state={busy ? 'loading' : password ? 'enabled' : 'disabled'} onPress={() => void verify()} />
                <CTAButton testID="membership-deletion-back" variant="neutral" label="이전"
                  state={busy ? 'disabled' : 'enabled'} onPress={() => { setFailure(null); setStep('notice'); }} />
              </View>
            </View>
          ) : (
            <View style={[styles.card, styles.warning]} testID="membership-deletion-confirm">
              <Text accessibilityRole="header" style={styles.title}>정말 탈퇴하시겠어요?</Text>
              <Text style={styles.body}>탈퇴하기를 누르면 계정과 가상 투자 기록이 바로 삭제되며 되돌릴 수 없습니다.</Text>
              {errorNotice}
              <View style={styles.actions}>
                {recheck ? (
                  <CTAButton testID="membership-deletion-recheck" variant="neutral" label="결과 다시 확인"
                    state={busy ? 'loading' : 'enabled'} onPress={() => void checkAgain()} />
                ) : (
                  <CTAButton testID="membership-deletion-submit" variant="logout" label={busy ? '탈퇴 처리 중' : '탈퇴하기'}
                    state={busy ? 'loading' : 'enabled'} onPress={() => void submit()}
                    accessibilityHint="계정과 가상 투자 기록을 영구히 삭제합니다" />
                )}
                <CTAButton testID="membership-deletion-cancel" variant="neutral" label="취소"
                  state={busy ? 'disabled' : 'enabled'} onPress={() => navigation.goBack()} />
              </View>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bullet}>
      <Text style={styles.bulletMark} accessible={false}>•</Text>
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: getHeaderScreenContentStyle(Platform.OS),
  card: { borderWidth: 1, borderColor: semantic.border, borderRadius: 14, padding: 16, backgroundColor: semantic.surface, gap: 10 },
  warning: { borderColor: semantic.error },
  title: { fontSize: 20, fontWeight: '700', color: semantic.text, flexShrink: 1 },
  heading: { fontSize: 15, fontWeight: '700', color: semantic.text, marginTop: 4 },
  body: { fontSize: 15, lineHeight: 22, color: semantic.secondary, flexShrink: 1 },
  bullet: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  bulletMark: { fontSize: 15, lineHeight: 22, color: semantic.secondary },
  bulletText: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 22, color: semantic.secondary },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingVertical: 6 },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: semantic.border, alignItems: 'center', justifyContent: 'center' },
  boxChecked: { backgroundColor: semantic.selected, borderColor: semantic.selected },
  boxMark: { color: semantic.onAccent, fontWeight: '700' },
  checkText: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600', color: semantic.text },
  input: { borderWidth: 1, borderColor: semantic.border, borderRadius: 12, padding: 14, fontSize: 16, backgroundColor: semantic.input, color: semantic.text },
  actions: { gap: 10 },
  error: { fontSize: 14, lineHeight: 20, color: semantic.error, flexShrink: 1 },
});
