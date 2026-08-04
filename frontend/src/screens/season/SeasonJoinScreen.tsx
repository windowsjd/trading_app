import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SeasonJoinScreenProps } from '../../app/navigation/types';
import { getCurrentSeason, joinSeason } from '../../features/season/api';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import {
  toSeasonJoinViewState,
} from '../../features/season/mapper';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { clearTokens } from '../../services/storage/tokenStorage';
import {
  getApiErrorCode,
  getErrorMessageFromCode,
  isAuthUserInactiveError,
} from '../../services/api/errorMapper';
import { ERROR_CODE } from '../../models/enums/errorCode';
import type { SeasonJoinViewState } from '../../models/enums/viewState';
import { formatKrw } from '../../utils/format';

import AccountSetupPanel from '../../components/tradingAccount/AccountSetupPanel';
import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import BlockedState from '../../components/states/BlockedState';
import CTAButton from '../../components/common/CTAButton';

type Props = SeasonJoinScreenProps;

function getJoinErrorViewState(
  code?: string | null,
): SeasonJoinViewState | null {
  if (code === ERROR_CODE.SEASON_ALREADY_JOINED) {
    return 'season_join_already_joined';
  }
  if (code === ERROR_CODE.SEASON_NOT_ACTIVE) return 'season_join_closed';
  if (code === ERROR_CODE.SEASON_NOT_FOUND) {
    return 'season_not_configured_view';
  }
  if (code) return 'season_join_error';
  return null;
}

