import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
  SafeAreaView,
} from 'react-native';

import type { SplashScreenProps } from '../../app/navigation/types';
import {
  resetToLogin,
  resetToSeasonEntry,
  resetToSeasonJoin,
} from '../../app/navigation/seasonRouting';
import { getAccessToken, clearTokens } from '../../services/storage/tokenStorage';
import { getCurrentSeason } from '../../features/season/api';
import ErrorState from '../../components/states/ErrorState';
import {
  getApiErrorCode,
  getErrorMessageFromCode,
  isAuthUserInactiveError,
} from '../../services/api/errorMapper';
import { ERROR_CODE } from '../../models/enums/errorCode';

export default function SplashScreen({ navigation }: SplashScreenProps) {
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      try {
        const accessToken = await getAccessToken();

        if (!accessToken) {
          if (!mounted) return;

          resetToLogin(navigation);
          return;
        }

        const season = await getCurrentSeason();

        if (!mounted) return;

        resetToSeasonEntry(navigation, season);
      } catch (error) {
        if (!mounted) return;

        const code = getApiErrorCode(error);

        if (isAuthUserInactiveError(code)) {
          await clearTokens();
          setBootstrapError(getErrorMessageFromCode(code));
          return;
        }

        if (code === ERROR_CODE.SEASON_NOT_FOUND) {
          resetToSeasonJoin(navigation);
          return;
        }

        resetToLogin(navigation);
      }
    }

    bootstrap();

    return () => {
      mounted = false;
    };
  }, [navigation]);

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
