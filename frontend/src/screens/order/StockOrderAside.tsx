import React, { useState } from 'react';
import { Text, View, useWindowDimensions, type StyleProp, type TextStyle, type View as ViewType } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import ActionPressable from '../../components/common/ActionPressable';
import type { SpotHoldingDisplay } from '../../features/position/assetDisplay';
import { getPositionAssetDisplay } from '../../features/position/assetDisplay';
import { formatMoneyDecimal } from '../../utils/format';
import { fitFontSize, formatEnteredAmount, type OrderSummaryBadge } from './stockOrderSummary';

/**
 * The stock order card's right column (A-2 시안): label/value rows that stay
 * readable in a narrow column. A row whose label and value do not fit side by
 * side puts the value on its own line, right-aligned; nothing is cut.
 */
export function SummaryRow({ label, value, testID, emphasis = false, muted = false, valueStyle, valueTestIDs }: {
  label: string;
  /** One figure, or several stacked right-aligned (an amount and its rate). */
  value: string | readonly string[];
  testID?: string;
  emphasis?: boolean;
  muted?: boolean;
  valueStyle?: StyleProp<TextStyle>;
  /** Per-line test ids; the first line defaults to `<testID>-value`. */
  valueTestIDs?: readonly string[];
}) {
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const lines = typeof value === 'string' ? [value] : value;
  // A figure longer than the whole row shrinks rather than breaking between digits.
  const base = emphasis ? 15 : muted ? 12 : 13;
  const fontSize = Math.min(...lines.map((line) => fitFontSize(line, width, fontScale, 10, base)));
  const line = (text: string, index: number) => (
    <Text key={index} testID={valueTestIDs?.[index] ?? (index === 0 && testID ? `${testID}-value` : undefined)}
      style={[styles.rowValue, emphasis && styles.emphasis, muted && styles.mutedValue, valueStyle, fontSize < base ? { fontSize } : null]}>{text}</Text>
  );
  return (
    <View style={styles.row} testID={testID} onLayout={(event) => {
      const next = Math.floor(event.nativeEvent.layout.width);
      setWidth((previous) => (previous === next ? previous : next));
    }}>
      <Text style={[styles.rowLabel, muted && styles.mutedText]}>{label}</Text>
      {lines.length === 1 ? line(lines[0], 0) : <View style={styles.rowValueBox}>{lines.map(line)}</View>}
    </View>
  );
}

/**
 * 예상 주문: what the form would send, before anything is submitted. The
 * badge is the expected handling of this order (e.g. 정규장 대기 for a limit
 * order while the market is closed), never an accepted or filled state.
 */
export function OrderSummaryCard({ targetRef, badge, rows, fee, total, after, children }: {
  /** The beginner guide's 'order-preview' target: the fee and the total (금액과 수수료). */
  targetRef?: React.Ref<ViewType>;
  badge: OrderSummaryBadge | null;
  rows: Array<{ label: string; value: string; testID: string }>;
  fee: { label: string; value: string; testID: string };
  total: { label: string; value: string; testID: string };
  after: { label: string; value: string; testID: string; short?: boolean } | null;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.summaryCard} testID="order-indicative-preview">
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>예상 주문</Text>
        {badge ? (
          <Text testID="order-summary-badge" style={[styles.badge, BADGE_TONE[badge.tone]]}>{badge.label}</Text>
        ) : null}
      </View>
      {rows.map((row) => <SummaryRow key={row.testID} {...row} />)}
      <View ref={targetRef} collapsable={false} style={styles.amounts} testID="order-summary-amounts">
        <SummaryRow {...fee} />
        <View style={styles.divider} />
        <SummaryRow {...total} emphasis />
      </View>
      {after ? <SummaryRow {...after} muted valueStyle={after.short ? styles.shortValue : undefined} /> : null}
      {children}
    </View>
  );
}

