import React from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import type { FuturesPosition, FuturesCapabilities, Operation } from '../../features/futures/api';
import { futuresHolding, getFuturesPositionDisplay } from '../../features/futures/positionDisplay';
import { formatAssetPrice, formatDisplayDecimal, formatMoneyDecimal } from '../../utils/format';
import ProtectionPanel from '../../features/conditional/ProtectionPanel';
import CTAButton from '../../components/common/CTAButton';

type Props = { position: FuturesPosition; accountId: string; evaluatedAt: string; now: number;
  disabled: boolean; capabilities: FuturesCapabilities; onSelect: (operation: Exclude<Operation, 'open'>) => void;
  onInputFocus?: (input: View | null) => void; onInputBlur?: () => void };
export default function FuturesPositionCard({ position: p, accountId, evaluatedAt, now,
  disabled, capabilities, onSelect, onInputFocus, onInputBlur }: Props) {
  const { width, fontScale } = useWindowDimensions();
  const stacked = width / fontScale < 300;
  const display = getFuturesPositionDisplay(futuresHolding(p), evaluatedAt, now);
  const price = (value: string | null | undefined) => value == null ? '-'
    : formatAssetPrice(value, 'USD', p.instrument.underlying.displayPriceDecimals);
  const pnlColor = display.pnlDirection === 'neutral' ? semantic.secondary : financial[display.pnlDirection];
  return <View style={styles.card} testID={`futures-position-${p.id}`}>
    <View style={styles.header}>
      <Text style={styles.name}>{display.name} · USD 무기한</Text>
      <Text style={[styles.direction, { color: p.direction === 'long' ? BUY_COLOR : SELL_COLOR }]}>{display.direction}</Text>
      <Text style={styles.muted}>{p.marginMode === 'cross' ? 'Cross · 교차' : 'Isolated · 격리'} · {p.leverage}x</Text>
    </View>
    <View style={[styles.performance, stacked && styles.stacked]}>
      <View style={styles.performanceMetric}>
        <Text style={styles.muted}>미실현 PnL · USD</Text>
        <Text testID={`futures-position-${p.id}-pnl`} selectable style={[styles.pnl, { color: pnlColor }]}>{display.pnl}</Text>
      </View>
      <View style={styles.performanceMetric}>
        <Text style={styles.muted}>ROI</Text>
        <Text testID={`futures-position-${p.id}-roi`} selectable style={[styles.pnl, { color: pnlColor }]}>{display.roi}</Text>
      </View>
    </View>
    {display.notice ? <Text style={styles.notice}>{display.notice}</Text> : null}
    <View style={[styles.metrics, stacked && styles.stacked]}>
      <Metric label="포지션 규모" value={display.notional} />
      <Metric label="기준 초기 증거금" value={formatMoneyDecimal(p.initialMargin, 'USD')} />
      <Metric label="평균 진입가" value={price(p.averageEntryPrice)} />
      <Metric label="Mark Price" value={display.fresh ? price(p.markPrice) : '-'} />
      <Metric label="보유 계약 수량" value={`${formatDisplayDecimal(p.quantity)} ${p.instrument.underlying.symbol.replace(/USDT$/u, '')}`} />
      <Metric label="누적 실현 손익" value={formatMoneyDecimal(p.realizedPnl, 'USD', true)} />
      {p.marginMode === 'isolated' ? <>
        <Metric label="격리 담보" value={formatMoneyDecimal(p.isolatedMargin, 'USD')} />
        <Metric label="예상 청산가" value={display.fresh && p.risk
          ? p.risk.liquidationPrice === null ? '양수 가격 범위 내 없음' : price(p.risk.liquidationPrice) : '-'} />
        <Metric label="유지 증거금 + 종료 수수료" value={display.fresh ? formatMoneyDecimal(p.risk?.liquidationRequirement, 'USD') : '-'} />
      </> : null}
    </View>
    {p.marginMode === 'cross' ? <Text style={styles.muted}>선물 USD 지갑의 공동 담보를 사용합니다. 교차 담보와 청산 위험은 공동 평가 영역에서 확인해주세요.</Text> : null}
    <ProtectionPanel accountId={accountId} assetId={p.instrument.underlying.assetId} domain="futures"
      positionId={p.id} currency="USD" collapsible onInputFocus={onInputFocus} onInputBlur={onInputBlur} />
    <View style={styles.actions}>
      {(['increase', 'reduce', 'close'] as const).map(op => <CTAButton key={op} variant="secondary"
        testID={`futures-position-${p.id}-${op}`} label={op === 'increase' ? '포지션 증가' : op === 'reduce' ? '포지션 감소' : '전량 종료'}
        style={styles.action} state={disabled || !capabilities[op === 'increase' ? 'canIncrease' : op === 'reduce' ? 'canReduce' : 'canClose']
          ? 'disabled' : 'enabled'} onPress={() => onSelect(op)} />)}
    </View>
  </View>;
}
function Metric({ label, value }: { label: string; value: string }) {
  const { width, fontScale } = useWindowDimensions();
  return <View style={[styles.metric, width / fontScale < 300 && styles.stackedMetric]}><Text style={styles.muted}>{label}</Text><Text selectable style={styles.value}>{value}</Text></View>;
}
const styles = StyleSheet.create({
  card: { minWidth: 0, padding: 16, gap: 14, borderRadius: 16, backgroundColor: semantic.surface },
  header: { minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 },
  name: { minWidth: 0, maxWidth: '100%', flexShrink: 1, fontSize: 18, lineHeight: 27, fontWeight: '700' },
  direction: { fontSize: 13, lineHeight: 20, fontWeight: '700' },
  muted: { fontSize: 12, lineHeight: 19, color: semantic.secondary, flexShrink: 1 },
  performance: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  performanceMetric: { flexGrow: 1, flexShrink: 1, minWidth: 100, maxWidth: '100%', gap: 4 },
  pnl: { fontSize: 23, lineHeight: 34, fontWeight: '700', fontVariant: ['tabular-nums'] },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 12 },
  metric: { minWidth: 120, maxWidth: '100%', flexBasis: 120, flexGrow: 1, flexShrink: 1, gap: 4 },
  stacked: { flexDirection: 'column', alignItems: 'stretch' },
  stackedMetric: { minWidth: 0, flexBasis: 'auto', width: '100%' },
  value: { fontSize: 15, lineHeight: 23, fontVariant: ['tabular-nums'] },
  notice: { fontSize: 12, lineHeight: 19, color: semantic.warning },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { flexGrow: 1, flexShrink: 1, minWidth: 100, maxWidth: '100%' },
});
