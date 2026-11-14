import SeasonTitle from './SeasonTitle';
import BeginnerAccountEntry from './BeginnerAccountEntry';
import ModeEntryCard from './ModeEntryCard';
import { accountSheetMaxHeight } from './accountSheetLayout';
import { semantic } from '../../theme/tokens';
import React, { useState } from 'react';
import {
  HOME_ACCOUNT_CHANGE_FONT_CAP,
  HOME_ACCOUNT_CHANGE_FONT_SIZE,
  HOME_ACCOUNT_CHANGE_LABEL,
  HOME_ACCOUNT_CHANGE_PADDING,
  HOME_SEASON_PERIOD_FONT_SIZE,
  HOME_SEASON_PERIOD_LINE_HEIGHT,
  HOME_SEASON_TITLE_LINE_HEIGHT_WITH_PERIOD,
  HOME_TITLE_FONT_CAP,
} from '../../screens/home/homeHeaderLayout';
import { useSafeAreaInsets } from '../../theme/safeArea';
import {
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from '../../theme/native';
import ActionPressable from '../common/ActionPressable';
import { useQuery } from '@tanstack/react-query';

import BottomSheetBackdrop from '../common/BottomSheetBackdrop';
import CTAButton from '../common/CTAButton';
import ErrorNotice from '../states/ErrorNotice';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { restartBackgroundTabs } from '../../app/navigation/accountSwitchTabs';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { getCurrentSeason } from '../../features/season/api';
import { getAccountDisplay } from '../../features/tradingAccount/accountDisplay';
import { getSeasonPeriod } from '../../features/season/seasonPeriod';
import {
  buildModeSelectionModel,
  GENERAL_MODE_DESCRIPTION,
  hasGeneralAccount,
} from '../../features/tradingAccount/modeSelection';
import { useOpenGeneralAccount } from '../../features/tradingAccount/useOpenGeneralAccount';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import type { TradingAccountDto } from '../../features/tradingAccount/api';
import WhaleLoader from '../states/WhaleLoader';

/**
 * The account switcher (작업 9 §B-3).
 *
 * LAYOUT IS PART OF THE CORRECTNESS HERE, not polish. The three things a user
 * needs before trusting a number on the screen — which account, what mode, what
 * status — are all variable-length Korean text, and a season name is
 * user-facing content the app does not control. So:
 *
 *   - the trigger and every row WRAP instead of truncating to one ellipsised
 *     line; a name clipped to "2026 상반기 정규 시즌 프리미엄…" is not a name
 *     the user can tell apart from the next one;
 *   - the status badge sits on its own flex track and never shrinks, because
 *     "종료" disappearing is exactly how someone mistakes a closed account for
 *     a live one;
 *   - the mode caption and the return-rate meaning each get their own line
 *     rather than being joined into one long sentence that folds badly at
 *     narrow widths and large accessibility font scales.
 *
 * `numberOfLines` is used only where a hard cap genuinely protects the layout
 * (three lines on a season name), never as the primary overflow strategy.
 */

type Props = {
  /** Compact trigger for headers; the sheet is identical either way. */
  compact?: boolean;
  /**
   * Home's header title (2026-11-07), identical for general, beginner and
   * season accounts: one 44dp control with the mode or season title (20/700,
   * a season's beta pill kept) and a 28dp 계정변경 text chip (2026-11-07 (3),
   * formerly a ⇄ icon); it opens the same account sheet. The title stays on
   * one line (the header has one); the sheet shows every name in full.
   * Status notices are HomeAccountNotices.
   */
  homeHeader?: boolean;
  /** Home header only: the width the title may take beside the header's actions. */
  maxWidth?: number;
  /** Home header only: text scaling caps that keep the whole mode name and 계정변경 visible (homeHeaderLayout). */
  titleFontCap?: number;
  changeFontCap?: number;
  /**
   * Home header only, season accounts (2026-11-14): text scaling caps while
   * the season's period sits under its name — both lines stay inside the
   * native header bar (homeSeasonHeaderLayout).
   */
  seasonPeriodCaps?: { title: number; period: number };
};

/**
 * The selected account's state Home must not hide (2026-11-07: under the
 * profile row, since the header keeps one line): a paused or closed account,
 * a season not running or a participation not active.
 */
export function HomeAccountNotices() {
  const { selectedAccount } = useTradingAccount();
  if (!selectedAccount) return null;
  const display = getAccountDisplay(selectedAccount);
  const season = selectedAccount.season;
  const seasonNotice = selectedAccount.mode === 'season' && (!season || season.seasonStatus !== 'active' || season.participantStatus !== 'active');
  if (selectedAccount.status === 'active' && !seasonNotice) return null;
  return (
    <View testID="home-account-notices" style={styles.homeNotices}>
      {selectedAccount.status !== 'active' ? <Text style={styles.homeNotice}>계정 {display.statusLabel}</Text> : null}
      {seasonNotice ? <Text style={styles.homeNotice}>{display.subtitle ?? '시즌 정보를 확인할 수 없습니다.'}</Text> : null}
    </View>
  );
}

export default function AccountSwitcher({
  compact = false,
  homeHeader = false,
  maxWidth,
  titleFontCap = HOME_TITLE_FONT_CAP,
  changeFontCap = HOME_ACCOUNT_CHANGE_FONT_CAP,
  seasonPeriodCaps,
}: Props) {
  const {
    accounts,
    selectedAccount,
    selectedAccountId,
    isLoading,
    isError,
    error,
    isEmpty,
    selectAccount,
    refetchAccounts,
  } = useTradingAccount();
  const [open, setOpen] = useState(false);
  const rootNavigation = useRootNavigation();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
    enabled: open,
    staleTime: 30_000,
  });
  // Use the same eligibility as ModeSelection. Loading/errors hide only this
  // offer; the owned accounts remain selectable, including past seasons.
  const { seasonJoin } = buildModeSelectionModel(
    accounts,
    seasonQuery.isSuccess ? seasonQuery.data : null,
  );

  // A switch drops the previous account's screens from the other tabs (an
  // order form there is bound to that account); batched with the selection.
  const switched = () => {
    setOpen(false);
    restartBackgroundTabs(rootNavigation);
  };
  // First doorway to 일반 투자 for a user who only ever joined seasons
  // (작업 13 §7): the sheet offers STARTING the general account when none
  // exists. The card is an action, not an account — no synthetic id, no row
  // pretending to be a selectable account, and nothing financial is read
  // until the server has actually answered with the created account.
  const startGeneral = useOpenGeneralAccount({ onOpened: switched });

  if (isLoading) {
    return (
      <View
        style={[styles.trigger, styles.stateBox]}
        testID={TEST_IDS.tradingAccount.switcherLoading}
      >
        <WhaleLoader size={20} />
        <Text style={styles.stateText}>계정 정보를 불러오는 중입니다…</Text>
      </View>
    );
  }

  if (isError) {
    return (
      <View
        style={[styles.trigger, styles.stateBox, styles.errorBox]}
        testID={TEST_IDS.tradingAccount.switcherError}
      >
        <ErrorNotice error={error} style={styles.errorText}
          message="계정 목록을 불러오지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해주세요." />
        <ActionPressable
          style={styles.retryButton}
          onPress={() => void refetchAccounts()}
          testID={TEST_IDS.tradingAccount.switcherRetry}
        >
          <Text style={styles.retryText}>다시 시도</Text>
        </ActionPressable>
      </View>
    );
  }

  if (isEmpty || !selectedAccount) {
    return (
      <View
        style={[styles.trigger, styles.stateBox]}
        testID={TEST_IDS.tradingAccount.switcherEmpty}
      >
        <Text style={styles.stateText}>
          아직 사용할 수 있는 투자 계정이 없습니다. 시즌에 참가하거나 일반 투자를
          시작해주세요.
        </Text>
      </View>
    );
  }

  const display = getAccountDisplay(selectedAccount);
  // Home's season header (2026-11-14): THIS account's season period under its
  // name, from the server's startAt/endAt; nothing when they are unreadable.
  const period = homeHeader && selectedAccount.mode === 'season' ? getSeasonPeriod(selectedAccount.season) : null;
  const periodCaps = period ? (seasonPeriodCaps ?? { title: 1, period: 1 }) : null;
  const headerTitle = (
    <SeasonTitle testID="home-account-title" numberOfLines={1} containerStyle={styles.homeHeaderTitleBox}
      style={periodCaps ? [styles.homeTitle, styles.homeTitleWithPeriod] : styles.homeTitle}
      maxFontSizeMultiplier={periodCaps ? Math.min(titleFontCap, periodCaps.title) : titleFontCap} name={display.title}
      displayBadge={selectedAccount.mode === 'season' ? selectedAccount.season?.displayBadge : undefined} />
  );

  return (
    <>
      {homeHeader ? (
        <ActionPressable
          style={[styles.homeHeader, maxWidth ? { maxWidth } : null]}
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`계정 변경. 현재 ${display.title}${period ? `, 운영 기간 ${period.spoken}` : ''}, ${display.statusLabel}`}
          testID={TEST_IDS.tradingAccount.switcherTrigger}
        >
          {period && periodCaps ? (
            // The name, then the period under it; 계정변경 stays beside both.
            <View testID="home-account-title-column" style={styles.homeHeaderTitleColumn}>
              {headerTitle}
              <Text testID="home-season-period" maxFontSizeMultiplier={periodCaps.period} style={styles.homePeriod}>
                {period.text}
              </Text>
            </View>
          ) : headerTitle}
          {/* 계정변경 (2026-11-07 (3)): a text chip instead of the ⇄ icon. It
              never shrinks, so its label is never wrapped or cut; the title
              beside it gives way (homeHeaderLayout). */}
          <View testID="home-account-change" style={styles.homeChange} accessible={false} accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants" aria-hidden>
            <Text maxFontSizeMultiplier={changeFontCap} style={styles.homeChangeText}>
              {HOME_ACCOUNT_CHANGE_LABEL}
            </Text>
          </View>
        </ActionPressable>
      ) : (
        <ActionPressable
          style={styles.trigger}
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`계정 선택. 현재 ${display.title}, ${display.statusLabel}`}
          testID={TEST_IDS.tradingAccount.switcherTrigger}
        >
          <View style={styles.triggerTextColumn}>
            <Text style={styles.triggerLabel}>투자 계정</Text>
            {/* Wraps up to three lines: a long season name stays readable. */}
            <SeasonTitle numberOfLines={3} style={styles.triggerTitle} name={display.title} displayBadge={selectedAccount.mode === 'season' ? selectedAccount.season?.displayBadge : undefined} />
            {!compact && display.subtitle ? (
              <Text style={styles.triggerSubtitle}>{display.subtitle}</Text>
            ) : null}
            {!compact ? (
              <Text style={styles.triggerMeaning}>{display.returnRateLabel}</Text>
            ) : null}
          </View>
          <View style={styles.triggerBadgeColumn}>
            <StatusBadge
              label={display.statusLabel}
              tone={display.statusTone}
              testID={TEST_IDS.tradingAccount.switcherStatus}
            />
            <Text style={styles.chevron}>변경</Text>
          </View>
        </ActionPressable>
      )}

      <BottomSheetBackdrop visible={open} onClose={() => setOpen(false)}>
        <ScrollView
          testID={TEST_IDS.tradingAccount.switcherSheet}
          style={{ maxHeight: accountSheetMaxHeight(height, insets) }}
        >
          <Text style={styles.sheetTitle}>투자 계정 선택</Text>
          <Text style={styles.sheetHelp}>
            계정마다 지갑, 보유 종목, 주문, 수익률이 완전히 분리되어 있습니다.
          </Text>
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              selected={account.id === selectedAccountId}
              onSelect={() => {
                if (account.id === selectedAccountId) {
                  setOpen(false);
                  return;
                }
                selectAccount(account.id);
                switched();
              }}
            />
          ))}

          {!accounts.some(account => account.mode === 'beginner') ? (
            <View style={styles.startBox}>
              <BeginnerAccountEntry onEntered={switched} />
            </View>
          ) : null}

          {seasonJoin.kind === 'available' ? (
            <View style={[styles.startRow, styles.seasonJoinBox]}>
              <SeasonTitle style={styles.rowTitle} name={seasonJoin.seasonName} displayBadge={seasonJoin.displayBadge} />
              <Text style={styles.rowSubtitle}>현재 진행 중인 시즌입니다.</Text>
              <Text style={styles.rowSubtitle}>아직 참가하지 않았습니다.</Text>
              <CTAButton
                testID={TEST_IDS.tradingAccount.switcherSeasonJoin}
                label="시즌 참가하기"
                onPress={() => {
                  setOpen(false);
                  rootNavigation.navigate('SeasonJoin');
                }}
              />
            </View>
          ) : null}

          {/* The same card as 초보모드: title, its sentence, one full-width CTA. */}
          {!hasGeneralAccount(accounts) ? (
            <View style={styles.startBox}>
              <ModeEntryCard
                testID="general-account-entry"
                title="일반모드"
                description={GENERAL_MODE_DESCRIPTION}
                actionTestID={TEST_IDS.tradingAccount.switcherStartGeneral}
                actionLabel="일반모드 계정만들기"
                pending={startGeneral.isPending}
                onPress={startGeneral.start}
                error={startGeneral.error}
                errorTestID={TEST_IDS.tradingAccount.switcherStartGeneralError}
              />
            </View>
          ) : null}
        </ScrollView>
      </BottomSheetBackdrop>
    </>
  );
}

