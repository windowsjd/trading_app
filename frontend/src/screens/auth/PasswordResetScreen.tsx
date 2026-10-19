import React, { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { PasswordResetScreenProps } from '../../app/navigation/types';
import { resetPassword } from '../../features/auth/api';
import { useEmailVerification } from '../../features/auth/useEmailVerification';
import { getApiErrorCode, getApiErrorDisplayMessage } from '../../services/api/errorMapper';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import { Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import AuthFormLayout, { AuthActionLabel, AuthField, AuthSubmitBox } from './AuthFormLayout';
import EmailVerificationPanel from './EmailVerificationPanel';

export default function PasswordResetScreen({ route, navigation }: PasswordResetScreenProps) {
  const scroll = useFocusedInputScroll();
  const [email, setEmail] = useState(route?.params?.email ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const verification = useEmailVerification(email, 'password_reset');
  const fence = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setPassword(''); setConfirmPassword(''); setError(null); setFieldError(null); }, [email]);
  const mutation = useMutation({
    mutationFn: async (payload: Parameters<typeof resetPassword>[0]) => {
      const result = await resetPassword(payload);
      if (result.changed !== true) {
        // @diagnosticSurface internal: Rejects malformed success responses; public text uses the existing fixed error mapper.
        throw new Error('Password reset did not complete.');
      }
      return result;
    },
    onSuccess: () => {
      if (!mounted.current) return;
      verification.clear(); setPassword(''); setConfirmPassword(''); setError(null); setFieldError(null); setComplete(true);
    },
    onError: (cause: unknown) => {
      if (!mounted.current) return;
      setError(cause);
      if (getApiErrorCode(cause) === 'EMAIL_VERIFICATION_REQUIRED') verification.invalidate();
    },
    onSettled: () => { fence.current = false; },
  });
  const busy = mutation.isPending || verification.busy;
  const submitDisabled = busy;
  const submit = () => {
    if (fence.current || busy) return;
    setError(null); setFieldError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setFieldError('이메일 형식을 확인해주세요.'); return; }
    if (!verification.verificationToken) { if (!verification.hasRequested) void verification.request(); return; }
    if (password.length < 8) { setFieldError('비밀번호는 8자 이상이어야 합니다.'); return; }
    if (password !== confirmPassword) { setFieldError('비밀번호 확인이 일치하지 않습니다.'); return; }
    fence.current = true;
    mutation.mutate({ email, password, verificationToken: verification.verificationToken });
  };
  return <AuthFormLayout testID="auth-password-reset" scroll={scroll}>
    <Text style={styles.title}>{verification.verificationToken ? '새 비밀번호 설정' : '비밀번호 재설정'}</Text>
    {complete ? <Text testID="password-reset-complete" style={styles.message}>비밀번호가 변경되었습니다. 새로운 비밀번호로 로그인해주세요.</Text> : <>
      <Text style={styles.message}>가입하신 이메일 주소를 입력하시면 인증번호를 보내드립니다.</Text>
      <AuthField scroll={scroll} testID="password-reset-email" accessibilityLabel="가입한 이메일" value={email}
        onChangeText={setEmail} editable={!busy} keyboardType="email-address" autoCapitalize="none"
        placeholder="이메일" style={styles.input} />
      <EmailVerificationPanel verification={verification} scroll={scroll} disabled={mutation.isPending} />
      {verification.verificationToken ? <>
        <AuthField scroll={scroll} testID="password-reset-password" accessibilityLabel="새 비밀번호" value={password}
          onChangeText={setPassword} editable={!busy} secureTextEntry autoComplete="new-password" placeholder="새 비밀번호 (8자 이상)" style={styles.input} />
        <AuthField scroll={scroll} testID="password-reset-confirm" accessibilityLabel="새 비밀번호 확인" value={confirmPassword}
          onChangeText={setConfirmPassword} editable={!busy} secureTextEntry autoComplete="new-password" placeholder="새 비밀번호 확인" style={styles.input} />
      </> : null}
      {error || fieldError ? <Text accessibilityRole="alert" style={styles.error}>{fieldError ?? getApiErrorDisplayMessage(error)}</Text> : null}
      {!verification.hasRequested || verification.verificationToken ? <AuthSubmitBox scroll={scroll}>
        <ActionPressable testID="password-reset-submit" primary onPress={submit}
          disabled={submitDisabled}
          style={styles.button} accessibilityRole="button" accessibilityState={{ busy, disabled: submitDisabled }}>
          <AuthActionLabel busy={busy} label={verification.verificationToken ? '비밀번호 변경' : '인증번호 발송'} textStyle={styles.buttonText} />
        </ActionPressable>
      </AuthSubmitBox> : null}
    </>}
    <ActionPressable testID="password-reset-login" onPress={() => navigation.replace('Login')} disabled={busy}
      style={styles.back} accessibilityRole="button"><Text style={styles.backText}>로그인으로 돌아가기</Text></ActionPressable>
  </AuthFormLayout>;
}

const styles = StyleSheet.create({
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center', color: semantic.text },
  message: { fontSize: 16, color: semantic.secondary, flexShrink: 1 },
  input: { borderWidth: 1, borderColor: semantic.border, borderRadius: 12, padding: 14, fontSize: 16,
    backgroundColor: semantic.input, color: semantic.text },
  button: { borderRadius: 12, padding: 14, alignItems: 'center', backgroundColor: semantic.selected },
  buttonText: { fontSize: 16, fontWeight: '700', color: semantic.onAccent, textAlign: 'center', flexShrink: 1 },
  back: { borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: semantic.border },
  backText: { fontSize: 16, color: semantic.text, textAlign: 'center', flexShrink: 1 },
  error: { fontSize: 14, color: semantic.error, flexShrink: 1 },
});
