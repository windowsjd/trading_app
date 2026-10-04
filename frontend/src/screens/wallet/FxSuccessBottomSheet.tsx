import { semantic } from '../../theme/tokens';
import React from 'react';
import { View, Text, StyleSheet, ScrollView, useWindowDimensions } from '../../theme/native';

import BottomSheetBackdrop from '../../components/common/BottomSheetBackdrop';
import CTAButton from '../../components/common/CTAButton';
import type { FxExecuteDto } from '../../features/wallet/api';
import { getFxExecuteSuccessDisplay } from '../../features/wallet/mapper';

interface FxSuccessBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  onGoWallet: () => void;
  onGoMarket: () => void;
  payload: FxExecuteDto | null;
}

export default function FxSuccessBottomSheet({
  visible,
  onClose,
  onGoWallet,
  onGoMarket,
  payload,
}: FxSuccessBottomSheetProps) {
  const { height } = useWindowDimensions();
  const display = payload ? getFxExecuteSuccessDisplay(payload) : null;

  return (
    <BottomSheetBackdrop visible={visible} onClose={onClose}>
      <ScrollView
        style={{ maxHeight: height * 0.8 }}
        contentContainerStyle={styles.content}
      >
        <View style={styles.iconCircle}>
          <Text style={styles.iconText}>✓</Text>
        </View>

        <Text style={styles.title}>환전이 완료되었습니다</Text>

        {display ? (
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
        ) : null}

        <View style={styles.buttonRow}>
          <CTAButton variant="neutral" label="지갑으로 돌아가기" onPress={onGoWallet} style={styles.flex} />
          <CTAButton label="마켓으로 가기" onPress={onGoMarket} style={styles.flex} />
        </View>
      </ScrollView>
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
