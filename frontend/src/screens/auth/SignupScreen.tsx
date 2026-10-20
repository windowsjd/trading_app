import { useEmailVerification } from '../../features/auth/useEmailVerification';
import EmailVerificationPanel from './EmailVerificationPanel';
import AuthCheckbox from './AuthCheckbox';
import { semantic } from '../../theme/tokens';
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Linking } from '../../theme/native';
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
  LEGAL_LINKS,
  SIGNUP_LEGAL_NOTICE,
  TERMS_VERSION,
} from '../../constants/legal';
import type { AuthViewState } from '../../models/enums/viewState';
import type { UserStatus } from '../../models/dto/user';

function isValidEmail(value: string) {
  return /\S+@\S+\.\S+/.test(value);
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
  // Required and never pre-checked: the only checkbox on this screen.
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

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

    if (!ageConfirmed) {
      setFieldError('만 16세 이상 확인에 체크해주세요.');
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
      termsVersion: TERMS_VERSION,
    });
  };

  // The terms and the privacy policy open in the external browser.
  const openLegalLink = async (url: string) => {
    setLinkError(null);
    try {
      await Linking.openURL(url);
    } catch {
      setLinkError('링크를 열지 못했습니다. 잠시 후 다시 시도해주세요.');
    }
  };

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

      <AuthCheckbox
        testID={TEST_IDS.auth.signupAgeCheckbox}
        label={AGE_CONFIRMATION_LABEL}
        checked={ageConfirmed}
        disabled={signupMutation.isPending}
        onChange={setAgeConfirmed}
      />

      <Text testID={TEST_IDS.auth.signupLegalNotice} style={styles.notice}>
        {SIGNUP_LEGAL_NOTICE.map((part, index) => typeof part === 'string' ? part : (
          <Text key={index} accessibilityRole="link" style={styles.noticeLink}
            testID={part.link === 'terms' ? TEST_IDS.auth.signupTermsLink : TEST_IDS.auth.signupPrivacyLink}
            onPress={() => void openLegalLink(LEGAL_LINKS[part.link])}>
            {part.label}
          </Text>
        ))}
      </Text>

      {linkError ? <Text style={styles.errorText}>{linkError}</Text> : null}

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
  notice: {
    color: semantic.secondary,
    fontSize: 14,
    lineHeight: 20,
  },
  noticeLink: {
    color: semantic.secondaryActionForeground,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
});
