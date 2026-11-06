import { semantic } from '../../theme/tokens';
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  useWindowDimensions,
} from '../../theme/native';

import { useSafeAreaInsets } from '../../theme/safeArea';
import BottomSheetBackdrop from '../../components/common/BottomSheetBackdrop';
import CTAButton from '../../components/common/CTAButton';
import { QUERY_KEYS } from '../../constants/queryKeys';
import type { CreateOrderDto, OrderQuoteDto } from '../../features/order/api';
import {
  getLimitQuoteEstimateDisplay,
  getLimitOrderSuccessMessage,
  getOrderSuccessDisplay,
} from '../../features/order/mapper';
import {
  ORDER_SHARE_NOTE,
  getOrderShareTarget,
  resolveOrderShare,
  type OrderShareCheck,
} from '../../features/share/orderShare';
import {
  getAccountPositionQuantity,
  getCompletedTrades,
  getTradingAccountPositions,
  type CompletedTrade,
} from '../../features/tradingAccount/api';
import { formatDisplayDecimal, formatKstDateTime } from '../../utils/format';
import TradeShareSheet from '../history/TradeShareSheet';

interface OrderSuccessBottomSheetProps {
  visible: boolean;
  /** Closes the result; 주문으로 돌아가기 does only this (the order screen stays). */
  onClose: () => void;
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
  /** The order's own account: an executed SELL there may share the trade it completed. */
  accountId?: string;
}

/** 공유하기 under an executed SELL's result, as the share check answered. */
export type OrderSuccessShare = {
  state: 'checking' | 'failed' | OrderShareCheck['state'];
  onPress: () => void;
};

/**
 * The order's result. An executed SELL also offers 공유하기 with the completed
 * trade it closed (features/share/orderShare.ts): the account's completed
 * trades are read once this result shows, and the 수익 공유 sheet opens over
 * the order screen in its place — closing that sheet brings this result back.
 * Sharing never re-sends, repeats or changes the order.
 */
export default function OrderSuccessBottomSheet({ accountId, ...props }: OrderSuccessBottomSheetProps) {
  const target = accountId ? getOrderShareTarget(accountId, props.payload) : null;
  const check = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.orderShare(target?.accountId ?? '', target?.orderId ?? ''),
    queryFn: async ({ signal }): Promise<OrderShareCheck> => {
      if (!target) throw new Error('No executed SELL to check.');
      const [trades, positions] = await Promise.all([
        getCompletedTrades(target.accountId, signal),
        // Only names why a SELL cannot share yet; a failed read never decides it.
        getTradingAccountPositions(target.accountId, { assetId: target.assetId, limit: 20, offset: 0 }).catch(() => null),
      ]);
      return resolveOrderShare(target, trades, positions ? getAccountPositionQuantity(positions, target.assetId) : null);
    },
    enabled: props.visible && !!target,
    retry: false,
    // One answer per executed order; only a failed check is asked again (on press).
    staleTime: Infinity,
  });
  const [sharing, setSharing] = useState<{ orderId: string; trade: CompletedTrade } | null>(null);
  const trade = props.visible && sharing && sharing.orderId === target?.orderId ? sharing.trade : null;
  const result = check.data;
  const share: OrderSuccessShare | null = target ? {
    state: check.isFetching ? 'checking' : check.isError ? 'failed' : result?.state ?? 'checking',
    onPress: () => {
      if (result?.state === 'ready') setSharing({ orderId: target.orderId, trade: result.trade });
      else if (check.isError && !check.isFetching) void check.refetch();
    },
  } : null;
  return (
    <>
      <OrderSuccessSheet {...props} visible={props.visible && !trade} share={share} />
      {accountId ? <TradeShareSheet accountId={accountId} trade={trade} onClose={() => setSharing(null)} /> : null}
    </>
  );
}

