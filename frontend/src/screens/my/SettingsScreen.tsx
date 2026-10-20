import { semantic } from '../../theme/tokens';
import React, { useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Alert,
  ScrollView,
  Switch,
  Platform,
  Linking,
} from '../../theme/native';
import ActionPressable from '../../components/common/ActionPressable';
import LogoutButton from '../../components/common/LogoutButton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { MyStackParamList } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import { getMe, updateMe, type MeDto } from '../../features/me/api';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { useLogout } from '../../features/auth/useLogout';
import { useAppearance } from '../../theme/appearance';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import NotificationSettingsSection from '../../features/notifications/NotificationSettingsSection';
import { LOGO_DEV_KEY } from '../../features/market/assetLogoSource';
import Constants from 'expo-constants';
import { describeBuild } from '../../utils/buildInfo';

type Props = NativeStackScreenProps<MyStackParamList, 'Settings'>;

export default function SettingsScreen({ navigation }: Props) {
  const queryClient = useQueryClient();
  const { preference, setPreference, colors, financialPreference, setFinancialPreference } = useAppearance();

  const meQuery = useQuery({
    queryKey: QUERY_KEYS.me,
    queryFn: getMe,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const switchTrackColor = { false: colors.border, true: colors.secondaryActionSurface };
  // RN Web selects the active thumb through a separate prop; native uses thumbColor.
  const activeSwitchColor = Platform.OS === 'web' ? { activeThumbColor: colors.secondaryActionForeground } : {};
  const privacyRequestInFlight = useRef(false);

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
        generation: getSessionGeneration(),
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
      queryClient.setQueryData<MeDto>(QUERY_KEYS.me, (current) =>
        current?.id === me.id ? { ...current, portfolioPublic: me.portfolioPublic } : current,
      );
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

  // One shared implementation (작업 10 §B-12): it clears the WHOLE query cache,
  // not just the account-scoped keys, so no legacy financial entry survives
  // into the next user's session.
  const onLogout = useLogout();

  if (meQuery.isLoading) {
    return <FullPageLoading message="설정 정보를 불러오는 중입니다." />;
  }

  if (!meQuery.data) {
    return (
      <ErrorState error={meQuery.error}
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
        {/* Profile photo and nickname are edited on MY (MyProfileEditor). */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>화면 모드</Text>
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
          <View style={styles.switchRow}>
            <Text style={[styles.sectionTitle, styles.switchLabel]}>친구에게 포트폴리오 공개</Text>
            <Switch
              {...activeSwitchColor}
              trackColor={switchTrackColor}
              thumbColor={meQuery.data.portfolioPublic === true ? colors.secondaryActionForeground : colors.text}
              ios_backgroundColor={colors.border}
              accessibilityLabel="친구에게 포트폴리오 공개"
              testID="settings-portfolio-public"
              value={meQuery.data.portfolioPublic === true}
              disabled={
                privacyMutation.isPending ||
                typeof meQuery.data.portfolioPublic !== 'boolean'
              }
              onValueChange={onChangePortfolioPublic}
            />
          </View>
          <Text style={styles.helper}>
            {typeof meQuery.data.portfolioPublic !== 'boolean'
              ? '공개 설정 확인 중...'
              : meQuery.data.portfolioPublic
                ? '공개'
                : '비공개'}
          </Text>
          {privacyMutation.isError && privacyMutation.context?.userId === meQuery.data.id && isCurrentSession(privacyMutation.context.generation) ? <AdminDiagnosticPanel error={privacyMutation.error} /> : null}
        </View>

        <NotificationSettingsSection userId={meQuery.data.id} />

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>앱 정보</Text>
          <Text style={styles.helper}>앱 버전 0.1.0</Text>
          {/* Which build this is (EAS commit stamp, app.config.js): every preview APK reports the same version. */}
          <Text testID="settings-build" style={styles.helper} selectable>{describeBuild(Constants.expoConfig?.extra?.build)}</Text>
          {/* The provider's attribution, required while stock logos come from it (free plan). */}
          {LOGO_DEV_KEY ? (
            <ActionPressable testID="settings-logo-attribution" accessibilityRole="link" style={styles.attribution}
              onPress={() => void Linking.openURL('https://logo.dev')}>
              <Text style={styles.helper}>Logos provided by Logo.dev</Text>
            </ActionPressable>
          ) : null}
        </View>

        <LogoutButton testID={TEST_IDS.settings.logout} onPress={onLogout} />

        {/* 회원탈퇴: 안내 → 본인 확인 → 최종 확인; nothing changes before the last step. */}
        <ActionPressable feedback="button" testID={TEST_IDS.settings.membershipDeletion} accessibilityRole="button"
          accessibilityLabel="회원탈퇴" accessibilityHint="계정 삭제 안내와 본인 확인 화면으로 이동합니다"
          onPress={() => navigation.navigate('MembershipDeletion')} style={styles.membershipDeletion}>
          <Text style={styles.membershipDeletionText}>회원탈퇴</Text>
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
  modeChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  modeChoice: {
    backgroundColor: semantic.raised, minHeight: 44, minWidth: 78, paddingHorizontal: 12, borderRadius: 10,
    borderWidth: 1, borderColor: semantic.border, alignItems: 'center', justifyContent: 'center' },
  modeSelected: { backgroundColor: semantic.selected, borderColor: semantic.selected },
  modeText: { fontSize: 14, fontWeight: '600', color: semantic.secondary },
  modeSelectedText: { color: semantic.onAccent },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchLabel: { flex: 1, minWidth: 0, lineHeight: 27 },
  helper: { fontSize: 14, color: semantic.secondary, lineHeight: 20 },
  attribution: { minHeight: 44, justifyContent: 'center' },
  membershipDeletion: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingVertical: 8 },
  membershipDeletionText: { fontSize: 14, color: semantic.secondary, textDecorationLine: 'underline', textAlign: 'center' },
});
