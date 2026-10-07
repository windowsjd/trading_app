import { semantic } from '../../theme/tokens';
import React, { useState } from 'react';
import Svg, { Path } from 'react-native-svg';
import { useAppearance } from '../../theme/appearance';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from '../../theme/native';
import ActionPressable from '../common/ActionPressable';
import { useQuery } from '@tanstack/react-query';

import BottomSheetBackdrop from '../common/BottomSheetBackdrop';
import CTAButton from '../common/CTAButton';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { getCurrentSeason } from '../../features/season/api';
import { getAccountDisplay } from '../../features/tradingAccount/accountDisplay';
import {
  buildModeSelectionModel,
  hasGeneralAccount,
} from '../../features/tradingAccount/modeSelection';
import { useOpenGeneralAccount } from '../../features/tradingAccount/useOpenGeneralAccount';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import type { TradingAccountDto } from '../../features/tradingAccount/api';

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
  /** Home context with a small change action; selection still uses this sheet. */
  home?: boolean;
  /** Home owns tier presentation; the shared switcher has no ranking dependency. */
  homeCardStyle?: StyleProp<ViewStyle>;
  /** Optional Home illustration shares the title/profile column's vertical space. */
  homeVisual?: React.ReactNode;
  children?: React.ReactNode;
};

