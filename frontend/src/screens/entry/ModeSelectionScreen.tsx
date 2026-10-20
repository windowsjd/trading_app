import SeasonTitle from '../../components/tradingAccount/SeasonTitle';
import BeginnerAccountEntry from '../../components/tradingAccount/BeginnerAccountEntry';
import { semantic } from '../../theme/tokens';
import React, { useMemo } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from '../../theme/native';
// Not React Native's SafeAreaView: it pads on iOS only, and Android draws this
// headerless root screen edge to edge under the status and navigation bars.
import { SafeAreaView } from '../../theme/safeArea';
import ActionPressable from '../../components/common/ActionPressable';
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
import {
  awaitsNextSeason,
  buildModeSelectionModel,
  GENERAL_MODE_DESCRIPTION,
} from '../../features/tradingAccount/modeSelection';
import { useOpenGeneralAccount } from '../../features/tradingAccount/useOpenGeneralAccount';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import type { TradingAccountDto } from '../../features/tradingAccount/api';
import { getApiErrorCode } from '../../services/api/errorMapper';
import { ERROR_CODE } from '../../models/enums/errorCode';

/**
 * One sentence under each account type saying what it is for (초보모드's is
 * in BeginnerAccountEntry). Copy only: selection and creation stay on the
 * explicit press of each card.
 */
const MODE_DESCRIPTIONS = {
  general: GENERAL_MODE_DESCRIPTION,
  season: '정해진 기간동안 가상투자로 수익률을 경쟁해보세요!',
} as const;