export function OrderSuccessSheet({
  visible,
  onClose,
  onGoHome,
  onGoOrderHistory,
  payload,
  quote,
  displayPriceDecimals,
  share = null,
}: Omit<OrderSuccessBottomSheetProps, 'accountId'> & { share?: OrderSuccessShare | null }) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const display = payload
    ? getOrderSuccessDisplay(payload, displayPriceDecimals)
    : null;
  const isSubmittedLimit = display?.isSubmittedLimitOrder === true;
  const limitEstimate = isSubmittedLimit
    ? getLimitQuoteEstimateDisplay(quote)
    : null;
  const submittedSide = display?.side === 'sell' ? 'sell' : 'buy';
  // LOC is a submitted limit BUY or SELL bound to one session's final close:
  // its session comes from the server's order (or the quote it was created from).
  const loc = isSubmittedLimit
    ? payload?.order.limitOnClose ?? quote?.limitOnClose ?? null
    : null;
  const locSide = submittedSide === 'sell' ? '매도' : '매수';
  // LOC SELL accepted less than asked: other orders held part of the holding.
  const requestedQuantity =
    (loc as { requestedQuantity?: string | null } | null)?.requestedQuantity ?? null;

  return (
    <BottomSheetBackdrop
      visible={visible}
      onClose={onClose}
      // The whole sheet stays below the status bar: when large text makes the
      // actions tall, the result's scroll area gives way first.
      sheetStyle={{ maxHeight: height - insets.top - SHEET_TOP_GAP }}
    >
      <ScrollView
        // 공유하기 adds a row under the result: the result scrolls a little sooner.
        style={[styles.scroll, { maxHeight: height * (share ? 0.55 : 0.65) }]}
        contentContainerStyle={styles.content}
      >
        <View style={styles.iconCircle}>
          <Text style={styles.iconText}>✓</Text>
        </View>

        <Text style={styles.title}>
          {loc
            ? `LOC ${locSide} 주문이 접수되었습니다.`
            : isSubmittedLimit
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
        {loc ? (
          <Text testID="loc-success-message" style={styles.subtitle}>
            {submittedSide === 'sell'
              ? `접수는 체결이 아니에요. ${loc.sessionDate} 정규장의 확정 종가가 지정가격 이상이면 그 종가로 체결되고, 아니면 주문이 종료되며 예약 수량이 해제돼요. 종가 확인은 마감 후 시간이 걸릴 수 있어요.`
              : `접수는 체결이 아니에요. ${loc.sessionDate} 정규장의 확정 종가가 지정가격 이하이면 그 종가로 체결되고, 아니면 주문이 종료되며 예약금이 해제돼요. 종가 확인은 마감 후 시간이 걸릴 수 있어요.`}
          </Text>
        ) : isSubmittedLimit ? (
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
              value={loc ? `LOC ${locSide}` : `지정가 ${submittedSide === 'buy' ? '매수' : '매도'}`}
            />
            <Row label="상태" value={loc ? '종가 판정 대기' : '미체결'} />
            {loc ? (
              <Row label="지정가격" value={display.limitPrice} />
            ) : (
              <Row label="지정가" value={display.limitPrice} />
            )}
            {requestedQuantity ? (
              <>
                <Row label="요청 수량" value={formatDisplayDecimal(requestedQuantity)} />
                <Row label="접수 수량" value={display.quantity} />
                <Text testID="loc-quantity-adjusted" style={styles.subtitle}>
                  다른 주문이 이미 예약한 수량을 제외하고 매도 가능 수량만 접수됐어요.
                </Text>
              </>
            ) : (
              <Row label="수량" value={display.quantity} />
            )}
            {loc ? (
              <>
                <Row label="대상 정규장" value={loc.sessionDate} />
                <Row label="정규장 마감" value={formatKstDateTime(loc.sessionCloseAt)} />
                <Row label="체결 판정 기한" value={formatKstDateTime(loc.evidenceDeadlineAt)} />
                <Row
                  label="체결 가격 기준"
                  value={submittedSide === 'sell' ? '확정 종가 (지정가격 이상일 때)' : '확정 종가 (지정가격 이하일 때)'}
                />
              </>
            ) : null}
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
      <View testID="order-success-actions" style={styles.actions}>
        {share ? (
          <View style={styles.share}>
            <CTAButton
              testID="order-success-share"
              label="공유하기"
              variant="secondary"
              state={
                share.state === 'checking'
                  ? 'loading'
                  : share.state === 'ready' || share.state === 'failed'
                    ? 'enabled'
                    : 'disabled'
              }
              onPress={share.onPress}
            />
            {share.state === 'holding' || share.state === 'unverified' || share.state === 'failed' ? (
              <Text testID="order-success-share-note" accessibilityLiveRegion="polite" style={styles.shareNote}>
                {ORDER_SHARE_NOTE[share.state]}
              </Text>
            ) : null}
          </View>
        ) : null}
        <View style={styles.buttonRow}>
          {(isSubmittedLimit || display?.isPartialExecution) &&
          onGoOrderHistory ? (
            <CTAButton
              label="주문내역 보기"
              variant="secondary"
              onPress={onGoOrderHistory}
              style={styles.flex}
            />
          ) : (
            // Back to the same order screen: the sheet closes, nothing navigates.
            <CTAButton
              variant="neutral"
              label="주문으로 돌아가기"
              onPress={onClose}
              style={styles.flex}
            />
          )}
          <CTAButton label="홈으로 가기" onPress={onGoHome} style={styles.flex} />
        </View>
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

/** Room kept between the status bar and the sheet's top edge. */
const SHEET_TOP_GAP = 24;

const styles = StyleSheet.create({
  scroll: { flexShrink: 1 },
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
  actions: {
    gap: 10,
    marginTop: 4,
  },
  share: { gap: 6 },
  shareNote: {
    fontSize: 13,
    lineHeight: 19,
    color: semantic.secondary,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  flex: { flex: 1 },
});