function AccountRow({
  account,
  selected,
  onSelect,
}: {
  account: TradingAccountDto;
  selected: boolean;
  onSelect: () => void;
}) {
  const display = getAccountDisplay(account);

  return (
    <ActionPressable
      style={[styles.row, selected && styles.rowSelected]}
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      testID={TEST_IDS.tradingAccount.switcherOption(account.id)}
    >
      <View style={styles.rowTextColumn}>
        {/* No numberOfLines: in the sheet there is room, and distinguishing
            two similar season names matters more than a tidy row height. */}
        <SeasonTitle style={styles.rowTitle} name={display.title} displayBadge={account.mode === 'season' ? account.season?.displayBadge : undefined} />
        {display.subtitle ? (
          <Text style={styles.rowSubtitle}>{display.subtitle}</Text>
        ) : null}
        <Text style={styles.rowMeaning}>{display.returnRateLabel}</Text>
      </View>
      <View style={styles.rowBadgeColumn}>
        <StatusBadge label={display.statusLabel} tone={display.statusTone} />
        {selected ? <Text style={styles.selectedMark}>선택됨</Text> : null}
      </View>
    </ActionPressable>
  );
}

function StatusBadge({
  label,
  tone,
  testID,
}: {
  label: string;
  tone: 'active' | 'suspended' | 'closed';
  testID?: string;
}) {
  return (
    <View style={[styles.badge, BADGE_TONE[tone]]} testID={testID}>
      <Text style={[styles.badgeText, BADGE_TEXT_TONE[tone]]}>{label}</Text>
    </View>
  );
}