/** 내 보유: the current holding of this order's account, from the holdings read. */
export function HoldingSummaryCard({ state, position, onRetry, figuresRef, children }: {
  state: 'loading' | 'error' | 'ready';
  position: (SpotHoldingDisplay & { averageCost: string; currencyCode: string }) | null;
  onRetry?: () => void;
  /** The beginner guide's 'asset-holdings' target: 보유 수량, 평균단가, 평가손익. */
  figuresRef?: React.Ref<ViewType>;
  /** The holding's own actions (손절가/익절가) under its figures. */
  children?: React.ReactNode;
}) {
  const display = position ? getPositionAssetDisplay(position) : null;
  return (
    <View style={styles.holdingCard} testID="order-holding-summary">
      <Text style={styles.cardTitle}>내 보유</Text>
      {state === 'loading' ? (
        <Text style={styles.stateText}>보유 정보를 확인하는 중이에요.</Text>
      ) : state === 'error' ? (
        <>
          <Text style={styles.errorText}>보유 정보를 불러오지 못했어요.</Text>
          {onRetry ? (
            <ActionPressable testID="order-holding-retry" accessibilityRole="button" onPress={onRetry} style={styles.retry}>
              <Text style={styles.retryText}>다시 시도</Text>
            </ActionPressable>
          ) : null}
        </>
      ) : !position || !display ? (
        <Text testID="order-holding-empty" style={styles.stateText}>보유하고 있지 않아요.</Text>
      ) : (
        <View ref={figuresRef} collapsable={false} style={styles.figures} testID="order-holding-figures">
          <SummaryRow testID="order-holding-quantity" label="보유 수량" value={`${formatEnteredAmount(position.quantity, null)}주`} />
          <SummaryRow testID="order-holding-average" label="평균단가" value={formatMoneyDecimal(position.averageCost, position.currencyCode)} />
          <SummaryRow testID="order-holding-pnl" label="평가손익" value={[display.pnl, display.returnRate]}
            valueTestIDs={['order-holding-pnl-value', 'order-holding-return']} valueStyle={DIRECTION[display.direction]} />
          {display.notice ? <Text style={styles.noticeText}>{display.notice}</Text> : null}
        </View>
      )}
      {children}
    </View>
  );
}

const DIRECTION = {
  rise: { color: financial.rise },
  fall: { color: financial.fall },
  neutral: { color: semantic.text },
} as const;

const BADGE_TONE = {
  warning: { color: semantic.warning, backgroundColor: semantic.warningSurface },
  info: { color: semantic.info, backgroundColor: semantic.infoSurface },
  error: { color: semantic.error, backgroundColor: semantic.errorSurface },
} as const;

// RN types want a mutable array; the style object below is `as const`.
const TABULAR_NUMS: Array<'tabular-nums'> = ['tabular-nums'];

// Plain objects: the order harnesses load this with minimal native mocks.
export const styles = {
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: 8,
    rowGap: 2,
    minWidth: 0,
  },
  rowLabel: { flexShrink: 1, minWidth: 0, fontSize: 13, lineHeight: 19, color: semantic.secondary },
  rowValue: {
    flexShrink: 1,
    minWidth: 0,
    marginLeft: 'auto',
    textAlign: 'right',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
    color: semantic.text,
    fontVariant: TABULAR_NUMS,
  },
  rowValueBox: { flexShrink: 1, minWidth: 0, marginLeft: 'auto', alignItems: 'flex-end' },
  emphasis: { fontSize: 15, lineHeight: 21, fontWeight: '700' },
  mutedText: { fontSize: 12, lineHeight: 18, color: semantic.muted },
  mutedValue: { fontSize: 12, lineHeight: 18, fontWeight: '500', color: semantic.secondary },
  shortValue: { color: semantic.error, fontWeight: '700' },
  cardHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 6, rowGap: 4 },
  cardTitle: { fontSize: 12, lineHeight: 18, color: semantic.muted },
  badge: {
    marginLeft: 'auto',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  divider: { height: 1, backgroundColor: semantic.border, marginVertical: 2 },
  amounts: { gap: 8, minWidth: 0 },
  figures: { gap: 8, minWidth: 0 },
  summaryCard: {
    gap: 8,
    minWidth: 0,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.surface,
  },
  holdingCard: {
    gap: 8,
    minWidth: 0,
    padding: 12,
    borderRadius: 12,
    backgroundColor: semantic.raised,
  },
  stateText: { fontSize: 12, lineHeight: 18, color: semantic.secondary },
  errorText: { fontSize: 12, lineHeight: 18, color: semantic.error },
  noticeText: { fontSize: 11, lineHeight: 16, color: semantic.warning, textAlign: 'right' },
  retry: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  retryText: { fontSize: 12, fontWeight: '600', color: semantic.info },
} as const;
