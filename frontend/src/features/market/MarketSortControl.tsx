import React from 'react';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import DisclosureTriangle from '../../components/common/DisclosureTriangle';
import { marketSortParams, type MarketSort } from './marketSort';

export default function MarketSortControl({ value, onChange }: {
  value: MarketSort;
  onChange: (value: MarketSort) => void;
}) {
  const { sortBy, sortOrder } = marketSortParams(value);
  const select = (criterion: 'turnover' | 'changeRate', direction: 'asc' | 'desc') =>
    onChange(`${criterion === 'turnover' ? 'turnover' : 'change'}_${direction}`);
  return (
    <View testID="market-sort-control" style={styles.control}>
      {(['turnover', 'changeRate'] as const).map((criterion) => {
        const selected = sortBy === criterion;
        return (
          <ActionPressable key={criterion} testID={`market-sort-${criterion}`}
            accessibilityRole="radio" accessibilityLabel={criterion === 'turnover' ? '거래대금 정렬' : '등락률 정렬'}
            accessibilityState={{ checked: selected }} aria-checked={selected}
            onPress={() => select(criterion, sortOrder)}
            style={styles.criterion}>
            <Text style={[styles.text, selected && styles.selectedText]}>{criterion === 'turnover' ? '거래대금' : '등락률'}</Text>
          </ActionPressable>
        );
      })}
      <View style={styles.arrows}>
        {(['asc', 'desc'] as const).map((direction) => {
          const selected = sortOrder === direction;
          return (
            <ActionPressable key={direction} testID={`market-sort-${direction}`}
              feedback="none"
              accessibilityRole="radio" accessibilityLabel={direction === 'asc' ? '오름차순' : '내림차순'}
              accessibilityState={{ checked: selected }} aria-checked={selected}
              onPress={() => select(sortBy, direction)}
              style={[styles.arrow, direction === 'asc' ? styles.asc : styles.desc]}>
              <DisclosureTriangle testID={`market-sort-${direction}-triangle`}
                direction={direction === 'asc' ? 'up' : 'down'}
                color={selected ? semantic.secondaryActionForeground : semantic.muted} />
            </ActionPressable>
          );
        })}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  control: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0, maxWidth: '100%' },
  criterion: { minWidth: 0, flexShrink: 1, minHeight: 44, paddingHorizontal: 8, justifyContent: 'center', borderRadius: 8 },
  text: { fontSize: 13, lineHeight: 20, fontWeight: '600', color: semantic.secondary },
  // Contiguous upper/lower targets never overlap. Align the triangles toward
  // their shared boundary, leaving a 2px visual gap in a transparent 44 × 48 area.
  arrows: { flexShrink: 0 },
  arrow: { width: 44, height: 24, alignItems: 'center' },
  asc: { justifyContent: 'flex-end', paddingBottom: 1 },
  desc: { justifyContent: 'flex-start', paddingTop: 1 },
  selectedText: { color: semantic.secondaryActionForeground },
});
