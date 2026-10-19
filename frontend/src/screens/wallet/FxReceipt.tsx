import { semantic } from '../../theme/tokens';
import React from 'react';
import { View, Text, StyleSheet } from '../../theme/native';

import CTAButton from '../../components/common/CTAButton';
import type { FxExecuteDto } from '../../features/wallet/api';
import { getFxExecuteSuccessDisplay } from '../../features/wallet/mapper';

/**
 * The committed exchange, shown inside the 환전 sheet in place of its form
 * (the transfer receipt's layout): never a second sheet or a native modal over
 * it. 확인 closes the sheet; 마켓으로 가기 appears only where the host has it.
 */
export default function FxReceipt({ payload, onDone, onGoMarket }: {
  payload: FxExecuteDto;
  onDone: () => void;
  onGoMarket?: () => void;
}) {
  const display = getFxExecuteSuccessDisplay(payload);
  return (
    <View testID="fx-success" style={styles.content} accessibilityLiveRegion="polite">
      <View style={styles.iconCircle} accessible={false}>
        <Text style={styles.iconText}>✓</Text>
      </View>
      <Text accessibilityRole="header" style={styles.title}>환전이 완료되었습니다</Text>
      <View style={styles.card}>
        <Row label="환전 방향" value={display.direction} />
        <Row label="환전 금액" value={display.sourceAmount} />
        <Row label="수령 금액" value={display.netTargetAmount} />
        <Row label="적용 환율" value={display.appliedRate} />
        <Row label="수수료" value={display.fee} />
        <Row label="실행 시각" value={display.executedAt} />
        <Row label="KRW 지갑 잔액" value={display.krwWalletBalance} />
        <Row label="USD 지갑 잔액" value={display.usdWalletBalance} />
      </View>
      <View style={styles.buttonRow}>
        {/* Same pair as the transfer receipt: 확인 returns to the screen underneath. */}
        <CTAButton testID="fx-success-done" variant="neutral" label="확인" onPress={onDone} style={styles.flex} />
        {onGoMarket ? <CTAButton testID="fx-success-go-market" label="마켓으로 가기" onPress={onGoMarket} style={styles.flex} /> : null}
      </View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: 12 },
  iconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: semantic.successSurface,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  iconText: {
    fontSize: 24,
    fontWeight: '700',
    color: semantic.success,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  card: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    padding: 16,
    backgroundColor: semantic.raised,
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'flex-start',
  },
  label: {
    fontSize: 14,
    color: semantic.secondary,
    flexShrink: 1,
    maxWidth: '45%',
  },
  value: {
    fontSize: 14,
    fontWeight: '600',
    color: semantic.text,
    flex: 1,
    textAlign: 'right',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  flex: { flex: 1 },
});
