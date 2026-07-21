import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

import BottomSheetBackdrop from '../../components/common/BottomSheetBackdrop';
import CTAButton from '../../components/common/CTAButton';
import type { CreateOrderDto, OrderQuoteDto } from '../../features/order/api';
import {
  getLimitQuoteEstimateDisplay,
  getOrderSuccessDisplay,
} from '../../features/order/mapper';

interface OrderSuccessBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  onGoAssetDetail: () => void;
  onGoHome: () => void;
  onGoOrderHistory?: () => void;
  payload: CreateOrderDto | null;
  /**
   * The quote this order was created from. Supplies the quote-time ESTIMATES
   * for an unfilled limit buy — the order itself has no gross/fee/net until it
   * actually fills, which phase 1 never does.
   */
  quote?: OrderQuoteDto | null;
}

export default function OrderSuccessBottomSheet({
  visible,
  onClose,
  onGoAssetDetail,
  onGoHome,
  onGoOrderHistory,
  payload,
  quote,
}: OrderSuccessBottomSheetProps) {
  const display = payload ? getOrderSuccessDisplay(payload) : null;
  const isSubmittedLimit = display?.isSubmittedLimitOrder === true;
  const limitEstimate = isSubmittedLimit
    ? getLimitQuoteEstimateDisplay(quote)
    : null;

  return (
    <BottomSheetBackdrop visible={visible} onClose={onClose}>
      <View style={styles.iconCircle}>
        <Text style={styles.iconText}>✓</Text>
      </View>

      <Text style={styles.title}>
        {isSubmittedLimit
          ? '지정가 매수 주문이 등록되었습니다.'
          : '주문이 완료되었습니다'}
      </Text>
      {isSubmittedLimit ? (
        <Text style={styles.subtitle}>
          현재 단계에서는 주문이 미체결 상태로 등록됩니다. 예약된 금액은
          주문을 취소하면 다시 사용할 수 있습니다.
        </Text>
      ) : null}

      {display && isSubmittedLimit ? (
        <View style={styles.card}>
          <Row label="주문 ID" value={display.orderId} />
          <Row label="견적 ID" value={display.quoteId} />
          <Row label="종목" value={display.assetLabel} />
          <Row label="주문 유형" value="지정가 매수" />
          <Row label="상태" value="미체결" />
          <Row label="지정가" value={display.limitPrice} />
          <Row label="수량" value={display.quantity} />
          {/* Estimates from the quote, never a fill: the labels must keep
              saying 예상/예약 기준 so an unfilled order is not read as
              executed. The order's own gross/fee/net stay null until it
              actually fills. */}
          {limitEstimate ? (
            <>
              <Row
                label="예상 주문 금액 (견적 기준)"
                value={limitEstimate.estimatedGrossAmount}
              />
              <Row
                label="예상 수수료 (견적 기준)"
                value={limitEstimate.estimatedFeeAmount}
              />
            </>
          ) : null}
          <Row label="예약금 (미체결 예약)" value={display.reservedAmount} />
          <Row label="제출 시각" value={display.submittedAt} />
        </View>
      ) : display ? (
        <View style={styles.card}>
          <Row label="주문 ID" value={display.orderId} />
          <Row label="견적 ID" value={display.quoteId} />
          <Row label="종목" value={display.assetLabel} />
          <Row
            label="주문 유형"
            value={
              display.side === 'buy'
                ? '매수'
                : display.side === 'sell'
                ? '매도'
                : '-'
            }
          />
          <Row label="수량" value={display.quantity} />
          <Row label="체결 가격" value={display.executedPrice} />
          <Row label="총 주문 금액" value={display.grossAmount} />
          <Row label="수수료" value={display.feeAmount} />
          <Row label="순금액" value={display.netAmount} />
          <Row label="제출 시각" value={display.submittedAt} />
          <Row label="체결 시각" value={display.executedAt} />
          <Row label="견적 가격" value={display.quotedPrice} />
          <Row label="실행 가격" value={display.executePrice} />
          <Row
            label="가격 변동"
            value={
              display.priceChangeBps === '-'
                ? '-'
                : `${display.priceChangeBps}bps`
            }
          />
          <Row label="견적 환율" value={display.quotedRate} />
          <Row label="실행 환율" value={display.executeRate} />
          <Row
            label="환율 변동"
            value={
              display.rateChangeBps === '-'
                ? '-'
                : `${display.rateChangeBps}bps`
            }
          />
          <Row label="체결 후 잔액" value={display.walletBalanceAfter} />
          {display.isAlreadyExecuted ? (
            <Text style={styles.note}>
              이미 처리된 요청입니다. 완료된 주문 정보를 다시 표시합니다.
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.buttonRow}>
        {isSubmittedLimit && onGoOrderHistory ? (
          <CTAButton
            label="주문내역 보기"
            onPress={onGoOrderHistory}
            style={styles.flex}
          />
        ) : (
          <CTAButton
            label="종목 상세로 돌아가기"
            onPress={onGoAssetDetail}
            style={styles.flex}
          />
        )}
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
  subtitle: {
    fontSize: 14,
    color: '#444',
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
  },
  value: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111',
    flex: 1,
    textAlign: 'right',
  },
  note: {
    fontSize: 13,
    color: '#2e7d32',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  flex: { flex: 1 },
});
