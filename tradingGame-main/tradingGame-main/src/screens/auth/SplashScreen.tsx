import React, { useEffect } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
  SafeAreaView,
} from 'react-native';

import type { SplashScreenProps } from '../../app/navigation/types';
import { getAccessToken } from '../../services/storage/tokenStorage';
import { getCurrentSeason } from '../../features/season/api';

export default function SplashScreen({ navigation }: SplashScreenProps) {
  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      try {
        const accessToken = await getAccessToken();

        if (!accessToken) {
          if (!mounted) return;

          navigation.reset({
            index: 0,
            routes: [
              {
                name: 'AuthStack',
                params: { screen: 'Login' },
              },
            ],
          });
          return;
        }

        const season = await getCurrentSeason();

        if (!mounted) return;

        if (season.status === 'active' && season.joined) {
          navigation.reset({
            index: 0,
            routes: [
              {
                name: 'MainTabs',
                params: {
                  screen: 'HomeTab',
                  params: { screen: 'Home' },
                },
              },
            ],
          });
          return;
        }

        if (season.status === 'active' && !season.joined) {
          navigation.reset({
            index: 0,
            routes: [{ name: 'SeasonJoin' }],
          });
          return;
        }

        if (season.status === 'upcoming') {
          navigation.reset({
            index: 0,
            routes: [{ name: 'SeasonJoin' }],
          });
          return;
        }

        navigation.reset({
          index: 0,
          routes: [
            {
              name: 'MainTabs',
              params: {
                screen: 'HomeTab',
                params: { screen: 'Home' },
              },
            },
          ],
        });
      } catch {
        if (!mounted) return;

        navigation.reset({
          index: 0,
          routes: [
            {
              name: 'AuthStack',
              params: { screen: 'Login' },
            },
          ],
        });
      }
    }

    bootstrap();

    return () => {
      mounted = false;
    };
  }, [navigation]);

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