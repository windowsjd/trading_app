import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { LineChart } from '../../components/charts';
import DisclosureTriangle from '../../components/common/DisclosureTriangle';
import ActionPressable from '../../components/common/ActionPressable';
import ErrorNotice from '../../components/states/ErrorNotice';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import type { TradingAccountEquityDto } from '../../features/tradingAccount/api';
import { formatKrwDecimal } from '../../utils/format';

export const HOME_EQUITY_RANGES = ['7d', '30d', '90d', '180d', '360d'] as const;
export type HomeEquityRange = typeof HOME_EQUITY_RANGES[number];

/** The disclosure and its content are adjacent in both account modes. */
export default function HomeAssetTrend({
  expanded, onToggle, range, onRangeChange, equity, loading, failed, error, general,
}: {
  expanded: boolean;
  onToggle: () => void;
  range: HomeEquityRange;
  onRangeChange: (range: HomeEquityRange) => void;
  equity: TradingAccountEquityDto | undefined;
  loading: boolean;
  failed: boolean;
  error?: unknown;
  general: boolean;
}) {
  const points = useMemo(() => equity?.points.map((point) => ({
    x: point.snapshotDate,
    label: point.snapshotDate,
    y: point.totalAssetKrw,
  })) ?? [], [equity]);
  return (
    <View style={styles.container}>
      <ActionPressable
        testID="home-trend-toggle"
        accessibilityRole="button"
        accessibilityLabel="자산추이 보기"
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={onToggle}
        style={styles.toggle}
      >
        <Text style={styles.toggleText}>자산추이 보기</Text>
        <DisclosureTriangle testID="home-trend-disclosure" direction={expanded ? 'up' : 'down'} color={semantic.secondaryActionForeground} />
      </ActionPressable>
      {expanded ? (
        <View testID="home-trend-chart" style={styles.card}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.heading}>자산 추이</Text>
            <View style={styles.ranges}>
              {HOME_EQUITY_RANGES.map((period) => (
                <ActionPressable
                  key={period}
                  testID={`home-trend-range-${period}`}
                  accessibilityRole="button"
                  accessibilityLabel={`최근 ${period.slice(0, -1)}일`}
                  accessibilityState={{ selected: period === range }}
                  aria-selected={period === range}
                  onPress={() => onRangeChange(period)}
                  style={[styles.period, period === range && styles.selected]}
                >
                  <Text style={[styles.periodText, period === range && styles.selectedText]}>
                    {period.toUpperCase()}
                  </Text>
                </ActionPressable>
              ))}
            </View>
          </View>
          {failed ? <View style={styles.failure}>
            <Text style={styles.failureTitle}>데이터가 없습니다.</Text>
            <ErrorNotice error={error} message="자산 추이를 불러오지 못했습니다." style={styles.failureMessage} />
          </View> : null}
          {loading ? <SectionSkeleton lines={4} /> : failed && !equity ? null : (
            <LineChart
              key={range}
              points={points}
              height={216}
              xScale="time"
              selectionDisplay="tooltip"
              pointValueFormatter={(point) => `${formatKrwDecimal(point.y)}원`}
              emptyMessage="표시할 일별 자산 기록이 없습니다."
            />
          )}
          {general ? (
            <Text style={styles.note}>
              총 자산에는 광고 보상 등 외부 자금이 포함됩니다. 투자 성과는 시간가중 수익률을 확인하세요.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { minWidth: 0 },
  toggle: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 8 },
  toggleText: { flexShrink: 1, fontSize: 13, lineHeight: 20, color: semantic.secondaryActionForeground, fontWeight: '600' },
  // No outline: the transparent 1px border keeps the content inset unchanged.
  card: { borderWidth: 1, borderColor: 'transparent', borderRadius: 14, padding: 16, backgroundColor: semantic.surface, gap: 12 },
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  heading: { fontSize: 18, lineHeight: 26, fontWeight: '700', color: semantic.text },
  ranges: { flexDirection: 'row', flexBasis: 220, flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: '100%', flexWrap: 'wrap', justifyContent: 'flex-end' },
  period: { minHeight: 44, minWidth: 44, flexGrow: 1, paddingHorizontal: 4, justifyContent: 'center', alignItems: 'center', borderBottomWidth: 2, borderBottomColor: semantic.border },
  selected: { borderBottomColor: semantic.info },
  periodText: { fontSize: 12, lineHeight: 18, color: semantic.secondary },
  selectedText: { color: semantic.info, fontWeight: '700' },
  note: { fontSize: 12, lineHeight: 18, color: semantic.secondary },
  failure: { borderWidth: 1, borderColor: semantic.border, borderRadius: 12, padding: 14, backgroundColor: semantic.raised, gap: 6 },
  failureTitle: { fontSize: 15, fontWeight: '700', lineHeight: 21 },
  failureMessage: { fontSize: 14, color: semantic.secondary, lineHeight: 20 },
});
