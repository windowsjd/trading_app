import { useEmailVerification } from '../../features/auth/useEmailVerification';
import EmailVerificationPanel from './EmailVerificationPanel';
import AuthCheckbox from './AuthCheckbox';
import { semantic } from '../../theme/tokens';
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet } from '../../theme/native';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import AuthFormLayout, { AuthField, AuthSubmitBox } from './AuthFormLayout';
import ActionPressable from '../../components/common/ActionPressable';
import WhaleLoader from '../../components/states/WhaleLoader';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { SignupScreenProps } from '../../app/navigation/types';
import { signup, type SignupRequestDto } from '../../features/auth/api';
import { authenticateSession, endSession } from '../../features/auth/session';
import { useEnterApp } from '../../features/auth/useEnterApp';
import {
  isCurrentSession,
  SessionSupersededError,
} from '../../services/api/sessionOwnership';
import {
  getApiErrorCode,
  getApiErrorDisplayMessage,
  getErrorMessageFromCode,
  isAuthUserInactiveError,
} from '../../services/api/errorMapper';
import { TEST_IDS } from '../../constants/testIds';
import { ERROR_CODE } from '../../models/enums/errorCode';
import {
  AGE_CONFIRMATION_LABEL,
  BLOCKED_ACCOUNT_MESSAGES,
  PRIVACY_AGREEMENT_LABEL,
  PRIVACY_VERSION,
  TERMS_AGREEMENT_LABEL,
  TERMS_VERSION,
} from '../../constants/legal';
import type { AuthViewState } from '../../models/enums/viewState';
import type { UserStatus } from '../../models/dto/user';

function isValidEmail(value: string) {
  return /\S+@\S+\.\S+/.test(value);
}

/**
 * The required boxes still unchecked, by name, for "…에 체크해주세요." Each box
 * is its own consent: none implies another, and opening a document's 자세히
 * 보기 checks nothing.
 */
export function missingSignupConsents(consent: { age: boolean; terms: boolean; privacy: boolean }): string[] {
  return [
    ...(consent.age ? [] : ['만 16세 이상 확인']),
    ...(consent.terms ? [] : ['이용약관 동의']),
    ...(consent.privacy ? [] : ['개인정보처리방침 동의']),
  ];
}

function getBlockedAuthState(status: UserStatus): AuthViewState | null {
  if (status === 'suspended') return 'auth_suspended';
  if (status === 'deleted') return 'auth_deleted';
  return null;
}

function getBlockedAuthMessage(state: AuthViewState | null) {
  if (state === 'auth_suspended') {
    return BLOCKED_ACCOUNT_MESSAGES.suspended;
  }
  if (state === 'auth_deleted') {
    return BLOCKED_ACCOUNT_MESSAGES.deleted;
  }
  return getErrorMessageFromCode(ERROR_CODE.USER_NOT_ACTIVE);
}

