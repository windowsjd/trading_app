import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

import BottomSheetBackdrop from '../../components/common/BottomSheetBackdrop';
import CTAButton from '../../components/common/CTAButton';
import type { FxExecuteDto } from '../../features/wallet/api';
import { getFxExecuteSuccessDisplay } from '../../features/wallet/mapper';

interface FxSuccessBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  onGoWallet: () => void;
  onGoHome: () => void;
  payload: FxExecuteDto | null;
}

export default function FxSuccessBottomSheet({
  visible,
  onClose,
  onGoWallet,
  onGoHome,
  payload,
}: FxSuccessBottomSheetProps) {
  const display = payload ? getFxExecuteSuccessDisplay(payload) : null;

  return (
    <BottomSheetBackdrop visible={visible} onClose={onClose}>
      <View style={styles.iconCircle}>
        <Text style={styles.iconText}>✓</Text>
      </View>

      <Text style={styles.title}>환전이 완료되었습니다</Text>

      {display ? (
        <View style={styles.card}>
          <Row label="거래 ID" value={display.exchangeId} />
          <Row label="환전 방향" value={display.direction} />
          <Row label="환전 금액" value={display.sourceAmount} />
          <Row label="수령 금액" value={display.netTargetAmount} />
          <Row label="적용 환율" value={display.appliedRate} />
          <Row label="실행 환율" value={display.executeRate} />
          <Row label="견적 환율" value={display.quotedRate} />
          <Row label="환율 변동" value={display.rateChangeBps} />
          <Row label="수수료" value={display.fee} />
          <Row label="실행 시각" value={display.executedAt} />
          <Row label="출금 지갑 잔액" value={display.sourceWalletBalanceAfter} />
          <Row label="입금 지갑 잔액" value={display.targetWalletBalanceAfter} />
          {display.walletRows.map((item) => (
            <Row key={item} label="지갑 잔액" value={item} />
          ))}
        </View>
      ) : null}

      <View style={styles.buttonRow}>
        <CTAButton label="지갑으로 돌아가기" onPress={onGoWallet} style={styles.flex} />
        <CTAButton label="홈으로 가기" onPress={onGoHome} style={styles.flex} />
      </View>
    </BottomSheetBackdrop>
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
  iconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#eef7ee',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  iconText: {
    fontSize: 24,
    fontWeight: '700',
    color: '#2e7d32',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
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
    color: '#666',
    flexShrink: 0,
  },
  value: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111',
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
