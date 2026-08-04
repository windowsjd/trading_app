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

export default function SplashScreen({ navigation }: SplashScreenProps) {
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const enterApp = useEnterApp();

  useEffect(() => {
    let mounted = true;

    /**
     * Session restore (작업 11 §3): token → identity → owned accounts → app.
     *
     * The current season is NOT consulted. A returning user with a general
     * account is a user who can trade nothing but can read everything about
     * their own account, and gating their re-entry on a season that may not
     * exist put them on a join screen they had no business seeing.
     *
     * `me` is seeded into the cache from this call so the account provider does
     * not repeat it one render later.
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
        await enterApp(me.id);
      } catch (error) {
        if (!mounted) return;

        const code = getApiErrorCode(error);

        if (isAuthUserInactiveError(code)) {
          await clearTokens();
          setBootstrapError(getErrorMessageFromCode(code));
          return;
        }

        resetToLogin(navigation);
      }
    }

    bootstrap();

    return () => {
      mounted = false;
    };
  }, [enterApp, navigation, queryClient]);

  if (bootstrapError) {
    return (
      <ErrorState
        title="계정을 사용할 수 없습니다."
        message={bootstrapError}
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