const BADGE_TONE = StyleSheet.create({
  active: { backgroundColor: semantic.infoSurface },
  suspended: { backgroundColor: semantic.warningSurface },
  closed: { backgroundColor: semantic.raised },
});

const BADGE_TEXT_TONE = StyleSheet.create({
  active: { color: semantic.info },
  suspended: { color: semantic.warning },
  closed: { color: semantic.secondary },
});

const styles = StyleSheet.create({
  // One 44dp target: the title and the change chip beside it, left-aligned.
  homeHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, minWidth: 0, flexShrink: 1 },
  homeHeaderTitleBox: { flexWrap: 'nowrap', flexShrink: 1 },
  // One line in the header; the full name is in the label and the sheet.
  homeTitle: { minWidth: 0, fontSize: 20, fontWeight: '700', lineHeight: 28 },
  // With the period under it, the two lines fit the native bar (homeHeaderLayout).
  homeTitleWithPeriod: { lineHeight: HOME_SEASON_TITLE_LINE_HEIGHT_WITH_PERIOD },
  homeHeaderTitleColumn: { flexShrink: 1, minWidth: 0, justifyContent: 'center' },
  // Smaller than the name and in the secondary ink: the period never outweighs it.
  homePeriod: {
    fontSize: HOME_SEASON_PERIOD_FONT_SIZE,
    lineHeight: HOME_SEASON_PERIOD_LINE_HEIGHT,
    color: semantic.secondary,
    fontVariant: ['tabular-nums'],
  },
  homeChange: {
    flexShrink: 0,
    minHeight: 28,
    paddingHorizontal: HOME_ACCOUNT_CHANGE_PADDING,
    borderRadius: 8,
    backgroundColor: semantic.input,
    alignItems: 'center',
    justifyContent: 'center',
  },
  homeChangeText: { fontSize: HOME_ACCOUNT_CHANGE_FONT_SIZE, lineHeight: 18, fontWeight: '600', color: semantic.secondary },
  homeNotices: { gap: 2 },
  homeNotice: { fontSize: 13, lineHeight: 20, color: semantic.warning },
  trigger: {
    flexDirection: 'row',
    // Top-aligned, not centred: the text column grows downward as it wraps and
    // the badge must stay pinned beside the first line.
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: semantic.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: semantic.border,
  },
  // flexShrink lets the text column give way; the badge column never does.
  triggerTextColumn: { flex: 1, flexShrink: 1, gap: 2 },
  triggerBadgeColumn: { flexShrink: 0, alignItems: 'flex-end', gap: 4 },
  triggerLabel: { fontSize: 12, color: semantic.muted },
  triggerTitle: { fontSize: 16, fontWeight: '700', color: semantic.text },
  triggerSubtitle: { fontSize: 13, color: semantic.secondary },
  triggerMeaning: { fontSize: 12, color: semantic.muted },
  chevron: { fontSize: 12, color: semantic.info, fontWeight: '600' },

  stateBox: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stateText: { flex: 1, fontSize: 13, color: semantic.secondary },
  errorBox: { flexDirection: 'column', alignItems: 'stretch', gap: 8 },
  errorText: { fontSize: 13, color: semantic.error },
  retryButton: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: semantic.infoSurface,
  },
  retryText: { color: semantic.info, fontWeight: '600' },

  sheetTitle: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  sheetHelp: { fontSize: 13, color: semantic.secondary, marginBottom: 12 },

  row: {
    backgroundColor: semantic.raised,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: semantic.border,
    marginBottom: 8,
  },
  rowSelected: { borderColor: semantic.info, backgroundColor: semantic.infoSurface },
  rowTextColumn: { flex: 1, flexShrink: 1, gap: 2 },
  rowBadgeColumn: { flexShrink: 0, alignItems: 'flex-end', gap: 4 },
  rowTitle: { fontSize: 15, fontWeight: '700', color: semantic.text },
  rowSubtitle: { fontSize: 13, color: semantic.secondary },
  rowMeaning: { fontSize: 12, color: semantic.muted },
  selectedMark: { fontSize: 11, color: semantic.info, fontWeight: '700' },

  badge: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999 },
  badgeText: { fontSize: 11, fontWeight: '700' },

  // Offers, not owned accounts: the 초보모드/일반모드 cards (8dp apart, like
  // the rows) and the dashed season-join box — no status badge, no "선택됨".
  startBox: { marginBottom: 8 },
  startRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: semantic.border,
    backgroundColor: semantic.infoSurface,
  },
  // Full-width copy and CTA grow vertically, even with large Android fonts.
  seasonJoinBox: {
    flexDirection: 'column',
    alignItems: 'stretch',
    minWidth: 0,
    gap: 8,
    marginBottom: 8,
  },
});
