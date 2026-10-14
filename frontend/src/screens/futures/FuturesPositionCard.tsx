import { useLearningAccess } from '../../features/quest/useLearningAccess';
import { useQuestGuide } from '../../features/quest/QuestGuideProvider';
import { questGuideTarget } from '../../features/quest/questGuideBridge';
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { View, Text, StyleSheet, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getProtections, type ProtectionGroup } from '../../features/conditional/api';
import type { FuturesPosition, FuturesCapabilities, Operation } from '../../features/futures/api';
import { futuresHolding, getFuturesPositionDisplay } from '../../features/futures/positionDisplay';
import { formatAssetPrice, formatDisplayDecimal, formatMoneyDecimal, getFinancialDirection } from '../../utils/format';
import CTAButton from '../../components/common/CTAButton';
import ProtectionPanel from '../../features/conditional/ProtectionPanel';

type Props = { position: FuturesPosition; accountId: string; evaluatedAt: string; now: number;
  disabled: boolean; capabilities: FuturesCapabilities; onSelect: (operation: Exclude<Operation, 'open'>) => void;
  /** Whether this card shows its TP/SL panel (one card at a time). */
  protectionOpen: boolean;
  /** Opens or closes this position's TP/SL panel in the card. */
  onProtection: () => void;
  onInputFocus?: (input: View | null) => void; onInputBlur?: () => void };

/**
 * One open futures position: what it is (contract, direction, margin mode,
 * leverage), how it performs on Mark, its size and prices, its TP/SL and
 * realized result, and the actions that select it in the trade form. A
 * liquidation price is individual to an isolated position only. TP/SL is set,
 * changed and canceled here, in the existing protection panel of this
 * position — never through the trade form's 조건주문 (a new-position entry).
 */
export default function FuturesPositionCard({ position: p, accountId, evaluatedAt, now,
  disabled, capabilities, onSelect, protectionOpen, onProtection, onInputFocus, onInputBlur }: Props) {
  const { width, fontScale } = useWindowDimensions();
  const learning = useLearningAccess(accountId).gate('allTrading');
  const guide = useQuestGuide();
  const stacked = width / fontScale < 300;
  // Entry | Mark | Liq. read as one row on phones; narrow screens use two columns.
  const columns = stacked ? 1 : width < 360 ? 2 : 3;
  const display = getFuturesPositionDisplay(futuresHolding(p), evaluatedAt, now);
  const price = (value: string | null | undefined) => value == null ? '-'
    : formatAssetPrice(value, 'USD', p.instrument.underlying.displayPriceDecimals);
  const pnlColor = display.pnlDirection === 'neutral' ? semantic.secondary : financial[display.pnlDirection];
  const realizedDirection = getFinancialDirection(p.realizedPnl);
  const isolated = p.marginMode === 'isolated';
  return <View ref={guide?.active?.positionId === p.id ? questGuideTarget('futures-position') : undefined} collapsable={false} style={styles.card} testID={`futures-position-${p.id}`}>
    <View style={styles.header}>
      <Text style={[styles.direction, { color: p.direction === 'long' ? BUY_COLOR : SELL_COLOR }]}>{display.direction}</Text>
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
      <Metric columns={columns} label="보유 수량" value={`${formatDisplayDecimal(p.quantity)} ${p.instrument.underlying.symbol.replace(/USDT$/u, '')}`} />
      <Metric columns={columns} label="평균 진입가" value={price(p.averageEntryPrice)} />
      <Metric columns={columns} label="Mark Price" value={display.fresh ? price(p.markPrice) : '-'} />
      {isolated ? <>
        <Metric columns={columns} label="예상 청산가" value={display.fresh && p.risk
          ? p.risk.liquidationPrice === null ? '양수 가격 범위 내 없음' : price(p.risk.liquidationPrice) : '-'} />
        <Metric columns={columns} label="격리 담보" value={formatMoneyDecimal(p.isolatedMargin, 'USD')} />
        <Metric columns={columns} label="유지 증거금 + 종료 수수료" value={display.fresh ? formatMoneyDecimal(p.risk?.liquidationRequirement, 'USD') : '-'} />
      </> : null}
    </View>
    {isolated ? null : <Text style={styles.caption}>선물 USD 지갑의 공동 담보를 사용합니다. 교차 담보와 청산 위험은 공동 평가 영역에서 확인해주세요.</Text>}
    <ProtectionSummary position={p} accountId={accountId} price={price} disabled={disabled} open={protectionOpen} onProtection={onProtection} />
    {protectionOpen ? (
      <ProtectionPanel accountId={accountId} assetId={p.instrument.underlying.assetId} domain="futures" positionId={p.id}
        currency="USD" onInputFocus={onInputFocus} onInputBlur={onInputBlur} />
    ) : null}
    <View style={styles.line} testID={`futures-position-${p.id}-realized`}>
      <Text style={styles.lineLabel}>누적 실현 손익 · USD</Text>
      <Text selectable style={[styles.lineValue, realizedDirection !== 'neutral' && { color: financial[realizedDirection] }]}>
        {formatMoneyDecimal(p.realizedPnl, 'USD', true)}
      </Text>
    </View>
    <View style={styles.actions}>
      {(['increase', 'reduce', 'close'] as const).map(op => <CTAButton key={op} variant="secondary"
        testID={`futures-position-${p.id}-${op}`} label={op === 'increase' ? '포지션 증가' : op === 'reduce' ? '포지션 감소' : '전량 종료'}
        learningHint={op === 'increase' && learning.locked ? learning.message : null}
        style={styles.action} state={disabled || !capabilities[op === 'increase' ? 'canIncrease' : op === 'reduce' ? 'canReduce' : 'canClose']
          ? 'disabled' : 'enabled'} onPress={() => op === 'increase' ? learning.guard(() => onSelect(op)) : onSelect(op)} />)}
    </View>
  </View>;
}