export default function SignupScreen({ navigation }: SignupScreenProps) {
  const enterApp = useEnterApp();
  const scroll = useFocusedInputScroll();

  const [email, setEmail] = useState('');
  const verification = useEmailVerification(email, 'signup');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // Three required boxes, each separate and never pre-checked (2026-11-13).
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [privacyAgreed, setPrivacyAgreed] = useState(false);

  const queryClient = useQueryClient();

  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [blockedAuthState, setBlockedAuthState] =
    useState<AuthViewState | null>(null);

  // Fences a second tap before React re-renders the pending state.
  const inFlight = useRef(false);
  const signupMutation = useMutation({
    mutationFn: (payload: SignupRequestDto) =>
      authenticateSession(queryClient, () => signup(payload)),
    onSuccess: async (result) => {
      if (!isCurrentSession(result.generation)) return;
      setSubmitError(null);
      setBlockedAuthState(null);

      if (result.user.status !== 'active') {
        await endSession(queryClient, undefined, { generation: result.generation });
        const nextBlockedState = getBlockedAuthState(result.user.status);
        setBlockedAuthState(nextBlockedState);
        setSubmitError(getBlockedAuthMessage(nextBlockedState));
        return;
      }

      try {
        // A brand-new signup is a new login (작업 13 §2): the user chooses
        // 일반 투자 or 시즌 투자 on the mode-selection screen — which also
        // handles their "no accounts yet" state.
        await enterApp(result.user.id, 'new_login', result.generation);
      } catch (error) {
        if (!isCurrentSession(result.generation)) return;
        const code = getApiErrorCode(error);

        if (isAuthUserInactiveError(code)) {
          await endSession(queryClient, undefined, { generation: result.generation });
          setSubmitError(getBlockedAuthMessage(null));
          return;
        }

        // The account list could not be read. That is not "you have no
        // accounts", so the user is not sent to the setup screen: they stay
        // here with the real error and can retry.
        setSubmitError(getApiErrorDisplayMessage(error));
      }
    },
    onError: (error: unknown) => {
      if (error instanceof SessionSupersededError) return;
      const code = getApiErrorCode(error);
      if (code === 'EMAIL_VERIFICATION_REQUIRED') verification.invalidate();
      setBlockedAuthState(null);
      setSubmitError(
        isAuthUserInactiveError(code)
          ? getBlockedAuthMessage(null)
          : getApiErrorDisplayMessage(error),
      );
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const authState: AuthViewState = useMemo(() => {
    if (signupMutation.isPending) return 'auth_submitting';
    if (fieldError) return 'auth_invalid_input';
    if (blockedAuthState) return blockedAuthState;
    if (submitError) return 'auth_failed';
    return 'auth_idle';
  }, [signupMutation.isPending, fieldError, blockedAuthState, submitError]);

  const submitDisabled = signupMutation.isPending || verification.busy;

  const onSubmit = () => {
    if (inFlight.current || signupMutation.isPending || verification.busy) return;
    setFieldError(null);
    setSubmitError(null);
    setBlockedAuthState(null);

    if (!isValidEmail(email)) {
      setFieldError('이메일 형식을 확인해주세요.');
      return;
    }

    if (!nickname.trim()) {
      setFieldError('닉네임을 입력해주세요.');
      return;
    }

    if (!password || password.length < 8) {
      setFieldError('비밀번호는 8자 이상이어야 합니다.');
      return;
    }

    if (password !== confirmPassword) {
      setFieldError('비밀번호 확인이 일치하지 않습니다.');
      return;
    }

    const missing = missingSignupConsents({ age: ageConfirmed, terms: termsAgreed, privacy: privacyAgreed });
    if (missing.length) {
      setFieldError(`${missing.join(', ')}에 체크해주세요.`);
      return;
    }

    if (!verification.verificationToken) {
      if (verification.hasRequested) return;
      void verification.request();
      return;
    }
    inFlight.current = true;
    signupMutation.mutate({
      verificationToken: verification.verificationToken,
      email,
      nickname: nickname.trim(),
      password,
      ageConfirmed: true,
      termsAgreed: true,
      termsVersion: TERMS_VERSION,
      privacyAgreed: true,
      privacyVersion: PRIVACY_VERSION,
    });
  };

  // The document opens over this screen, which keeps every input and box.
  const openDocument = (document: 'terms' | 'privacy') => navigation.navigate('LegalDocument', { document });

  return (
    <AuthFormLayout testID={TEST_IDS.auth.signupScreen} scroll={scroll}>
      <Text style={styles.logo}>회원가입</Text>

      <AuthField
        scroll={scroll}
        testID={TEST_IDS.auth.signupEmailInput}
        editable={!signupMutation.isPending && !verification.busy}
        value={email}
        onChangeText={setEmail}
        placeholder="이메일"
        placeholderTextColor={semantic.placeholder}
        keyboardType="email-address"
        autoCapitalize="none"
        style={styles.input}
      />

      <AuthField
        scroll={scroll}
        testID={TEST_IDS.auth.signupNicknameInput}
        value={nickname}
        onChangeText={setNickname}
        placeholder="닉네임"
        placeholderTextColor={semantic.placeholder}
        style={styles.input}
      />

      <AuthField
        scroll={scroll}
        testID={TEST_IDS.auth.signupPasswordInput}
        value={password}
        onChangeText={setPassword}
        placeholder="비밀번호"
        placeholderTextColor={semantic.placeholder}
        secureTextEntry
        style={styles.input}
      />

      <AuthField
        scroll={scroll}
        testID={TEST_IDS.auth.signupConfirmPasswordInput}
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        placeholder="비밀번호 확인"
        placeholderTextColor={semantic.placeholder}
        secureTextEntry
        style={styles.input}
      />

      <View testID={TEST_IDS.auth.signupConsents} style={styles.consents}>
        <AuthCheckbox
          testID={TEST_IDS.auth.signupAgeCheckbox}
          label={AGE_CONFIRMATION_LABEL}
          checked={ageConfirmed}
          disabled={signupMutation.isPending}
          onChange={setAgeConfirmed}
        />
        <View style={styles.consentRow}>
          <View style={styles.consentBox}>
            <AuthCheckbox
              testID={TEST_IDS.auth.signupTermsCheckbox}
              label={TERMS_AGREEMENT_LABEL}
              checked={termsAgreed}
              disabled={signupMutation.isPending}
              onChange={setTermsAgreed}
            />
          </View>
          <ActionPressable testID={TEST_IDS.auth.signupTermsDetail} accessibilityRole="button"
            accessibilityLabel="이용약관 자세히 보기" onPress={() => openDocument('terms')} style={styles.detail}>
            <Text style={styles.detailText}>자세히 보기</Text>
          </ActionPressable>
        </View>
        <View style={styles.consentRow}>
          <View style={styles.consentBox}>
            <AuthCheckbox
              testID={TEST_IDS.auth.signupPrivacyCheckbox}
              label={PRIVACY_AGREEMENT_LABEL}
              checked={privacyAgreed}
              disabled={signupMutation.isPending}
              onChange={setPrivacyAgreed}
            />
          </View>
          <ActionPressable testID={TEST_IDS.auth.signupPrivacyDetail} accessibilityRole="button"
            accessibilityLabel="개인정보처리방침 자세히 보기" onPress={() => openDocument('privacy')} style={styles.detail}>
            <Text style={styles.detailText}>자세히 보기</Text>
          </ActionPressable>
        </View>
      </View>

      {authState === 'auth_invalid_input' && fieldError ? (
        <Text style={styles.errorText}>{fieldError}</Text>
      ) : null}

      {(authState === 'auth_failed' ||
        authState === 'auth_suspended' ||
        authState === 'auth_deleted') &&
      submitError ? (
        // Selectable: the support address can be long-pressed and copied.
        <Text style={styles.errorText} selectable>{submitError}</Text>
      ) : null}

      <EmailVerificationPanel verification={verification} scroll={scroll} disabled={signupMutation.isPending || verification.busy} />

      {!verification.hasRequested || verification.verificationToken ? <AuthSubmitBox scroll={scroll}>
        <ActionPressable
          testID={TEST_IDS.auth.signupSubmit}
          primary
          style={styles.primaryButton}
          onPress={onSubmit}
          disabled={submitDisabled}
          // Busy keeps the brand background; the whale replaces the label.
          accessibilityRole="button"
          accessibilityLabel={signupMutation.isPending ? '가입 중' : verification.busy ? '처리 중' : verification.verificationToken ? '회원가입' : '인증번호 발송'}
          accessibilityState={{ disabled: submitDisabled, busy: signupMutation.isPending || verification.busy }}
        >
          <View style={styles.primaryButtonLabel}>
            <Text style={[styles.primaryButtonText, (signupMutation.isPending || verification.busy) && { opacity: 0 }]}>{verification.verificationToken ? '회원가입' : '인증번호 발송'}</Text>
            {signupMutation.isPending || verification.busy ? <View style={{ position: 'absolute' }}>
              <WhaleLoader size={22} tone="onAction" accessibilityLabel={signupMutation.isPending ? '가입 중' : '인증번호 발송 처리 중'} testID="signup-submit-loading" />
            </View> : null}
          </View>
        </ActionPressable>
      </AuthSubmitBox> : null}

      <ActionPressable
        style={styles.secondaryButton}
        disabled={signupMutation.isPending || verification.busy}
        onPress={() => navigation.replace('Login')}
      >
        <Text style={styles.secondaryButtonText}>로그인으로 돌아가기</Text>
      </ActionPressable>
    </AuthFormLayout>
  );
}

const styles = StyleSheet.create({
  logo: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  input: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    backgroundColor: semantic.input,
    color: semantic.text,
  },
  primaryButton: {
    backgroundColor: semantic.selected,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  // One height for the label and the loader, so pressing never resizes it.
  primaryButtonLabel: { minHeight: 22, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: {
    color: semantic.onAccent,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    flexShrink: 1,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: semantic.selected,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: semantic.text,
    fontSize: 16,
    fontWeight: '700',
  },
  errorText: {
    color: semantic.error,
    fontSize: 14,
  },
  consents: { gap: 2 },
  // The box's label wraps beside 자세히 보기 (320 pt screens, large text).
  consentRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  consentBox: { flex: 1, minWidth: 0 },
  detail: { minHeight: 44, minWidth: 44, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  detailText: {
    color: semantic.secondaryActionForeground,
    fontSize: 14,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
});
