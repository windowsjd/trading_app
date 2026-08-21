import React, { useMemo } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';

import type { ModeSelectionScreenProps } from '../../app/navigation/types';
import { resetToHome } from '../../app/navigation/seasonRouting';
import CTAButton from '../../components/common/CTAButton';
import ErrorState from '../../components/states/ErrorState';
import FullPageLoading from '../../components/states/FullPageLoading';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { getCurrentSeason } from '../../features/season/api';
import { getAccountDisplay } from '../../features/tradingAccount/accountDisplay';
import { buildModeSelectionModel } from '../../features/tradingAccount/modeSelection';
import { useOpenGeneralAccount } from '../../features/tradingAccount/useOpenGeneralAccount';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import type { TradingAccountDto } from '../../features/tradingAccount/api';
import { getApiErrorCode } from '../../services/api/errorMapper';
import { ERROR_CODE } from '../../models/enums/errorCode';

/**
 * The question every fresh authentication must answer (작업 13 §2·§3):
 * "이번 세션에서 어떤 투자 계정으로 시작할 것인가?"
 *
 * Login used to skip this — anyone owning an account was dropped into Home,
 * where the selection policy preferred the active season. A user holding only
 * a season account therefore ALWAYS landed in season mode, and had no doorway
 * to 일반 투자 at all. This screen is that doorway, and the only place entry
 * decides between modes; it never decides FOR the user.
 *
 * Three rules the layout and the handlers both honour:
 *
 *   - 일반 투자 is always offered. If the general account exists it is used;
 *     if not, the button issues the explicit POST — mounting this screen
 *     creates nothing, ever.
 *   - The season column tells the truth: a running season the user is in is
 *     "계속하기"; one they have not joined is "참가하기" (via SeasonJoin);
 *     no joinable season is said outright, with 일반 투자 still available.
 *     Finished seasons are reachable but never a default.
 *   - A failure in one column never blocks the other: a season lookup error
 *     leaves 일반 투자 usable, and a general-open error leaves every season
 *     option usable.
 *
 * Everything financial stays account-scoped: this screen reads only the owned
 * account list and the public current-season record, and its only writes are
 * the explicit general-open POST and the local selection.
 */
