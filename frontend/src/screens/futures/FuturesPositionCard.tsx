import { useQuestGuide } from '../../features/quest/QuestGuideProvider';
import { questGuideTarget } from '../../features/quest/questGuideBridge';
import React from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import type { FuturesPosition, FuturesCapabilities } from '../../features/futures/api';
import { futuresHolding, getFuturesPositionDisplay } from '../../features/futures/positionDisplay';
import { TP_SL_TITLE } from '../../features/conditional/tpSlModel';
import { formatAssetPrice, formatMoneyDecimal } from '../../utils/format';
import CTAButton from '../../components/common/CTAButton';
import FuturesDirectionBadge from '../../components/tradingAccount/FuturesDirectionBadge';

type Props = { position: FuturesPosition; evaluatedAt: string; now: number;
  disabled: boolean; capabilities: FuturesCapabilities;
  /** `익절 2건 · 손절 1건` of this lifetime's live settings; null when none/unknown. */
  tpSlSummary: string | null;
  /** Opens this position's 손절가/익절가 bottom sheet. */
  onTpSl: () => void;
  /** Opens this position's 포지션 종료 bottom sheet (the whole position, or a part of it). */
  onClose: () => void };

/**
 * One open futures position: what it is (side, contract, margin mode,
 * leverage), how it performs on Mark, its size, prices and estimated closing
 * fee, and its two actions side by side — 손절가/익절가 설정 and 포지션 종료,
 * each in its own bottom sheet over this screen. A liquidation price is
 * individual to an isolated position only. Adding to a position (or reducing
 * it by an amount) stays in the trade form above, for the selected contract.
 */
export default function FuturesPositionCard({ position: p, evaluatedAt, now,
  disabled, capabilities, tpSlSummary, onTpSl, onClose }: Props) {
  const { width, fontScale } = useWindowDimensions();
  const guide = useQuestGuide();
  const stacked = width / fontScale < 300;
  // Entry | Mark | Liq. read as one row on phones; narrow screens use two columns.
  const columns = stacked ? 1 : width < 360 ? 2 : 3;
  const display = getFuturesPositionDisplay(futuresHolding(p), evaluatedAt, now);
  const price = (value: string | null | undefined) => value == null ? '-'
    : formatAssetPrice(value, 'USD', p.instrument.underlying.displayPriceDecimals);
  const pnlColor = display.pnlDirection === 'neutral' ? semantic.secondary : financial[display.pnlDirection];
  const isolated = p.marginMode === 'isolated';
  return <View ref={guide?.active?.positionId === p.id ? questGuideTarget('futures-position') : undefined} collapsable={false} style={styles.card} testID={`futures-position-${p.id}`}>
    <View style={styles.header}>
      <FuturesDirectionBadge testID={`futures-position-${p.id}-direction`} direction={p.direction} />
      <Text style={styles.name}>{display.name}</Text>
      <Text style={styles.badge}>무기한</Text>
      <Text testID={`futures-position-${p.id}-margin`} style={styles.badge}>{isolated ? '격리' : '교차'} {p.leverage}x</Text>
    </View>
    <View style={[styles.performance, stacked && styles.stacked]}>
      <View style={styles.performanceMetric}>
        <Text style={styles.caption}>미실현 손익 · USD</Text>
        <Text testID={`futures-position-${p.id}-pnl`} selectable style={[styles.pnl, { color: pnlColor }]}>{display.pnl}</Text>
      </View>
      <View style={[styles.performanceMetric, !stacked && styles.end]}>
        <Text style={[styles.caption, !stacked && styles.right]}>ROI</Text>
        <Text testID={`futures-position-${p.id}-roi`} selectable style={[styles.pnl, !stacked && styles.right, { color: pnlColor }]}>{display.roi}</Text>
      </View>
    </View>
    {display.notice ? <Text style={styles.notice}>{display.notice}</Text> : null}
    <View style={styles.metrics}>
      <Metric columns={columns} label="포지션 규모" value={display.notional} />
      <Metric columns={columns} label="기준 초기 증거금" value={formatMoneyDecimal(p.initialMargin, 'USD')} />
      {/* The server's estimate of the fee to close the whole position now (on Mark). */}
      <Metric columns={columns} label="예상 종료 수수료" testID={`futures-position-${p.id}-fee`}
        value={display.fresh ? formatMoneyDecimal(p.risk?.estimatedCloseFee, 'USD') : '-'} />
      <Metric columns={columns} label="평균 진입가" value={price(p.averageEntryPrice)} />
      <Metric columns={columns} label="Mark Price" value={display.fresh ? price(p.markPrice) : '-'} />
      {isolated ? (
        <Metric columns={columns} label="예상 청산가" value={display.fresh && p.risk
          ? p.risk.liquidationPrice === null ? '양수 가격 범위 내 없음' : price(p.risk.liquidationPrice) : '-'} />
      ) : null}
    </View>
    {isolated ? null : <Text style={styles.caption}>선물 USD 지갑의 공동 담보를 사용합니다. 교차 담보와 청산 위험은 공동 평가 영역에서 확인해주세요.</Text>}
    {tpSlSummary ? (
      <Text testID={`futures-position-${p.id}-protection-summary`} style={styles.summary}>{`${TP_SL_TITLE} · ${tpSlSummary}`}</Text>
    ) : null}
    <View style={[styles.actions, stacked && styles.stacked]}>
      <CTAButton variant="secondary" testID={`futures-position-${p.id}-protection`} label={TP_SL_TITLE}
        style={stacked ? undefined : styles.action} onPress={onTpSl} />
      <CTAButton variant="secondary" testID={`futures-position-${p.id}-close`} label="포지션 종료"
        style={stacked ? undefined : styles.action}
        state={disabled || !(capabilities.canClose || capabilities.canReduce) ? 'disabled' : 'enabled'} onPress={onClose} />
    </View>
  </View>;
}

