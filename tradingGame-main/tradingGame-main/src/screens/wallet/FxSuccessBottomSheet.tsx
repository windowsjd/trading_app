import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

import BottomSheetBackdrop from '../../components/common/BottomSheetBackdrop';
import CTAButton from '../../components/common/CTAButton';

interface FxSuccessBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  onGoWallet: () => void;
  onGoHome: () => void;
  payload: {
    fromCurrency: 'KRW' | 'USD';
    toCurrency: 'KRW' | 'USD';
    sourceAmount: string;
    rate: string;
    feeAmount: string;
    netTargetAmount: string;
  } | null;
}

export default function FxSuccessBottomSheet({
  visible,
  onClose,
  onGoWallet,
  onGoHome,
  payload,
}: FxSuccessBottomSheetProps) {
  return (
    <BottomSheetBackdrop visible={visible} onClose={onClose}>
      <View style={styles.iconCircle}>
        <Text style={styles.iconText}>✓</Text>
      </View>

      <Text style={styles.title}>환전이 완료되었습니다</Text>

      {payload ? (
        <View style={styles.card}>
          <Row
            label="환전 방향"
            value={`${payload.fromCurrency} → ${payload.toCurrency}`}
          />
          <Row label="환전 금액" value={payload.sourceAmount} />
          <Row label="적용 환율" value={payload.rate} />
          <Row label="수수료" value={payload.feeAmount} />
          <Row label="수령 금액" value={payload.netTargetAmount} />
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
  },
  label: {
    fontSize: 14,
    color: '#666',
  },
  value: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  flex: { flex: 1 },
});