/**
 * The position's live TP/SL group at a glance (TP / SL triggers). Its button
 * opens this card's protection panel (register, change, cancel, history); this
 * line only reads the same account-scoped protection list.
 */
function ProtectionSummary({ position: p, accountId, price, disabled, open, onProtection }: {
  position: FuturesPosition; accountId: string; price: (value: string | null | undefined) => string;
  disabled: boolean; open: boolean; onProtection: () => void;
}) {
  const focused = useIsFocused();
  const assetId = p.instrument.underlying.assetId;
  const query = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.protections.list(accountId, 'futures', assetId),
    queryFn: ({ signal }) => getProtections(accountId, 'futures', assetId, false, signal),
    enabled: focused, refetchInterval: focused ? 4000 : false, retry: false,
  });
  const data = !query.isError && query.data?.tradingAccountId === accountId ? query.data : undefined;
  const group = data?.groups.find(g => g.status === 'active' || g.status === 'holding');
  const status = query.isError ? '확인 불가' : !data ? '확인 중' : group ? protectionText(group, price) : '미설정';
  return <View style={styles.protection}>
    <View style={styles.protectionCopy}>
      <Text style={styles.caption}>TP/SL · 익절 / 손절</Text>
      <Text testID={`futures-position-${p.id}-protection-status`} selectable style={styles.protectionValue}>{status}</Text>
    </View>
    <CTAButton variant="secondary" testID={`futures-position-${p.id}-protection`} label={open ? 'TP/SL 접기' : group ? 'TP/SL 관리' : 'TP/SL 설정'}
      style={styles.protectionAction} state={disabled && !open ? 'disabled' : 'enabled'} onPress={onProtection} />
  </View>;
}

function protectionText(group: ProtectionGroup, price: (value: string | null | undefined) => string) {
  if (group.status === 'holding') return '진입 체결 대기';
  const trigger = (kind: 'take_profit' | 'stop_loss') => {
    const leg = group.legs.find(item => item.kind === kind);
    return leg ? price(leg.triggerPrice) : '--';
  };
  return `${trigger('take_profit')} / ${trigger('stop_loss')}`;
}

/** Fixed columns keep a short last row aligned with the rows above it. */
const COLUMN_WIDTH = { 1: '100%', 2: '46%', 3: '30%' } as const;
function Metric({ label, value, columns }: { label: string; value: string; columns: 1 | 2 | 3 }) {
  return <View style={[styles.metric, { width: COLUMN_WIDTH[columns] }]}><Text style={styles.caption}>{label}</Text><Text selectable style={styles.value}>{value}</Text></View>;
}
const styles = StyleSheet.create({
  card: { minWidth: 0, padding: 14, gap: 12, borderRadius: 12, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface },
  header: { minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 4 },
  direction: { fontSize: 13, lineHeight: 20, fontWeight: '800' },
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
  protection: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 8, minWidth: 0 },
  protectionCopy: { flexGrow: 1, flexShrink: 1, flexBasis: 140, minWidth: 0, gap: 2 },
  protectionValue: { fontSize: 14, lineHeight: 21, fontWeight: '600', color: semantic.text, fontVariant: ['tabular-nums'] },
  protectionAction: { flexGrow: 0, flexShrink: 0, minHeight: 40, paddingHorizontal: 14 },
  line: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 12, rowGap: 2,
    minWidth: 0, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: semantic.border },
  lineLabel: { flexShrink: 1, fontSize: 13, lineHeight: 19, color: semantic.secondary },
  lineValue: { flexShrink: 1, fontSize: 14, lineHeight: 21, fontWeight: '600', color: semantic.text, textAlign: 'right', fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { flexGrow: 1, flexShrink: 1, minWidth: 96, maxWidth: '100%' },
});
