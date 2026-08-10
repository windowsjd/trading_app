import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
  SafeAreaView,
} from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import type { SplashScreenProps } from '../../app/navigation/types';
import { resetToLogin } from '../../app/navigation/seasonRouting';
import { getAccessToken, clearTokens } from '../../services/storage/tokenStorage';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getMe } from '../../features/me/api';
import { useEnterApp } from '../../features/auth/useEnterApp';
import ErrorState from '../../components/states/ErrorState';
import {
  getApiErrorCode,
  getErrorMessageFromCode,
  isAuthUserInactiveError,
} from '../../services/api/errorMapper';

type BootstrapError =
  | { kind: 'inactive'; message: string }
  | { kind: 'retryable' };

export default function SplashScreen({ navigation }: SplashScreenProps) {
  const [bootstrapError, setBootstrapError] = useState<BootstrapError | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  const queryClient = useQueryClient();
  const enterApp = useEnterApp();

  useEffect(() => {
    let mounted = true;

    /**
     * Session restore (작업 11 §3 · 작업 13 §2·§5): token → identity → owned
     * accounts → app.
     *
     * This is the ONE entry that may skip the mode-selection question: the
     * user already answered it, and the stored per-user selection is that
     * answer. `enterApp` with 'session_restore' keeps the stored account only
     * while it is still owned; a missing or no-longer-owned selection lands on
     * mode selection — never silently on the active season.
     *
     * A failure to read identity or accounts is NOT a routing signal: "we
     * could not read" must not become "you own nothing" (or "you are logged
     * out" while the tokens may be fine). Those failures stay here as an
     * explicit retry. Only a missing token routes to login, and only an
     * inactive account shows the terminal notice. A genuinely dead refresh
     * token is handled by the session-expiry teardown, which resets to login
     * on its own.
     */
    async function bootstrap() {
      try {
        const accessToken = await getAccessToken();

        if (!accessToken) {
          if (!mounted) return;

          resetToLogin(navigation);
          return;
        }

        const me = await getMe();

        if (!mounted) return;

        queryClient.setQueryData(QUERY_KEYS.me, me);
        await enterApp(me.id, 'session_restore');
      } catch (error) {
        if (!mounted) return;

        const code = getApiErrorCode(error);

        if (isAuthUserInactiveError(code)) {
          await clearTokens();
          setBootstrapError({
            kind: 'inactive',
            message: getErrorMessageFromCode(code),
          });
          return;
        }

        setBootstrapError({ kind: 'retryable' });
      }
    }

    void bootstrap();

    return () => {
      mounted = false;
    };
  }, [attempt, enterApp, navigation, queryClient]);

  if (bootstrapError?.kind === 'inactive') {
    return (
      <ErrorState
        title="계정을 사용할 수 없습니다."
        message={bootstrapError.message}
      />
    );
  }

  if (bootstrapError?.kind === 'retryable') {
    return (
      <ErrorState
        title="앱을 시작하지 못했습니다."
        message="계정 정보를 불러오지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해주세요."
        onRetry={() => {
          setBootstrapError(null);
          setAttempt((current) => current + 1);
        }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.center}>
        <Text style={styles.logo}>Trading League</Text>
        <ActivityIndicator style={styles.loader} />
        <Text style={styles.caption}>앱을 준비하는 중입니다.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  logo: {
    fontSize: 24,
    fontWeight: '700',
  },
  loader: {
    marginTop: 16,
  },
  caption: {
    marginTop: 12,
    color: '#666',
  },
});
