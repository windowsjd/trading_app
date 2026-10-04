import { semantic } from '../../theme/tokens';
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  useWindowDimensions,
} from '../../theme/native';

import BottomSheetBackdrop from '../../components/common/BottomSheetBackdrop';
import CTAButton from '../../components/common/CTAButton';
import type { CreateOrderDto, OrderQuoteDto } from '../../features/order/api';
import {
  getLimitQuoteEstimateDisplay,
  getLimitOrderSuccessMessage,
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
   * for an unfilled limit order — the order itself has no gross/fee/net until the
   * scheduler matcher fills it (when auto-execution is enabled).
   */
  quote?: OrderQuoteDto | null;
  /** Asset unit-price decimals; totals keep the currency default. */
  displayPriceDecimals?: number | null;
}

export default function OrderSuccessBottomSheet({
  visible,
  onClose,
  onGoAssetDetail,
  onGoHome,
  onGoOrderHistory,
  payload,
  quote,
  displayPriceDecimals,
}: OrderSuccessBottomSheetProps) {
  const { height } = useWindowDimensions();
  const display = payload
    ? getOrderSuccessDisplay(payload, displayPriceDecimals)
    : null;
  const isSubmittedLimit = display?.isSubmittedLimitOrder === true;
  const limitEstimate = isSubmittedLimit
    ? getLimitQuoteEstimateDisplay(quote)
    : null;
  const submittedSide = display?.side === 'sell' ? 'sell' : 'buy';

  return (
    <BottomSheetBackdrop visible={visible} onClose={onClose}>
      <ScrollView
        style={{ maxHeight: height * 0.65 }}
        contentContainerStyle={styles.content}
      >
        <View style={styles.iconCircle}>
          <Text style={styles.iconText}>✓</Text>
        </View>

        <Text style={styles.title}>
          {isSubmittedLimit
            ? `지정가 ${submittedSide === 'buy' ? '매수' : '매도'} 주문이 등록되었습니다.`
            : display?.isPartialExecution
              ? '일부 체결되었습니다'
              : '주문이 완료되었습니다'}
        </Text>
        {display?.remainderMessage ? (
          <Text testID="market-remainder-message" style={styles.subtitle}>
            {display.remainderMessage}
          </Text>
        ) : null}
        {isSubmittedLimit ? (
          <Text style={styles.subtitle}>
            {getLimitOrderSuccessMessage(
              payload?.executionPolicy,
              submittedSide,
            )}
          </Text>
        ) : null}

        {display && isSubmittedLimit ? (
          <View style={styles.card}>
            <Row label="종목" value={display.assetLabel} />
            <Row
              label="주문 유형"
              value={`지정가 ${submittedSide === 'buy' ? '매수' : '매도'}`}
            />
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
                {submittedSide === 'sell' ? (
                  <Row
                    label="예상 순수령액 (견적 기준)"
                    value={limitEstimate.expectedNetAmount}
                  />
                ) : null}
              </>
            ) : null}
            <Row
              label={
                submittedSide === 'buy'
                  ? '예약금 (미체결 예약)'
                  : '예약 수량 (미체결 예약)'
              }
              value={
                submittedSide === 'buy'
                  ? display.reservedAmount
                  : display.reservedQuantity
              }
            />
          </View>
        ) : display ? (
          <View style={styles.card}>
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
            {display.isPartialExecution ? (
              <>
                <Row
                  label={display.isAmountExecution ? '주문 금액' : '주문 수량'}
                  value={
                    display.isAmountExecution
                      ? display.requestedAmount
                      : display.requestedQuantity
                  }
                />
                <Row label="체결 수량" value={display.quantity} />
                <Row
                  label={
                    display.isAmountExecution
                      ? '사용되지 않은 금액'
                      : '자동취소 수량'
                  }
                  value={
                    display.isAmountExecution
                      ? display.unspentAmount
                      : display.canceledQuantity
                  }
                />
              </>
            ) : (
              <Row label="수량" value={display.quantity} />
            )}
            <Row
              label={display.isPartialExecution ? '평균 체결가' : '체결 가격'}
              value={display.executedPrice}
            />
            <Row
              label={
                display.isPartialExecution ? '실제 체결 금액' : '총 주문 금액'
              }
              value={display.grossAmount}
            />
            <Row label="수수료" value={display.feeAmount} />
            {display.isPartialExecution ? (
              <Row
                label={display.side === 'sell' ? '실제 수령액' : '실제 차감액'}
                value={display.netAmount}
              />
            ) : null}
            <Row label="체결 시각" value={display.executedAt} />
            {!display.isPartialExecution ? (
              <>
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
              </>
            ) : null}
            <Row label="체결 후 잔액" value={display.walletBalanceAfter} />
            {display.isAlreadyExecuted ? (
              <Text style={styles.note}>
                이미 처리된 요청입니다. 완료된 주문 정보를 다시 표시합니다.
              </Text>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
      <View testID="order-success-actions" style={styles.buttonRow}>
        {(isSubmittedLimit || display?.isPartialExecution) &&
        onGoOrderHistory ? (
          <CTAButton
            label="주문내역 보기"
            variant="secondary"
            onPress={onGoOrderHistory}
            style={styles.flex}
          />
        ) : (
          <CTAButton
            variant="neutral"
            label={
              display?.isPartialExecution ? '종목 상세' : '종목 상세로 돌아가기'
            }
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
  subtitle: {
    fontSize: 14,
    color: semantic.secondary,
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
  note: {
    fontSize: 13,
    color: semantic.success,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  flex: { flex: 1 },
});
