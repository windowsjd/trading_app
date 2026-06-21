import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  SafeAreaView,
} from 'react-native';
import { useMutation } from '@tanstack/react-query';

import type { LoginScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import {
  resetToSeasonEntry,
  resetToSeasonJoin,
} from '../../app/navigation/seasonRouting';
import { login } from '../../features/auth/api';
import { clearTokens, saveTokens } from '../../services/storage/tokenStorage';
import { getCurrentSeason } from '../../features/season/api';
import {
  getApiErrorCode,
  getErrorMessageFromCode,
  isAuthUserInactiveError,
} from '../../services/api/errorMapper';
import { TEST_IDS } from '../../constants/testIds';
import { ERROR_CODE } from '../../models/enums/errorCode';
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
    return '정지된 계정입니다. 고객센터에 문의해주세요.';
  }
  if (state === 'auth_deleted') {
    return '삭제된 계정입니다. 고객센터에 문의해주세요.';
  }
  return getErrorMessageFromCode(ERROR_CODE.USER_NOT_ACTIVE);
}

export default function LoginScreen({ navigation }: LoginScreenProps) {
  const rootNavigation = useRootNavigation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [blockedAuthState, setBlockedAuthState] =
    useState<AuthViewState | null>(null);

  const loginMutation = useMutation({
    mutationFn: login,
    onSuccess: async (result) => {
      setSubmitError(null);
      setBlockedAuthState(null);

      await saveTokens(
        result.tokens.accessToken,
        result.tokens.refreshToken,
      );

      if (result.user.status !== 'active') {
        await clearTokens();
        const nextBlockedState = getBlockedAuthState(result.user.status);
        setBlockedAuthState(nextBlockedState);
        setSubmitError(getBlockedAuthMessage(nextBlockedState));
        return;
      }

      try {
        const season = await getCurrentSeason();
        resetToSeasonEntry(rootNavigation, season);
      } catch (error) {
        const code = getApiErrorCode(error);

        if (isAuthUserInactiveError(code)) {
          await clearTokens();
          setSubmitError(getBlockedAuthMessage(null));
          return;
        }

        if (code === ERROR_CODE.SEASON_NOT_FOUND) {
          resetToSeasonJoin(rootNavigation);
          return;
        }

        setSubmitError(getErrorMessageFromCode(code));
      }
    },
    onError: (error: unknown) => {
      const code = getApiErrorCode(error);
      setBlockedAuthState(null);
      setSubmitError(
        isAuthUserInactiveError(code)
          ? getBlockedAuthMessage(null)
          : getErrorMessageFromCode(code) || '이메일 또는 비밀번호를 확인해주세요.',
      );
    },
  });

  const authState: AuthViewState = useMemo(() => {
    if (loginMutation.isPending) return 'auth_submitting';
    if (fieldError) return 'auth_invalid_input';
    if (blockedAuthState) return blockedAuthState;
    if (submitError) return 'auth_failed';
    return 'auth_idle';
  }, [loginMutation.isPending, fieldError, blockedAuthState, submitError]);

  const onSubmit = () => {
    setFieldError(null);
    setSubmitError(null);
    setBlockedAuthState(null);

    if (!isValidEmail(email)) {
      setFieldError('이메일 형식을 확인해주세요.');
      return;
    }

    if (!password || password.length < 8) {
      setFieldError('비밀번호를 확인해주세요.');
      return;
    }

    loginMutation.mutate({
      email,
      password,
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <View testID={TEST_IDS.auth.loginScreen} style={styles.content}>
        <Text style={styles.logo}>Trading League</Text>

        <TextInput
          testID={TEST_IDS.auth.loginEmailInput}
          value={email}
          onChangeText={setEmail}
          placeholder="이메일"
          keyboardType="email-address"
          autoCapitalize="none"
          style={styles.input}
        />

        <TextInput
          testID={TEST_IDS.auth.loginPasswordInput}
          value={password}
          onChangeText={setPassword}
          placeholder="비밀번호"
          secureTextEntry
          style={styles.input}
        />

        {authState === 'auth_invalid_input' && fieldError ? (
          <Text style={styles.errorText}>{fieldError}</Text>
        ) : null}

        {(authState === 'auth_failed' ||
          authState === 'auth_suspended' ||
          authState === 'auth_deleted') &&
        submitError ? (
          <Text style={styles.errorText}>{submitError}</Text>
        ) : null}

        <Pressable
          testID={TEST_IDS.auth.loginSubmit}
          style={styles.primaryButton}
          onPress={onSubmit}
          disabled={loginMutation.isPending}
        >
          <Text style={styles.primaryButtonText}>
            {loginMutation.isPending ? '로그인 중...' : '로그인'}
          </Text>
        </Pressable>

        <Pressable
          style={styles.secondaryButton}
          onPress={() => navigation.navigate('Signup')}
        >
          <Text style={styles.secondaryButtonText}>회원가입</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    gap: 12,
  },
  logo: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    backgroundColor: '#fff',
  },
  primaryButton: {
    backgroundColor: '#111',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#111',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#111',
    fontSize: 16,
    fontWeight: '700',
  },
  errorText: {
    color: '#c62828',
    lineHeight: 20,
  },
});
