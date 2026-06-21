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

import type { SignupScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import {
  resetToSeasonEntry,
  resetToSeasonJoin,
} from '../../app/navigation/seasonRouting';
import { signup } from '../../features/auth/api';
import { getCurrentSeason } from '../../features/season/api';
import { clearTokens, saveTokens } from '../../services/storage/tokenStorage';
import {
  getApiErrorCode,
  getErrorMessageFromCode,
  isAuthUserInactiveError,
} from '../../services/api/errorMapper';
import { TEST_IDS } from '../../constants/testIds';
import { ERROR_CODE } from '../../models/enums/errorCode';

function isValidEmail(value: string) {
  return /\S+@\S+\.\S+/.test(value);
}

export default function SignupScreen({ navigation }: SignupScreenProps) {
  const rootNavigation = useRootNavigation();

  const [email, setEmail] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const signupMutation = useMutation({
    mutationFn: signup,
    onSuccess: async (result) => {
      setSubmitError(null);

      await saveTokens(
        result.tokens.accessToken,
        result.tokens.refreshToken,
      );

      if (result.user.status !== 'active') {
        await clearTokens();
        setSubmitError(getErrorMessageFromCode(ERROR_CODE.USER_NOT_ACTIVE));
        return;
      }

      try {
        const season = await getCurrentSeason();
        resetToSeasonEntry(rootNavigation, season);
      } catch (error) {
        const code = getApiErrorCode(error);

        if (isAuthUserInactiveError(code)) {
          await clearTokens();
        }

        if (code === ERROR_CODE.SEASON_NOT_FOUND) {
          resetToSeasonJoin(rootNavigation);
          return;
        }

        setSubmitError(getErrorMessageFromCode(code));
      }
    },
    onError: (error: unknown) => {
      setSubmitError(
        getErrorMessageFromCode(getApiErrorCode(error)) ||
          '회원가입에 실패했습니다.',
      );
    },
  });

  const authState = useMemo(() => {
    if (signupMutation.isPending) return 'auth_submitting';
    if (fieldError) return 'auth_invalid_input';
    if (submitError) return 'auth_failed';
    return 'auth_idle';
  }, [signupMutation.isPending, fieldError, submitError]);

  const onSubmit = () => {
    setFieldError(null);
    setSubmitError(null);

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

    signupMutation.mutate({
      email,
      nickname: nickname.trim(),
      password,
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <View testID={TEST_IDS.auth.signupScreen} style={styles.content}>
        <Text style={styles.logo}>회원가입</Text>

        <TextInput
          testID={TEST_IDS.auth.signupEmailInput}
          value={email}
          onChangeText={setEmail}
          placeholder="이메일"
          keyboardType="email-address"
          autoCapitalize="none"
          style={styles.input}
        />

        <TextInput
          testID={TEST_IDS.auth.signupNicknameInput}
          value={nickname}
          onChangeText={setNickname}
          placeholder="닉네임"
          style={styles.input}
        />

        <TextInput
          testID={TEST_IDS.auth.signupPasswordInput}
          value={password}
          onChangeText={setPassword}
          placeholder="비밀번호"
          secureTextEntry
          style={styles.input}
        />

        <TextInput
          testID={TEST_IDS.auth.signupConfirmPasswordInput}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          placeholder="비밀번호 확인"
          secureTextEntry
          style={styles.input}
        />

        {authState === 'auth_invalid_input' && fieldError ? (
          <Text style={styles.errorText}>{fieldError}</Text>
        ) : null}

        {authState === 'auth_failed' && submitError ? (
          <Text style={styles.errorText}>{submitError}</Text>
        ) : null}

        <Pressable
          testID={TEST_IDS.auth.signupSubmit}
          style={styles.primaryButton}
          onPress={onSubmit}
          disabled={signupMutation.isPending}
        >
          <Text style={styles.primaryButtonText}>
            {signupMutation.isPending ? '가입 중...' : '회원가입'}
          </Text>
        </Pressable>

        <Pressable
          style={styles.secondaryButton}
          onPress={() => navigation.replace('Login')}
        >
          <Text style={styles.secondaryButtonText}>로그인으로 돌아가기</Text>
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
