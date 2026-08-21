import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import BottomSheetBackdrop from '../common/BottomSheetBackdrop';
import { TEST_IDS } from '../../constants/testIds';
import { getAccountDisplay } from '../../features/tradingAccount/accountDisplay';
import { hasGeneralAccount } from '../../features/tradingAccount/modeSelection';
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
};

export default function AccountSwitcher({ compact = false }: Props) {
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
        <ActivityIndicator size="small" color="#1565c0" />
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
        <Pressable
          style={styles.retryButton}
          onPress={() => void refetchAccounts()}
          testID={TEST_IDS.tradingAccount.switcherRetry}
        >
          <Text style={styles.retryText}>다시 시도</Text>
        </Pressable>
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

  return (
    <>
      <Pressable
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
      </Pressable>

      <BottomSheetBackdrop visible={open} onClose={() => setOpen(false)}>
        <View testID={TEST_IDS.tradingAccount.switcherSheet}>
          <Text style={styles.sheetTitle}>투자 계정 선택</Text>
          <Text style={styles.sheetHelp}>
            계정마다 지갑, 보유 종목, 주문, 수익률이 완전히 분리되어 있습니다.
          </Text>
          <ScrollView style={styles.sheetList}>
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

            {!hasGeneralAccount(accounts) ? (
              <View style={styles.startBox}>
                <Pressable
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
                      <ActivityIndicator size="small" color="#1565c0" />
                    ) : (
                      <Text style={styles.startAction}>시작</Text>
                    )}
                  </View>
                </Pressable>
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
        </View>
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
    <Pressable
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
    </Pressable>
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
  active: { backgroundColor: '#e3f2fd' },
  suspended: { backgroundColor: '#fff8e1' },
  closed: { backgroundColor: '#eceff1' },
});

const BADGE_TEXT_TONE = StyleSheet.create({
  active: { color: '#1565c0' },
  suspended: { color: '#ef6c00' },
  closed: { color: '#546e7a' },
});

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    // Top-aligned, not centred: the text column grows downward as it wraps and
    // the badge must stay pinned beside the first line.
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  // flexShrink lets the text column give way; the badge column never does.
  triggerTextColumn: { flex: 1, flexShrink: 1, gap: 2 },
  triggerBadgeColumn: { flexShrink: 0, alignItems: 'flex-end', gap: 4 },
  triggerLabel: { fontSize: 12, color: '#78909c' },
  triggerTitle: { fontSize: 16, fontWeight: '700', color: '#212121' },
  triggerSubtitle: { fontSize: 13, color: '#546e7a' },
  triggerMeaning: { fontSize: 12, color: '#78909c' },
  chevron: { fontSize: 12, color: '#1565c0', fontWeight: '600' },

  stateBox: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stateText: { flex: 1, fontSize: 13, color: '#546e7a' },
  errorBox: { flexDirection: 'column', alignItems: 'stretch', gap: 8 },
  errorText: { fontSize: 13, color: '#c62828' },
  retryButton: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#e3f2fd',
  },
  retryText: { color: '#1565c0', fontWeight: '600' },

  sheetTitle: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  sheetHelp: { fontSize: 13, color: '#546e7a', marginBottom: 12 },
  sheetList: { maxHeight: 380 },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#eceff1',
    marginBottom: 8,
  },
  rowSelected: { borderColor: '#1565c0', backgroundColor: '#f5faff' },
  rowTextColumn: { flex: 1, flexShrink: 1, gap: 2 },
  rowBadgeColumn: { flexShrink: 0, alignItems: 'flex-end', gap: 4 },
  rowTitle: { fontSize: 15, fontWeight: '700', color: '#212121' },
  rowSubtitle: { fontSize: 13, color: '#546e7a' },
  rowMeaning: { fontSize: 12, color: '#78909c' },
  selectedMark: { fontSize: 11, color: '#1565c0', fontWeight: '700' },

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
    borderColor: '#90caf9',
    backgroundColor: '#f5faff',
  },
  startAction: { fontSize: 12, color: '#1565c0', fontWeight: '700' },
  // Full message, wrapping: a Korean error must never be clipped to fit a row.
  startError: { marginTop: 6, fontSize: 13, color: '#c62828', lineHeight: 20 },
});