export default function SeasonJoinScreen({ navigation }: Props) {
  const queryClient = useQueryClient();
  const [joinErrorCode, setJoinErrorCode] = useState<string | null>(null);
  const [showGeneralSetup, setShowGeneralSetup] = useState(false);

  const resetToHome = () => {
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
  };

  /**
   * Season entry is not the only way into the app any more (작업 10 §A-12).
   *
   * Login routes here whenever there is no joinable-and-joined season, which
   * for a user who holds a general account is a dead end: they own a usable
   * account and the season screen has nothing to offer them. If they own ANY
   * account, the screen offers a way home instead of only a retry button.
   */
  const { accounts } = useTradingAccount();
  const hasUsableAccount = accounts.length > 0;

  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
  });

  const joinMutation = useMutation({
    mutationFn: (seasonId: string) => joinSeason(seasonId),
    onSuccess: async () => {
      setJoinErrorCode(null);
      // Joining a season CREATES a new season TradingAccount (작업 10 §A-12).
      // The owned-account list must be refetched or the switcher will not show
      // the account the user just opened, and the selection policy cannot land
      // on it.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.season.current }),
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.tradingAccount.listAll,
        }),
      ]);

      resetToHome();
    },
    onError: async (error: unknown) => {
      const code = getApiErrorCode(error);
      setJoinErrorCode(code ?? 'UNKNOWN');

      if (code === ERROR_CODE.USER_NOT_ACTIVE) {
        await clearTokens();
        return;
      }

      if (
        code === ERROR_CODE.SEASON_ALREADY_JOINED ||
        code === ERROR_CODE.SEASON_NOT_ACTIVE ||
        code === ERROR_CODE.SEASON_NOT_FOUND
      ) {
        // SEASON_ALREADY_JOINED means the account exists already; the list is
        // refetched for the same reason as on success.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.season.current }),
          queryClient.invalidateQueries({
            queryKey: QUERY_KEYS.tradingAccount.listAll,
          }),
        ]);
        await seasonQuery.refetch();
      }

      if (code === ERROR_CODE.SEASON_ALREADY_JOINED) {
        resetToHome();
      }
    },
  });

  const viewState = useMemo(() => {
    if (seasonQuery.isLoading) return 'season_info_loading';
    if (seasonQuery.isError) {
      const code = getApiErrorCode(seasonQuery.error);

      if (code === ERROR_CODE.SEASON_NOT_FOUND) {
        return 'season_not_configured_view';
      }

      return 'season_join_failed';
    }
    if (!seasonQuery.data) return 'season_not_configured_view';
    if (joinMutation.isPending) return 'season_join_submitting';
    const joinErrorState = getJoinErrorViewState(joinErrorCode);
    if (joinErrorState) return joinErrorState;
    return toSeasonJoinViewState(seasonQuery.data);
  }, [
    seasonQuery.isLoading,
    seasonQuery.isError,
    seasonQuery.error,
    seasonQuery.data,
    joinMutation.isPending,
    joinErrorCode,
  ]);

  if (showGeneralSetup) {
    return (
      <AccountSetupPanel
        message="일반 투자 계정은 시즌과 무관하게 유지됩니다. 계정을 연 뒤에도 시즌이 열리면 별도로 참가할 수 있습니다."
        onOpened={resetToHome}
      />
    );
  }

  if (viewState === 'season_info_loading') {
    return <FullPageLoading message="현재 시즌 정보를 불러오는 중입니다." />;
  }

  /**
   * No season to join is not an error for a user who owns nothing — it just
   * means the other entrance is the only one open (작업 11 §3.3). Users who
   * already own an account keep the route home.
   */
  if (viewState === 'season_not_configured_view') {
    return hasUsableAccount ? (
      <BlockedState
        title="현재 진행 중인 시즌이 없습니다."
        message="시즌이 열리면 참가할 수 있습니다. 보유한 계정은 홈에서 계속 사용할 수 있습니다."
        actionLabel="홈으로 이동"
        onAction={resetToHome}
      />
    ) : (
      <AccountSetupPanel
        message="현재 참가할 수 있는 시즌이 없습니다. 일반 투자 계정을 열면 시즌과 무관하게 잔고와 수익률을 확인할 수 있고, 시즌이 열리면 그때 참가할 수 있습니다."
        onOpened={resetToHome}
      />
    );
  }

  if (viewState === 'season_join_failed' || !seasonQuery.data) {
    const code = getApiErrorCode(seasonQuery.error);

    return (
      <ErrorState
        title={
          isAuthUserInactiveError(code)
            ? '계정을 사용할 수 없습니다.'
            : '시즌 정보를 불러오지 못했습니다.'
        }
        message={getErrorMessageFromCode(code)}
        onRetry={() => seasonQuery.refetch()}
      />
    );
  }

  const season = seasonQuery.data;

  if (viewState === 'season_upcoming_view') {
    return (
      <BlockedState
        title={season.name}
        message="시즌 시작 전입니다. 시작 시점이 되면 거래가 열립니다."
        actionLabel="홈으로 이동"
        onAction={resetToHome}
      />
    );
  }

  if (viewState === 'season_ended_unsettled_view') {
    return (
      <BlockedState
        title={season.name}
        message="현재 시즌은 정산 중입니다. 홈에서 결과를 확인해주세요."
        actionLabel="홈으로 이동"
        onAction={resetToHome}
      />
    );
  }

  if (viewState === 'season_settled_view') {
    return (
      <BlockedState
        title={season.name}
        message="현재 시즌은 종료되었습니다. 홈으로 이동해주세요."
        actionLabel="홈으로 이동"
        onAction={resetToHome}
      />
    );
  }

  if (viewState === 'season_join_closed') {
    return hasUsableAccount ? (
      <BlockedState
        title={season.name}
        message="현재 시즌 참가가 마감되었거나 활성 상태가 아닙니다."
        actionLabel="시즌 정보 다시 확인"
        onAction={() => {
          setJoinErrorCode(null);
          seasonQuery.refetch();
        }}
      />
    ) : (
      <AccountSetupPanel
        title={season.name}
        message="이번 시즌은 참가가 마감되었습니다. 일반 투자 계정을 열면 다음 시즌을 기다리는 동안에도 계정을 사용할 수 있습니다."
        onOpened={resetToHome}
      />
    );
  }

  if (viewState === 'season_join_error') {
    const message = isAuthUserInactiveError(joinErrorCode)
      ? getErrorMessageFromCode(ERROR_CODE.USER_NOT_ACTIVE)
      : getErrorMessageFromCode(joinErrorCode);

    return (
      <ErrorState
        title={
          isAuthUserInactiveError(joinErrorCode)
            ? '계정을 사용할 수 없습니다.'
            : '시즌 참가에 실패했습니다.'
        }
        message={message}
        onRetry={() => {
          setJoinErrorCode(null);
          joinMutation.mutate(season.id);
        }}
      />
    );
  }

  if (
    viewState === 'season_join_success' ||
    viewState === 'season_join_already_joined'
  ) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <View style={styles.card}>
            <Text style={styles.title}>이미 이번 시즌에 참가한 상태입니다.</Text>
            <Text style={styles.helper}>홈으로 이동해 포트폴리오와 랭킹을 확인하세요.</Text>
          </View>

          <CTAButton
            label="홈으로 이동"
            onPress={resetToHome}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View testID={TEST_IDS.season.joinScreen} style={styles.content}>
        <View style={styles.card}>
          <Text style={styles.title}>{season.name}</Text>
          <Text style={styles.helper}>
            시즌 기간: {season.startAt} ~ {season.endAt}
          </Text>
          <Text style={styles.helper}>
            시작 자산: {formatKrw(season.initialCapitalKrw)}원
          </Text>
          <Text style={styles.helper}>거래 수수료: {season.tradeFeeRate}</Text>
          <Text style={styles.helper}>환전 수수료: {season.fxFeeRate}</Text>
          <Text style={styles.helper}>지원 자산: 국내 주식 / 미국 주식 / 암호화폐</Text>
          <Text style={styles.helper}>랭킹 기준: KRW 기준 총자산 수익률</Text>
        </View>

        <CTAButton
          label={joinMutation.isPending ? '참가 처리 중...' : '시즌 참가하기'}
          state={joinMutation.isPending ? 'loading' : 'enabled'}
          onPress={() => {
            setJoinErrorCode(null);
            joinMutation.mutate(season.id);
          }}
        />

        <Pressable
          style={styles.secondaryButton}
          onPress={resetToHome}
        >
          <Text style={styles.secondaryButtonText}>지금은 둘러보기</Text>
        </Pressable>

        {/* A user who owns nothing needs the other entrance visible here too:
            joining is not the only way to have an account (작업 11 §3.3). */}
        {!hasUsableAccount ? (
          <Pressable
            style={styles.secondaryButton}
            onPress={() => setShowGeneralSetup(true)}
          >
            <Text style={styles.secondaryButtonText}>
              일반 투자 계정으로 시작하기
            </Text>
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { flex: 1, padding: 20, gap: 12 },
  card: {
    borderWidth: 1,
    borderColor: '#e5e5e5',
    borderRadius: 12,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
  },
  title: { fontSize: 24, fontWeight: '700' },
  helper: { fontSize: 14, lineHeight: 22, color: '#444' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#111',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryButtonText: { color: '#111', fontSize: 16, fontWeight: '700' },
});