export default function ModeSelectionScreen({
  navigation,
}: ModeSelectionScreenProps) {
  const {
    accounts,
    isLoading: accountsLoading,
    isError: accountsError,
    refetchAccounts,
    selectAccount,
  } = useTradingAccount();

  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
    staleTime: 30_000,
  });

  const openGeneral = useOpenGeneralAccount({
    onOpened: () => resetToHome(navigation),
  });

  // "No current season" is an answer, not a failure: the join option simply
  // does not exist. Any other error keeps the season column in an explicit
  // error state instead of quietly pretending no season is open.
  const seasonNotFound =
    seasonQuery.isError &&
    getApiErrorCode(seasonQuery.error) === ERROR_CODE.SEASON_NOT_FOUND;
  const seasonLookupFailed = seasonQuery.isError && !seasonNotFound;

  const model = useMemo(
    () =>
      buildModeSelectionModel(
        accounts,
        seasonQuery.isSuccess ? seasonQuery.data : null,
      ),
    [accounts, seasonQuery.isSuccess, seasonQuery.data],
  );

  if (accountsLoading) {
    return <FullPageLoading message="계정 정보를 불러오는 중입니다." />;
  }

  if (accountsError) {
    // "We could not read your accounts" is NOT "you have none" (작업 13 §5):
    // offering a brand-new account here would invite a duplicate start on a
    // network blip, so the screen stays on an explicit retry.
    return (
      <ErrorState
        title="계정 정보를 불러오지 못했습니다."
        message="네트워크 상태를 확인한 뒤 다시 시도해주세요."
        onRetry={() => void refetchAccounts()}
      />
    );
  }

  // Selecting an EXISTING account is a local act: persist the choice, go home.
  // No POST, no refetch — reads only, exactly like the switcher.
  const startWithAccount = (account: TradingAccountDto) => {
    selectAccount(account.id);
    resetToHome(navigation);
  };

  const generalOption = model.general;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        testID={TEST_IDS.modeSelection.screen}
      >
        <Text style={styles.title}>투자 방식을 선택하세요</Text>
        <Text style={styles.subtitle}>
          계정마다 지갑, 보유 종목, 주문, 수익률이 완전히 분리되어 있습니다.
          선택한 계정은 앱 사용 중 홈에서 언제든지 변경할 수 있습니다.
        </Text>

        <Text style={styles.sectionLabel}>일반 투자</Text>
        {generalOption.kind === 'existing' ? (
          <GeneralExistingCard
            account={generalOption.account}
            onStart={() => startWithAccount(generalOption.account)}
          />
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>새 일반 투자 계정</Text>
            <Text style={styles.cardBody}>
              시즌과 무관하게 계속 유지되는 투자 계정입니다. 초기 자금
              10,000,000원으로 시작하고, 성과는 시간가중 수익률로 측정합니다.
            </Text>
            <Text style={styles.cardNotice}>
              국내·미국·가상자산 매매와 KRW↔USD 환전을 지원합니다. USD 결제
              자산은 보유 USD 잔액 안에서 주문할 수 있습니다.
            </Text>
            <CTAButton
              testID={TEST_IDS.modeSelection.generalStart}
              label={
                openGeneral.isPending
                  ? '계정을 여는 중입니다...'
                  : '일반 투자 계정 시작하기'
              }
              state={openGeneral.isPending ? 'loading' : 'enabled'}
              onPress={openGeneral.start}
            />
            {openGeneral.errorMessage ? (
              <Text
                style={styles.errorText}
                testID={TEST_IDS.modeSelection.generalError}
              >
                {openGeneral.errorMessage}
              </Text>
            ) : null}
          </View>
        )}

        <Text style={styles.sectionLabel}>시즌 투자</Text>
        {model.seasonContinue.map((account) => {
          const display = getAccountDisplay(account);

          return (
            <View key={account.id} style={styles.card}>
              <Text style={styles.cardTitle}>{display.title}</Text>
              {display.subtitle ? (
                <Text style={styles.cardBody}>{display.subtitle}</Text>
              ) : null}
              <Text style={styles.cardNotice}>{display.returnRateLabel}</Text>
              <CTAButton
                testID={TEST_IDS.modeSelection.seasonContinue(account.id)}
                label="시즌 투자 계속하기"
                onPress={() => startWithAccount(account)}
              />
            </View>
          );
        })}

        {seasonQuery.isLoading ? (
          <View style={styles.card}>
            <Text style={styles.cardBody}>
              현재 시즌 정보를 확인하는 중입니다…
            </Text>
          </View>
        ) : seasonLookupFailed ? (
          <View style={styles.card} testID={TEST_IDS.modeSelection.seasonError}>
            <Text style={styles.errorText}>
              시즌 정보를 불러오지 못했습니다. 일반 투자는 계속 진행할 수
              있습니다.
            </Text>
            <CTAButton
              label="시즌 정보 다시 확인"
              onPress={() => void seasonQuery.refetch()}
            />
          </View>
        ) : model.seasonJoin.kind === 'available' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{model.seasonJoin.seasonName}</Text>
            <Text style={styles.cardBody}>
              현재 진행 중인 시즌입니다. 아직 참가하지 않았습니다.
            </Text>
            <Text style={styles.cardNotice}>
              참가하면 시즌 전용 계정이 새로 열리고, 성과는 시즌 초기자본 대비
              수익률로 측정됩니다.
            </Text>
            <CTAButton
              testID={TEST_IDS.modeSelection.seasonJoin}
              label="시즌 참가하기"
              onPress={() => navigation.navigate('SeasonJoin')}
            />
          </View>
        ) : model.seasonContinue.length === 0 ? (
          <View style={styles.card} testID={TEST_IDS.modeSelection.seasonNone}>
            <Text style={styles.cardBody}>
              현재 참가할 수 있는 시즌이 없습니다. 시즌이 열리면 이 화면과 홈에서
              참가할 수 있습니다.
            </Text>
          </View>
        ) : null}

        {model.seasonPast.length > 0 ? (
          <>
            <Text style={styles.sectionLabel}>지난 시즌 계정</Text>
            {model.seasonPast.map((account) => {
              const display = getAccountDisplay(account);

              return (
                <Pressable
                  key={account.id}
                  style={styles.pastRow}
                  onPress={() => startWithAccount(account)}
                  accessibilityRole="button"
                  accessibilityLabel={`${display.title}, ${display.statusLabel}. 이 계정으로 시작`}
                  testID={TEST_IDS.modeSelection.pastSeason(account.id)}
                >
                  <View style={styles.pastRowText}>
                    <Text style={styles.pastRowTitle}>{display.title}</Text>
                    {display.subtitle ? (
                      <Text style={styles.pastRowSubtitle}>
                        {display.subtitle}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={styles.pastRowAction}>기록 보기</Text>
                </Pressable>
              );
            })}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function GeneralExistingCard({
  account,
  onStart,
}: {
  account: TradingAccountDto;
  onStart: () => void;
}) {
  const display = getAccountDisplay(account);

  return (
    <View style={styles.card}>
      <View style={styles.cardHeaderRow}>
        <Text style={[styles.cardTitle, styles.cardHeaderTitle]}>
          {display.title}
        </Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{display.statusLabel}</Text>
        </View>
      </View>
      {display.subtitle ? (
        <Text style={styles.cardBody}>{display.subtitle}</Text>
      ) : null}
      <Text style={styles.cardNotice}>{display.returnRateLabel}</Text>
      <CTAButton
        testID={TEST_IDS.modeSelection.generalUse}
        label="일반 투자로 시작"
        onPress={onStart}
      />
    </View>
  );
}

/**
 * Same overflow discipline as the switcher (작업 10 §B-8): every text wraps —
 * no numberOfLines anywhere on this screen — the status badge sits on a
 * non-shrinking track, and the whole page scrolls, so long Korean season names
 * and error messages stay fully readable at large font scales and narrow
 * widths.
 */
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { flexGrow: 1, padding: 20, gap: 10, justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700', lineHeight: 32 },
  subtitle: { fontSize: 13, color: '#546e7a', lineHeight: 19, marginBottom: 6 },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#78909c',
    marginTop: 8,
  },
  card: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 12,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  cardHeaderTitle: { flex: 1, flexShrink: 1, minWidth: 0 },
  cardTitle: { fontSize: 17, fontWeight: '700', color: '#212121', lineHeight: 24 },
  cardBody: { fontSize: 14, color: '#444', lineHeight: 21 },
  cardNotice: { fontSize: 12, color: '#78909c', lineHeight: 18 },
  errorText: { fontSize: 13, color: '#c62828', lineHeight: 20 },
  badge: {
    flexShrink: 0,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: '#e3f2fd',
  },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#1565c0' },
  pastRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderColor: '#eceff1',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  pastRowText: { flex: 1, flexShrink: 1, minWidth: 0, gap: 2 },
  pastRowTitle: { fontSize: 14, fontWeight: '600', color: '#37474f' },
  pastRowSubtitle: { fontSize: 12, color: '#78909c', lineHeight: 17 },
  pastRowAction: {
    flexShrink: 0,
    fontSize: 12,
    color: '#1565c0',
    fontWeight: '700',
    paddingTop: 2,
  },
});
