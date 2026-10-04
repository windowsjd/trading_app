import { semantic } from '../../theme/tokens';
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TextInput,
  Alert,
  ScrollView,
  Switch,
} from '../../theme/native';
import ActionPressable from '../../components/common/ActionPressable';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { MyStackParamList } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import { getMe, updateMe, type MeDto } from '../../features/me/api';
import { useLogout } from '../../features/auth/useLogout';
import { useAppearance } from '../../theme/appearance';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';

type Props = NativeStackScreenProps<MyStackParamList, 'Settings'>;

export default function SettingsScreen({ navigation: _navigation }: Props) {
  const queryClient = useQueryClient();
  const { preference, setPreference, colors, financialPreference, setFinancialPreference } = useAppearance();

  const meQuery = useQuery({
    queryKey: QUERY_KEYS.me,
    queryFn: getMe,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const [nickname, setNickname] = useState('');
  const [notificationEnabled, setNotificationEnabled] = useState(true);
  const privacyRequestInFlight = useRef(false);

  useEffect(() => {
    if (meQuery.data) {
      setNickname(meQuery.data.nickname);
    }
  }, [meQuery.data]);

  const updateMutation = useMutation({
    mutationFn: updateMe,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.me });
      Alert.alert('저장 완료', '닉네임이 변경되었습니다.');
    },
    onError: () => {
      Alert.alert('저장 실패', '닉네임 변경에 실패했습니다.');
    },
  });

  const privacyMutation = useMutation({
    mutationFn: (portfolioPublic: boolean) => updateMe({ portfolioPublic }),
    onMutate: async (portfolioPublic) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEYS.me, exact: true });
      const previousMe = queryClient.getQueryData<MeDto>(QUERY_KEYS.me);
      if (previousMe) {
        queryClient.setQueryData<MeDto>(QUERY_KEYS.me, {
          ...previousMe,
          portfolioPublic,
        });
      }
      return {
        userId: previousMe?.id,
        previousPortfolioPublic: previousMe?.portfolioPublic,
      };
    },
    onSuccess: (me, _portfolioPublic, context) => {
      // A late PATCH response must not repopulate /me after logout or a
      // different user's login.
      if (
        !context?.userId ||
        me.id !== context.userId ||
        queryClient.getQueryData<MeDto>(QUERY_KEYS.me)?.id !== context.userId
      )
        return;
      queryClient.setQueryData(QUERY_KEYS.me, me);
      // This self-summary can contain privacy-dependent data. Refresh it
      // without extending the switch's mutation pending state.
      void queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.ranking.userSeasonSummary(me.id),
        exact: true,
      });
    },
    onError: (_error, _portfolioPublic, context) => {
      if (
        context?.userId &&
        typeof context.previousPortfolioPublic === 'boolean'
      ) {
        queryClient.setQueryData<MeDto>(QUERY_KEYS.me, (current) =>
          current?.id === context.userId
            ? { ...current, portfolioPublic: context.previousPortfolioPublic }
            : current,
        );
      }
      Alert.alert(
        '저장 실패',
        '공개 설정을 변경하지 못했습니다. 다시 시도해주세요.',
      );
    },
    onSettled: () => {
      privacyRequestInFlight.current = false;
    },
  });

  const onChangePortfolioPublic = (value: boolean) => {
    if (privacyRequestInFlight.current || privacyMutation.isPending) return;
    privacyRequestInFlight.current = true;
    privacyMutation.mutate(value);
  };

  const onSaveNickname = () => {
    if (!nickname.trim()) {
      Alert.alert('입력 확인', '닉네임을 입력해주세요.');
      return;
    }

    updateMutation.mutate({
      nickname: nickname.trim(),
    });
  };

  // One shared implementation (작업 10 §B-12): it clears the WHOLE query cache,
  // not just the account-scoped keys, so no legacy financial entry survives
  // into the next user's session.
  const onLogout = useLogout();

  if (meQuery.isLoading) {
    return <FullPageLoading message="설정 정보를 불러오는 중입니다." />;
  }

  if (!meQuery.data) {
    return (
      <ErrorState
        title="설정 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => void meQuery.refetch()}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        testID={TEST_IDS.settings.screen}
        contentContainerStyle={styles.content}
      >
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>닉네임 변경</Text>

          <TextInput
            testID={TEST_IDS.settings.nicknameInput}
            style={styles.input}
            value={nickname}
            onChangeText={setNickname}
            placeholder="닉네임 입력"
          />

          <ActionPressable
            testID={TEST_IDS.settings.saveNickname}
            primary
            style={styles.primaryButton}
            onPress={onSaveNickname}
            disabled={updateMutation.isPending}
          >
            <Text style={styles.primaryButtonText}>
              {updateMutation.isPending ? '저장 중...' : '저장'}
            </Text>
          </ActionPressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>화면 모드</Text>
          <Text style={styles.helper}>이 기기에만 저장됩니다.</Text>
          <View style={styles.modeChoices} accessibilityRole="radiogroup">
            {([['system', '시스템'], ['light', '라이트'], ['dark', '다크']] as const).map(([value, label]) => (
              <ActionPressable key={value} testID={TEST_IDS.settings.appearance(value)}
                accessibilityRole="radio" accessibilityLabel={label}
                aria-checked={preference === value}
                accessibilityState={{ selected: preference === value }}
                style={[styles.modeChoice, preference === value && styles.modeSelected]}
                onPress={() => setPreference(value)}>
                <Text style={[styles.modeText, preference === value && styles.modeSelectedText]}>{label}</Text>
              </ActionPressable>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>금융 색상</Text>
          <Text style={styles.helper}>이 기기에만 저장됩니다.</Text>
          <View style={styles.modeChoices} accessibilityRole="radiogroup" accessibilityLabel="금융 색상">
            {([['red_blue', '빨강 · 파랑'], ['green_red', '초록 · 빨강']] as const).map(([value, label]) => (
              <ActionPressable key={value} testID={`settings-financial-${value}`}
                accessibilityRole="radio" accessibilityLabel={label}
                aria-checked={financialPreference === value}
                accessibilityState={{ selected: financialPreference === value }}
                style={[styles.modeChoice, financialPreference === value && styles.modeSelected]}
                onPress={() => setFinancialPreference(value)}>
                <Text style={[styles.modeText, financialPreference === value && styles.modeSelectedText]}>{label}</Text>
              </ActionPressable>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>친구에게 포트폴리오 공개</Text>
          <Text style={styles.helper}>
            친구가 내 현재 시즌 포트폴리오를 볼 수 있습니다.
          </Text>
          <Switch
            trackColor={{ false: colors.border, true: colors.success }}
            thumbColor={colors.text}
            accessibilityLabel="친구에게 포트폴리오 공개"
            testID="settings-portfolio-public"
            value={meQuery.data.portfolioPublic === true}
            disabled={
              privacyMutation.isPending ||
              typeof meQuery.data.portfolioPublic !== 'boolean'
            }
            onValueChange={onChangePortfolioPublic}
          />
          <Text style={styles.helper}>
            {typeof meQuery.data.portfolioPublic !== 'boolean'
              ? '공개 설정 확인 중...'
              : meQuery.data.portfolioPublic
                ? '공개'
                : '비공개'}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>알림 설정</Text>

          <ActionPressable
            style={styles.menuRow}
            onPress={() => setNotificationEnabled((prev) => !prev)}
          >
            <Text style={styles.menuText}>
              {notificationEnabled ? '알림 켜짐' : '알림 꺼짐'}
            </Text>
          </ActionPressable>

          <Text style={styles.helper}>
            현재 문서 기준으로 서버 연동 알림 설정 API는 아직 명시되지
            않았습니다.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>앱 정보</Text>
          <Text style={styles.helper}>앱 버전 0.1.0</Text>
        </View>

        <ActionPressable
          testID={TEST_IDS.settings.logout}
          style={styles.logoutButton}
          onPress={() => void onLogout()}
        >
          <Text style={styles.logoutText}>로그아웃</Text>
        </ActionPressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: semantic.screen },
  content: { padding: 16, gap: 12 },
  card: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    padding: 16,
    backgroundColor: semantic.surface,
    gap: 10,
  },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  input: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: semantic.input,
    fontSize: 16,
  },
  modeChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  modeChoice: {
    backgroundColor: semantic.raised, minHeight: 44, minWidth: 78, paddingHorizontal: 12, borderRadius: 10,
    borderWidth: 1, borderColor: semantic.border, alignItems: 'center', justifyContent: 'center' },
  modeSelected: { backgroundColor: semantic.selected, borderColor: semantic.selected },
  modeText: { fontSize: 14, fontWeight: '600', color: semantic.secondary },
  modeSelectedText: { color: semantic.onAccent },
  menuRow: {
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: semantic.raised,
    paddingHorizontal: 14,
  },
  menuText: { fontSize: 16, fontWeight: '600' },
  helper: { fontSize: 14, color: semantic.secondary, lineHeight: 20 },
  primaryButton: {
    backgroundColor: semantic.selected,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonText: { color: semantic.onAccent, fontWeight: '700' },
  logoutButton: {
    backgroundColor: semantic.errorSurface,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  logoutText: { color: semantic.error, fontWeight: '700' },
});
