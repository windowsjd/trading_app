import React from 'react';
import { View, Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import { AuthActionLabel, AuthField, AuthSubmitBox, type AuthFormScroll } from './AuthFormLayout';
import type { useEmailVerification } from '../../features/auth/useEmailVerification';

export default function EmailVerificationPanel({ verification: v, scroll, disabled = false }: {
  verification: ReturnType<typeof useEmailVerification>; scroll: AuthFormScroll; disabled?: boolean;
}) {
  const blocked = disabled || v.busy;
  const showCode = Boolean(v.challenge && !v.verificationToken && !v.proofExpired);
  const verifyDisabled = blocked || !v.secondsLeft || v.codeBlocked;
  const resendDisabled = blocked || v.resendSeconds > 0;
  return <>
    {showCode ? <>
      <Text style={styles.message}>{v.challenge?.message}</Text>
      <AuthField scroll={scroll} testID="email-verification-code" accessibilityLabel="6자리 인증번호"
        value={v.code} onChangeText={(text) => v.setCode(text.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad" autoComplete="one-time-code" maxLength={6} editable={!blocked && !v.codeBlocked}
        placeholder="6자리 인증번호" style={styles.input} />
      <Text testID="email-verification-timer" style={styles.message}>{v.secondsLeft > 0
        ? `남은 유효시간 ${Math.floor(v.secondsLeft / 60)}:${String(v.secondsLeft % 60).padStart(2, '0')}`
        : '인증번호가 만료되었습니다. 새 인증번호를 요청해주세요.'}</Text>
    </> : null}
    {v.verificationToken ? <Text style={styles.message}>이메일 인증이 완료되었습니다.</Text> : null}
    {v.proofExpired ? <Text style={styles.error}>인증이 만료되었습니다. 새 인증번호를 요청해주세요.</Text> : null}
    {v.hasRequested && !v.verificationToken ? <AuthSubmitBox scroll={scroll}>
      <View testID="email-verification-actions" style={styles.actions}>
        {showCode ? <ActionPressable testID="email-verification-verify" disabled={verifyDisabled}
          accessibilityState={{ busy: v.busyAction === 'verify', disabled: verifyDisabled }}
          onPress={() => { void v.verify(); }} style={styles.button} accessibilityRole="button">
          <AuthActionLabel busy={v.busyAction === 'verify'} label="인증번호 확인" textStyle={styles.label} />
        </ActionPressable> : null}
        <ActionPressable testID="email-verification-resend" style={styles.button}
          accessibilityState={{ busy: v.busyAction === 'request', disabled: resendDisabled }}
          disabled={resendDisabled} onPress={() => { void v.request(); }} accessibilityRole="button">
          <AuthActionLabel busy={v.busyAction === 'request'} label={v.busyAction !== 'request' && v.resendSeconds > 0 ? `${v.resendSeconds}초 후 재발송` : '인증번호 재발송'} textStyle={styles.label} />
        </ActionPressable>
      </View>
    </AuthSubmitBox> : null}
    {v.codeBlocked && !v.busy ? <Text style={styles.error}>새 인증번호를 재발송해 다시 인증해주세요.</Text> : null}
    {v.error ? <Text accessibilityRole="alert" style={styles.error}>{v.error}</Text> : null}
  </>;
}

const styles = StyleSheet.create({
  actions: { gap: 12 },
  input: { borderWidth: 1, borderColor: semantic.border, borderRadius: 12, padding: 14, fontSize: 16,
    backgroundColor: semantic.input, color: semantic.text },
  button: { borderRadius: 12, borderWidth: 1, borderColor: semantic.selected, padding: 14, alignItems: 'center' },
  label: { fontSize: 16, fontWeight: '600', color: semantic.text, textAlign: 'center', flexShrink: 1 },
  message: { color: semantic.secondary, fontSize: 14, flexShrink: 1 },
  error: { color: semantic.error, fontSize: 14, flexShrink: 1 },
});