export default function AccountSwitcher({ compact = false, home = false, homeCardStyle, homeVisual, children }: Props) {
  const { colors } = useAppearance();
  const {
    accounts,
    selectedAccount,
    selectedAccountId,
    isLoading,
    isError,
    isEmpty,
    selectAccount,
    refetchAccounts,
  } = useTradingAccount();
  const [open, setOpen] = useState(false);
  const rootNavigation = useRootNavigation();
  const { height, fontScale } = useWindowDimensions();
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

  // First doorway to 일반 투자 for a user who only ever joined seasons
  // (작업 13 §7): the sheet offers STARTING the general account when none
  // exists. The row is an action, not an account — no synthetic id, no row
  // pretending to be a selectable account, and nothing financial is read
  // until the server has actually answered with the created account.
  const startGeneral = useOpenGeneralAccount({
    onOpened: () => setOpen(false),
  });

  if (isLoading) {
    return (
      <View
        style={[styles.trigger, styles.stateBox]}
        testID={TEST_IDS.tradingAccount.switcherLoading}
      >
        <ActivityIndicator size="small" color={semantic.info} />
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
        <Text style={styles.errorText}>
          계정 목록을 불러오지 못했습니다. 네트워크 상태를 확인한 뒤 다시
          시도해주세요.
        </Text>
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
  const hasHomeVisual = selectedAccount.mode === 'season' && !!homeVisual;
  const stackHomeVisual = fontScale > 1.3;

  return (
    <>
      {home ? (
        <View style={[styles.homeContext, hasHomeVisual && styles.homeSeasonContext,
          hasHomeVisual && stackHomeVisual && styles.homeStacked,
          selectedAccount.mode === 'season' && homeCardStyle]} testID={TEST_IDS.home.accountContext}>
          <View style={[styles.homeInfo, hasHomeVisual && !stackHomeVisual && styles.homeSeasonInfo]}>
            <View style={[styles.homeHeading, hasHomeVisual && styles.homeSeasonHeading]}>
              <View style={[styles.homeContextRow, hasHomeVisual && styles.homeSeasonRow]}>
                <Text testID="home-account-title" style={[styles.homeTitle, selectedAccount.mode === 'season' && styles.homeSeasonTitle]}>{display.title}</Text>
                <ActionPressable
                  style={styles.homeChange}
                  onPress={() => setOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel={`계정 변경. 현재 ${display.title}, ${display.statusLabel}`}
                  testID={TEST_IDS.tradingAccount.switcherTrigger}
                >
                  <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
                    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={colors.secondary}
                      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" focusable={false}>
                      <Path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />
                    </Svg>
                  </View>
                </ActionPressable>
              </View>
              {selectedAccount.status !== 'active' ? (
                <Text style={styles.homeNotice}>계정 {display.statusLabel}</Text>
              ) : null}
              {selectedAccount.mode === 'season' && (
                !selectedAccount.season ||
                selectedAccount.season.seasonStatus !== 'active' ||
                selectedAccount.season.participantStatus !== 'active'
              ) ? (
                <Text style={styles.homeNotice}>
                  {display.subtitle ?? '시즌 정보를 확인할 수 없습니다.'}
                </Text>
              ) : null}
            </View>
            {children}
          </View>
          {hasHomeVisual ? homeVisual : null}
        </View>
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
            <Text style={styles.triggerTitle} numberOfLines={3}>
              {display.title}
            </Text>
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
          style={{ maxHeight: Math.min(480, height * 0.7) }}
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
                selectAccount(account.id);
                setOpen(false);
              }}
            />
          ))}

          {seasonJoin.kind === 'available' ? (
            <View style={[styles.startRow, styles.seasonJoinBox]}>
              <Text style={styles.rowTitle}>{seasonJoin.seasonName}</Text>
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

          {!hasGeneralAccount(accounts) ? (
            <View style={styles.startBox}>
              <ActionPressable
                style={styles.startRow}
                onPress={startGeneral.start}
                disabled={startGeneral.isPending}
                accessibilityRole="button"
                accessibilityState={{ busy: startGeneral.isPending }}
                testID={TEST_IDS.tradingAccount.switcherStartGeneral}
              >
                <View style={styles.rowTextColumn}>
                  <Text style={styles.rowTitle}>일반 투자 시작하기</Text>
                  <Text style={styles.rowSubtitle}>
                    시즌과 무관하게 유지되는 일반 투자 계정을 새로 만듭니다.
                    초기 자금 10,000,000원, 시간가중 수익률로 성과를
                    측정합니다.
                  </Text>
                  <Text style={styles.rowMeaning}>
                    매매 가능 · KRW↔USD 환전 가능
                  </Text>
                </View>
                <View style={styles.rowBadgeColumn}>
                  {startGeneral.isPending ? (
                    <ActivityIndicator size="small" color={semantic.info} />
                  ) : (
                    <Text style={styles.startAction}>시작</Text>
                  )}
                </View>
              </ActionPressable>
              {startGeneral.errorMessage ? (
                <Text
                  style={styles.startError}
                  testID={
                    TEST_IDS.tradingAccount.switcherStartGeneralError
                  }
                >
                  {startGeneral.errorMessage}
                </Text>
              ) : null}
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
        <Text style={styles.rowTitle}>{display.title}</Text>
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
  homeContext: {
    minHeight: 96,
    paddingHorizontal: 16,
    paddingVertical: 20,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.surface,
    gap: 16,
  },
  homeContextRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  homeSeasonContext: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 14, gap: 8 },
  homeStacked: { flexDirection: 'column', gap: 16 },
  homeInfo: { minWidth: 0, gap: 16 },
  homeSeasonInfo: { flex: 1, justifyContent: 'space-between', gap: 12 },
  homeHeading: { gap: 16 },
  homeSeasonHeading: { gap: 8 },
  homeSeasonRow: { gap: 4, flexWrap: 'wrap' },
  homeTitle: { flex: 1, minWidth: 0, fontSize: 20, fontWeight: '700', lineHeight: 28 },
  homeSeasonTitle: { flexGrow: 0, flexShrink: 1, flexBasis: 'auto', fontSize: 18, lineHeight: 26, fontWeight: '800' },
  homeChange: {
    flexShrink: 0,
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: semantic.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
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

  // The start-general action: visually an offer, not an owned account —
  // dashed border, no status badge, no "선택됨" state it could ever be in.
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
  startAction: { fontSize: 12, color: semantic.info, fontWeight: '700' },
  // Full-width copy and CTA grow vertically, even with large Android fonts.
  seasonJoinBox: {
    flexDirection: 'column',
    alignItems: 'stretch',
    minWidth: 0,
    gap: 8,
    marginBottom: 8,
  },
  // Full message, wrapping: a Korean error must never be clipped to fit a row.
  startError: { marginTop: 6, fontSize: 13, color: semantic.error, lineHeight: 20 },
});
