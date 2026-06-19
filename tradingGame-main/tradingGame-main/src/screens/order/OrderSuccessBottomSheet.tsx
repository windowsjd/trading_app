import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

import BottomSheetBackdrop from '../../components/common/BottomSheetBackdrop';
import CTAButton from '../../components/common/CTAButton';

interface OrderSuccessBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  onGoAssetDetail: () => void;
  onGoHome: () => void;
  payload: {
    symbol: string;
    side: 'buy' | 'sell';
    quantity: string;
    fillPriceLocal: string;
    fillCurrency: string;
    executedAt: string;
  } | null;
}

export default function OrderSuccessBottomSheet({
  visible,
  onClose,
  onGoAssetDetail,
  onGoHome,
  payload,
}: OrderSuccessBottomSheetProps) {
  return (
    <BottomSheetBackdrop visible={visible} onClose={onClose}>
      <View style={styles.iconCircle}>
        <Text style={styles.iconText}>✓</Text>
      </View>

      <Text style={styles.title}>주문이 완료되었습니다</Text>

      {payload ? (
        <View style={styles.card}>
          <Row label="종목명" value={payload.symbol} />
          <Row label="주문 유형" value={payload.side === 'buy' ? '매수' : '매도'} />
          <Row label="수량" value={payload.quantity} />
          <Row
            label="체결 가격"
            value={`${payload.fillPriceLocal} ${payload.fillCurrency}`}
          />
          <Row label="체결 시각" value={payload.executedAt} />
        </View>
      ) : null}

      <View style={styles.buttonRow}>
        <CTAButton label="종목 상세로 돌아가기" onPress={onGoAssetDetail} style={styles.flex} />
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