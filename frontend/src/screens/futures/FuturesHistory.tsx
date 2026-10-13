import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getFuturesHistory, type FuturesInstrument } from '../../features/futures/api';
import { futuresPriceBasisLabel } from '../../features/futures/policy';
import { formatAssetPrice, formatDisplayDecimal, formatUsd } from '../../utils/format';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import SegmentedControl from '../../components/common/SegmentedControl';
import ErrorNotice from '../../components/states/ErrorNotice';

const directionLabel = { long: '롱(Long)', short: '숏(Short)' };
const marginLabel = { isolated: '격리(Isolated)', cross: '교차(Cross)' };
const operationLabel = {
  open: '신규 진입(Open)',
  increase: '수량 추가(Increase)',
  reduce: '수량 감소(Reduce)',
  close: '전량 종료(Close)',
};

/**
 * The account's futures executions and forced liquidations, 20 per page. Read
 * only while shown (the screen's 기록 view); each record states the price basis
 * it was actually executed on, and liquidation separates economic loss, actual
 * cash and the uncovered shortfall.
 */
export default function FuturesHistory({ accountId, instruments }: { accountId: string; instruments: FuturesInstrument[] }) {
  const focused = useIsFocused();
  const [historyKind, setHistoryKind] = useState<'executions' | 'liquidations'>('executions');
  const [offset, setOffset] = useState(0);
  const history = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.history(accountId, historyKind, offset),
    queryFn: ({ signal }) => getFuturesHistory(accountId, historyKind, offset, signal),
    enabled: focused,
    retry: false,
  });
  return (
    <View style={styles.stack} testID="futures-history">
      <SegmentedControl testID="futures-history-kind" accessibilityLabel="선물 기록 종류" compact value={historyKind}
        onChange={(kind) => { setHistoryKind(kind); setOffset(0); }}
        options={[
          { key: 'executions', label: '체결 기록', testID: 'futures-history-executions' },
          { key: 'liquidations', label: '강제청산 기록', testID: 'futures-history-liquidations' },
        ]} />
      {history.isError ? (
        <>
          <ErrorNotice error={history.error} message="기록을 불러오지 못했습니다." style={styles.warning} />
          <CTAButton label="기록 다시 불러오기" variant="secondary" onPress={() => void history.refetch()} />
        </>
      ) : history.isPending ? (
        <Text style={styles.muted}>기록을 불러오고 있습니다.</Text>
      ) : (
        <>
          {(history.data.executions ?? []).map((e) => (
            <View key={e.id} style={styles.record}>
              <Text style={styles.recordTitle}>
                {e.instrument.underlying.symbol} · {operationLabel[e.operation]} · {directionLabel[e.direction]}
              </Text>
              <Metric
                label={['수량 / 체결가', futuresPriceBasisLabel(e.priceEvidence?.priceBasis)].filter(Boolean).join(' · ')}
                value={`${formatDisplayDecimal(e.quantity)} / ${price(e.executionPrice, e.instrument.underlying.displayPriceDecimals)}`}
              />
              <Metric label="실현 손익 / 수수료" value={`${usd(e.realizedPnl)} / ${usd(e.feeAmount)}`} />
              <Text style={styles.muted}>{new Date(e.executedAt).toLocaleString('ko-KR')}</Text>
            </View>
          ))}
          {(history.data.liquidations ?? []).map((e) => (
            <View key={e.id} style={styles.record}>
              <Text style={styles.recordTitle}>{marginLabel[e.marginMode]} 전량 강제청산 · {e.closes.length}개 포지션</Text>
              <Metric label="경제적 실현 손익" value={usd(e.realizedPnl)} />
              <Metric label="경제적 종료 수수료" value={usd(e.feeAmount)} />
              {e.settledFee !== undefined ? <Metric label="실제 정산 수수료" value={usd(e.settledFee)} /> : null}
              <Metric label="실제 현금 정산" value={usd(e.settledCash)} />
              <Metric label="미충당 손실 · 부채 이월 없음" value={usd(e.bankruptcyShortfall)} />
              {e.closes.map((c) => (
                <View key={c.positionId} style={styles.record}>
                  <Text style={styles.recordTitle}>{c.markSnapshot?.symbol ?? '종료 포지션'} · {directionLabel[c.direction]}</Text>
                  <Metric label="종료 수량" value={formatDisplayDecimal(c.quantity)} />
                  <Metric
                    label="Mark 청산가"
                    value={price(c.executionPrice, instruments.find((i) => i.id === c.instrumentId)?.underlying.displayPriceDecimals ?? 8)}
                  />
                </View>
              ))}
              <Text style={styles.muted}>{new Date(e.executedAt).toLocaleString('ko-KR')}</Text>
            </View>
          ))}
          {history.data.pagination.returned === 0 ? <Text style={styles.muted}>기록이 없습니다.</Text> : null}
          <View style={styles.pages}>
            <Page label="이전" disabled={offset === 0} onPress={() => setOffset(Math.max(0, offset - 20))} />
            <Page label="다음" disabled={history.data.pagination.nextOffset == null}
              onPress={() => setOffset(history.data.pagination.nextOffset ?? offset)} />
          </View>
        </>
      )}
    </View>
  );
}

function usd(value: string | null | undefined) {
  return value == null ? '평가 대기' : `$${formatUsd(value)}`;
}
function price(value: string | null | undefined, decimals: number | null) {
  return value == null ? '시세 확인 불가' : formatAssetPrice(value, 'USD', decimals);
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.muted}>{label}</Text>
      <Text selectable style={styles.value}>{value}</Text>
    </View>
  );
}
function Page({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  return (
    <ActionPressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
      onPress={onPress} style={[styles.page, disabled && styles.disabled]}>
      <Text style={styles.pageText}>{label}</Text>
    </ActionPressable>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12, minWidth: 0 },
  record: { gap: 8, minWidth: 0, borderTopWidth: 1, borderColor: semantic.border, paddingTop: 12 },
  recordTitle: { fontSize: 14, lineHeight: 21, fontWeight: '600', color: semantic.text, flexShrink: 1 },
  metric: { gap: 2, minWidth: 0 },
  muted: { fontSize: 13, lineHeight: 20, color: semantic.secondary, flexShrink: 1 },
  value: { fontSize: 15, lineHeight: 23, color: semantic.text, flexShrink: 1, fontVariant: ['tabular-nums'] },
  warning: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  pages: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  page: { minHeight: 44, minWidth: 64, paddingHorizontal: 14, borderRadius: 10, backgroundColor: semantic.raised, alignItems: 'center', justifyContent: 'center' },
  pageText: { fontSize: 14, lineHeight: 21, fontWeight: '600', color: semantic.text },
  disabled: { opacity: 0.45 },
});