/** Fixed columns keep a short last row aligned with the rows above it. */
const COLUMN_WIDTH = { 1: '100%', 2: '46%', 3: '30%' } as const;
function Metric({ label, value, columns, testID }: { label: string; value: string; columns: 1 | 2 | 3; testID?: string }) {
  return <View style={[styles.metric, { width: COLUMN_WIDTH[columns] }]}><Text style={styles.caption}>{label}</Text><Text testID={testID} selectable style={styles.value}>{value}</Text></View>;
}
const styles = StyleSheet.create({
  card: { minWidth: 0, padding: 14, gap: 12, borderRadius: 12, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface },
  header: { minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 4 },
  name: { minWidth: 0, maxWidth: '100%', flexShrink: 1, fontSize: 17, lineHeight: 25, fontWeight: '700', color: semantic.text },
  badge: { fontSize: 11, lineHeight: 15, fontWeight: '600', color: semantic.secondary, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5, backgroundColor: semantic.raised, overflow: 'hidden' },
  caption: { fontSize: 12, lineHeight: 18, color: semantic.secondary, flexShrink: 1 },
  performance: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 },
  performanceMetric: { flexShrink: 1, minWidth: 0, maxWidth: '100%', gap: 2 },
  // ROI keeps the right edge, also on its own line under a long PnL.
  end: { flexGrow: 1, alignItems: 'flex-end' },
  right: { textAlign: 'right' },
  pnl: { fontSize: 22, lineHeight: 31, fontWeight: '700', fontVariant: ['tabular-nums'] },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 10 },
  metric: { minWidth: 0, gap: 2 },
  stacked: { flexDirection: 'column', alignItems: 'stretch' },
  value: { fontSize: 15, lineHeight: 22, color: semantic.text, fontVariant: ['tabular-nums'] },
  notice: { fontSize: 12, lineHeight: 19, color: semantic.warning },
  summary: { fontSize: 13, lineHeight: 19, fontWeight: '600', color: semantic.secondary },
  actions: { flexDirection: 'row', gap: 8 },
  // Two equal halves from a zero basis: each label is measured at its final
  // width, so a long one wraps to a second line instead of being cut.
  action: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
});
