import React, { useEffect, useRef, useState } from 'react';
import type { MembershipDeletionResultScreenProps } from '../../app/navigation/types';
import { getApiErrorDisplayMessage } from '../../services/api/errorMapper';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import { Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { formatKstDateTime } from '../../utils/format';
import { getMembershipDeletionStatus } from '../../features/me/membershipDeletionApi';
import {
  forgetMembershipDeletion,
  membershipDeletionRequestKey,
} from '../../features/me/membershipDeletionFlow';
import ActionPressable from '../../components/common/ActionPressable';
import AuthFormLayout from './AuthFormLayout';

/**
 * Shown once a 회원탈퇴 is confirmed by the server, after the session ended.
 * The status is the server receipt's: `completed` only when every record and
 * the profile photo file are gone. A pending photo removal can be checked
 * again here (public status lookup by the attempt's in-memory key).
 */
export default function MembershipDeletionResultScreen({ route, navigation }: MembershipDeletionResultScreenProps) {
  const scroll = useFocusedInputScroll();
  const [receipt, setReceipt] = useState(route.params);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<unknown>(null);
  const requestKey = membershipDeletionRequestKey();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const pending = receipt.status === 'cleanup_pending';

  const recheck = async () => {
    if (!requestKey || checking) return;
    setChecking(true);
    setCheckError(null);
    try {
      const latest = await getMembershipDeletionStatus(requestKey);
      if (latest && mounted.current) setReceipt(latest);
    } catch (error) {
      if (mounted.current) setCheckError(error);
    } finally {
      if (mounted.current) setChecking(false);
    }
  };
  const done = () => {
    forgetMembershipDeletion();
    navigation.replace('Login');
  };

  return (
    <AuthFormLayout testID="membership-deletion-result" scroll={scroll}>
      <Text accessibilityRole="header" style={styles.title}>
        {pending ? '회원탈퇴가 처리되었습니다' : '회원탈퇴가 완료되었습니다'}
      </Text>
      <Text testID="membership-deletion-result-message" style={styles.message}>
        {pending
          ? '계정과 개인정보, 가상 투자 기록은 삭제되어 더 이상 로그인할 수 없습니다. 프로필 사진 파일은 아직 정리 중이며 7일 이내 완료를 목표로 처리됩니다.'
          : '계정과 개인정보, 가상 투자 기록이 삭제되었습니다. 정산이 끝난 시즌의 최종 순위표에는 안내드린 대로 닉네임 없는 결과만 남을 수 있습니다. 그동안 Trading Class를 이용해 주셔서 감사합니다.'}
      </Text>
      <Text style={styles.caption}>
        {pending ? `탈퇴 처리 ${formatKstDateTime(receipt.deletedAt)}` : `삭제 완료 ${formatKstDateTime(receipt.completedAt ?? receipt.deletedAt)}`}
      </Text>
      {checkError ? (
        <Text testID="membership-deletion-result-error" accessibilityRole="alert" style={styles.error}>
          {getApiErrorDisplayMessage(checkError)}
        </Text>
      ) : null}
      {pending && requestKey ? (
        <ActionPressable testID="membership-deletion-result-recheck" feedback="button" onPress={() => void recheck()}
          disabled={checking} accessibilityRole="button" accessibilityState={{ busy: checking, disabled: checking }} style={styles.secondary}>
          <Text style={styles.secondaryText}>{checking ? '확인 중…' : '처리 상태 다시 확인'}</Text>
        </ActionPressable>
      ) : null}
      <ActionPressable testID="membership-deletion-result-done" primary onPress={done} accessibilityRole="button" style={styles.button}>
        <Text style={styles.buttonText}>확인</Text>
      </ActionPressable>
    </AuthFormLayout>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 26, fontWeight: '700', textAlign: 'center', color: semantic.text, flexShrink: 1 },
  message: { fontSize: 16, lineHeight: 24, color: semantic.secondary, flexShrink: 1 },
  caption: { fontSize: 14, color: semantic.secondary, flexShrink: 1 },
  error: { fontSize: 14, color: semantic.error, flexShrink: 1 },
  button: { borderRadius: 12, padding: 14, alignItems: 'center', backgroundColor: semantic.selected },
  buttonText: { fontSize: 16, fontWeight: '700', color: semantic.onAccent, textAlign: 'center', flexShrink: 1 },
  secondary: { borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: semantic.border },
  secondaryText: { fontSize: 16, color: semantic.text, textAlign: 'center', flexShrink: 1 },
});