/** How often 다음시즌이 곧 시작됩니다 re-asks for an open season (read-only). */
const NEXT_SEASON_POLL_MS = 60_000;

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
 *     "계속하기"; a settled season whose final result they have not seen is
 *     "시즌결과 확인하기" (SeasonFinalResult, which records the view); one
 *     they have not joined is "시즌참가하기" (via SeasonJoin); otherwise the
 *     disabled "다음시즌이 곧 시작됩니다", re-checked while shown, with 일반
 *     투자 still available. Finished seasons are reachable but never a default.
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
    // Only while the entry can say nothing but 다음시즌이 곧 시작됩니다: a season
    // that opens later turns it into 시즌참가하기 without a manual refresh.
    refetchInterval: (query) =>
      awaitsNextSeason(buildModeSelectionModel(accounts, query.state.data))
        ? NEXT_SEASON_POLL_MS
        : false,
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
  const hasContinue = model.seasonContinue.length > 0;

  // One season entry under the running-season cards (작업 A-4): an unseen
  // settled result first, then joining, then the honest "nothing to join".
  let seasonEntry: React.ReactNode = null;
  if (model.seasonResult) {
    const { seasonId, seasonName } = model.seasonResult;
    seasonEntry = (
      <SeasonModeCard>
        <SeasonTitle style={styles.cardBody} name={seasonName} displayBadge={model.seasonResult.displayBadge} />
        <CTAButton
          testID={TEST_IDS.modeSelection.seasonResult}
          label="시즌결과 확인하기"
          onPress={() => navigation.navigate('SeasonFinalResult', { seasonId })}
        />
      </SeasonModeCard>
    );
  } else if (seasonQuery.isLoading) {
    seasonEntry = hasContinue ? null : (
      <SeasonModeCard>
        <Text style={styles.cardBody}>
          현재 시즌 정보를 확인하는 중입니다…
        </Text>
      </SeasonModeCard>
    );
  } else if (seasonLookupFailed) {
    seasonEntry = (
      <SeasonModeCard testID={TEST_IDS.modeSelection.seasonError}>
        <Text style={styles.errorText}>
          시즌 정보를 불러오지 못했습니다. 일반 투자는 계속 진행할 수
          있습니다.
        </Text>
        <CTAButton
          variant="neutral" label="시즌 정보 다시 확인"
          onPress={() => void seasonQuery.refetch()}
        />
      </SeasonModeCard>
    );
  } else if (model.seasonJoin.kind === 'available') {
    seasonEntry = (
      <SeasonModeCard>
        <SeasonTitle style={styles.cardBody} name={model.seasonJoin.seasonName} displayBadge={model.seasonJoin.displayBadge} />
        <CTAButton
          testID={TEST_IDS.modeSelection.seasonJoin}
          label="시즌참가하기"
          onPress={() => navigation.navigate('SeasonJoin')}
        />
      </SeasonModeCard>
    );
  } else if (!hasContinue) {
    seasonEntry = (
      <SeasonModeCard testID={TEST_IDS.modeSelection.seasonNone}>
        {model.seasonSettling ? (
          <View>
            <SeasonTitle style={styles.cardBody} name={model.seasonSettling.seasonName} displayBadge={model.seasonSettling.displayBadge} />
            <Text style={styles.cardBody}>
              결과를 정산하고 있습니다. 정산이
              끝나면 이곳에서 시즌결과를 확인할 수 있습니다.
            </Text>
          </View>
        ) : null}
        <CTAButton
          testID={TEST_IDS.modeSelection.seasonNextSoon}
          label="다음시즌이 곧 시작됩니다"
          state="disabled"
        />
      </SeasonModeCard>
    );
  }

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        testID={TEST_IDS.modeSelection.screen}
      >
        <Text style={styles.title}>계정 선택하기</Text>
        {/* Display order only: 시즌모드 → 일반모드 → 초보모드. Selection and
            creation still happen only on an explicit press of each card. */}
        {model.seasonContinue.map((account) => (
          <SeasonModeCard key={account.id} badge="참가중">
            <SeasonTitle style={styles.cardBody} name={account.season?.seasonName ?? '시즌 계정'} displayBadge={account.season?.displayBadge} />
            <CTAButton
              testID={TEST_IDS.modeSelection.seasonContinue(account.id)}
              label="시즌모드"
              onPress={() => startWithAccount(account)}
            />
          </SeasonModeCard>
        ))}
        {seasonEntry}

        {generalOption.kind === 'existing' ? (
          <GeneralExistingCard
            account={generalOption.account}
            onStart={() => startWithAccount(generalOption.account)}
          />
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>일반모드</Text>
            <ModeDescription mode="general" />
            <CTAButton
              testID={TEST_IDS.modeSelection.generalStart}
              label="일반모드 계정만들기"
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

        <BeginnerAccountEntry onEntered={() => resetToHome(navigation)} />

        {model.seasonPast.length > 0 ? (
          <>
            <Text style={styles.sectionLabel}>지난 시즌 계정</Text>
            {model.seasonPast.map((account) => {
              const display = getAccountDisplay(account);

              return (
                <ActionPressable
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
                </ActionPressable>
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
          일반모드
        </Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{display.statusLabel}</Text>
        </View>
      </View>
      <ModeDescription mode="general" />
      <CTAButton
        testID={TEST_IDS.modeSelection.generalUse}
        label="일반모드"
        onPress={onStart}
      />
    </View>
  );
}

/** Every 시즌모드 card: the title (with a status badge when given), its sentence, then the caller's content. */
function SeasonModeCard({
  badge,
  testID,
  children,
}: {
  badge?: string;
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.card} testID={testID}>
      {badge ? (
        <View style={styles.cardHeaderRow}>
          <Text style={[styles.cardTitle, styles.cardHeaderTitle]}>시즌모드</Text>
          <View style={styles.badge}><Text style={styles.badgeText}>{badge}</Text></View>
        </View>
      ) : (
        <Text style={styles.cardTitle}>시즌모드</Text>
      )}
      <ModeDescription mode="season" />
      {children}
    </View>
  );
}

function ModeDescription({ mode }: { mode: keyof typeof MODE_DESCRIPTIONS }) {
  return (
    <Text testID={`mode-description-${mode}`} style={styles.cardBody}>
      {MODE_DESCRIPTIONS[mode]}
    </Text>
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
  container: { flex: 1, backgroundColor: semantic.screen },
  content: { flexGrow: 1, padding: 20, gap: 10, justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700', lineHeight: 32 },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: semantic.muted,
    marginTop: 8,
  },
  card: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    padding: 16,
    backgroundColor: semantic.surface,
    gap: 8,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: 12,
  },
  cardHeaderTitle: { flex: 1, flexShrink: 1, minWidth: 0 },
  cardTitle: { fontSize: 17, fontWeight: '700', color: semantic.text, lineHeight: 24 },
  cardBody: { fontSize: 14, color: semantic.secondary, lineHeight: 21 },
  errorText: { fontSize: 13, color: semantic.error, lineHeight: 20 },
  badge: {
    flexShrink: 0,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: semantic.infoSurface,
  },
  badgeText: { fontSize: 11, lineHeight: 17, fontWeight: '700', color: semantic.info },
  pastRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  pastRowText: { flex: 1, flexShrink: 1, minWidth: 0, gap: 2 },
  pastRowTitle: { fontSize: 14, fontWeight: '600', color: semantic.secondary },
  pastRowSubtitle: { fontSize: 12, color: semantic.muted, lineHeight: 17 },
  pastRowAction: {
    flexShrink: 0,
    fontSize: 12,
    color: semantic.info,
    fontWeight: '700',
    paddingTop: 2,
  },
});
