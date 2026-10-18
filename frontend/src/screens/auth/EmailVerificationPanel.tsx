import React from 'react';
import { Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import { AuthField, type AuthFormScroll } from './AuthFormLayout';
import type { useEmailVerification } from '../../features/auth/useEmailVerification';

export default function EmailVerificationPanel({ verification: v, scroll, disabled = false }: {
  verification: ReturnType<typeof useEmailVerification>; scroll: AuthFormScroll; disabled?: boolean;
}) {
  const blocked = disabled || v.busy;
  return <>
    {v.challenge && !v.verificationToken && !v.proofExpired ? <>
      <Text style={styles.message}>{v.challenge.message}</Text>
      <AuthField scroll={scroll} testID="email-verification-code" accessibilityLabel="6자리 인증번호"
        value={v.code} onChangeText={(text) => v.setCode(text.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad" autoComplete="one-time-code" maxLength={6} editable={!blocked}
        placeholder="6자리 인증번호" style={styles.input} />
      <Text testID="email-verification-timer" style={styles.message}>{v.secondsLeft > 0
        ? `남은 유효시간 ${Math.floor(v.secondsLeft / 60)}:${String(v.secondsLeft % 60).padStart(2, '0')}`
        : '인증번호가 만료되었습니다. 새 인증번호를 요청해주세요.'}</Text>
      <ActionPressable testID="email-verification-verify" disabled={blocked || !v.secondsLeft}
        onPress={() => { void v.verify(); }} style={styles.button} accessibilityRole="button">
        <Text style={styles.label}>{v.busy ? '처리 중…' : '인증번호 확인'}</Text>
      </ActionPressable>
    </> : null}
    {v.verificationToken ? <Text style={styles.message}>이메일 인증이 완료되었습니다.</Text> : null}
    {v.proofExpired ? <Text style={styles.error}>인증이 만료되었습니다. 새 인증번호를 요청해주세요.</Text> : null}
    {v.challenge || v.proofExpired ? <ActionPressable testID="email-verification-resend" style={styles.button}
      disabled={blocked || v.resendSeconds > 0} onPress={() => { void v.request(); }} accessibilityRole="button">
      <Text style={styles.label}>{v.resendSeconds > 0 ? `${v.resendSeconds}초 후 재발송` : '인증번호 재발송'}</Text>
    </ActionPressable> : null}
    {v.error ? <Text accessibilityRole="alert" style={styles.error}>{v.error}</Text> : null}
  </>;
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderColor: semantic.border, borderRadius: 12, padding: 14, fontSize: 16,
    backgroundColor: semantic.input, color: semantic.text },
  button: { borderRadius: 12, borderWidth: 1, borderColor: semantic.selected, padding: 14, alignItems: 'center' },
  label: { fontSize: 16, fontWeight: '600', color: semantic.text, textAlign: 'center', flexShrink: 1 },
  message: { color: semantic.secondary, fontSize: 14, flexShrink: 1 },
  error: { color: semantic.error, fontSize: 14, flexShrink: 1 },
});
