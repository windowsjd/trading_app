import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TextInput,
  Pressable,
  Alert,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { MyStackParamList } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import { getMe, updateMe } from '../../features/me/api';
import { logout as logoutSession } from '../../features/auth/api';
import { clearTokens, getRefreshToken } from '../../services/storage/tokenStorage';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';

type Props = NativeStackScreenProps<MyStackParamList, 'Settings'>;

export default function SettingsScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();
  const queryClient = useQueryClient();

  const meQuery = useQuery({
    queryKey: QUERY_KEYS.me,
    queryFn: getMe,
  });

  const [nickname, setNickname] = useState('');
  const [notificationEnabled, setNotificationEnabled] = useState(true);

  useEffect(() => {
    if (meQuery.data) {
      setNickname(meQuery.data.nickname);
    }
  }, [meQuery.data]);

  const updateMutation = useMutation({
    mutationFn: updateMe,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.me });
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.home.dashboard });
      Alert.alert('저장 완료', '닉네임이 변경되었습니다.');
    },
    onError: () => {
      Alert.alert('저장 실패', '닉네임 변경에 실패했습니다.');
    },
  });

  const onSaveNickname = () => {
    if (!nickname.trim()) {
      Alert.alert('입력 확인', '닉네임을 입력해주세요.');
      return;
    }

    updateMutation.mutate({
      nickname: nickname.trim(),
    });
  };

  const onLogout = async () => {
    const refreshToken = await getRefreshToken();

    try {
      await logoutSession(refreshToken);
    } catch {
      // Local logout should still complete if the server cannot be reached.
    } finally {
      await clearTokens();
    }

    rootNavigation.reset({
      index: 0,
      routes: [
        {
          name: 'AuthStack',
          params: { screen: 'Login' },
        },
      ],
    });
  };

  if (meQuery.isLoading) {
    return <FullPageLoading message="설정 정보를 불러오는 중입니다." />;
  }

  if (!meQuery.data) {
    return (
      <ErrorState
        title="설정 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => meQuery.refetch()}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View testID={TEST_IDS.settings.screen} style={styles.content}>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>닉네임 변경</Text>

          <TextInput
            testID={TEST_IDS.settings.nicknameInput}
            style={styles.input}
            value={nickname}
            onChangeText={setNickname}
            placeholder="닉네임 입력"
          />

          <Pressable
            testID={TEST_IDS.settings.saveNickname}
            style={styles.primaryButton}
            onPress={onSaveNickname}
            disabled={updateMutation.isPending}
          >
            <Text style={styles.primaryButtonText}>
              {updateMutation.isPending ? '저장 중...' : '저장'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>알림 설정</Text>

          <Pressable
            style={styles.menuRow}
            onPress={() => setNotificationEnabled((prev) => !prev)}
          >
            <Text style={styles.menuText}>
              {notificationEnabled ? '알림 켜짐' : '알림 꺼짐'}
            </Text>
          </Pressable>

          <Text style={styles.helper}>
            현재 문서 기준으로 서버 연동 알림 설정 API는 아직 명시되지 않았습니다.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>앱 정보</Text>
          <Text style={styles.helper}>앱 버전 0.1.0</Text>
        </View>

        <Pressable
          testID={TEST_IDS.settings.logout}
          style={styles.logoutButton}
          onPress={onLogout}
        >
          <Text style={styles.logoutText}>로그아웃</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 12 },
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 10,
  },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: '#fff',
    fontSize: 16,
  },
  menuRow: {
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#fff',
    paddingHorizontal: 14,
  },
  menuText: { fontSize: 16, fontWeight: '600' },
  helper: { fontSize: 14, color: '#444', lineHeight: 20 },
  primaryButton: {
    backgroundColor: '#111',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#fff', fontWeight: '700' },
  logoutButton: {
    backgroundColor: '#fff0f0',
    borderWidth: 1,
    borderColor: '#f2b8b8',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  logoutText: { color: '#c62828', fontWeight: '700' },
});
