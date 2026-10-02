import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import BottomSheetBackdrop from '../../components/common/BottomSheetBackdrop';
import { MARKET_SORTS, type MarketSort } from './marketSort';
import type { AssetType } from './api';

export default function MarketSortControl({ value, onChange, assetType }: {
  value: MarketSort;
  onChange: (value: MarketSort) => void;
  assetType?: AssetType | 'all';
}) {
  const [open, setOpen] = useState(false);
  const label = value === 'volume_desc'
    ? `${assetType === 'crypto' ? '24h ' : ''}거래량 ↓`
    : (MARKET_SORTS.find((sort) => sort.value === value) ?? MARKET_SORTS[0]).label;
  return (
    <View>
      <ActionPressable testID="market-sort-trigger" accessibilityRole="button"
        accessibilityLabel={`정렬: ${label}`} accessibilityState={{ expanded: open }}
        aria-expanded={open}
        onPress={() => setOpen(true)} style={styles.trigger}>
        <Text style={styles.text}>{label} ▾</Text>
      </ActionPressable>
      <BottomSheetBackdrop visible={open} onClose={() => setOpen(false)}>
        <ScrollView contentContainerStyle={styles.sheet}>
          <Text accessibilityRole="header" style={styles.heading}>정렬</Text>
          {MARKET_SORTS.map((sort) => (
            <ActionPressable key={sort.value} testID={`market-sort-${sort.value}`}
              accessibilityRole="radio" accessibilityState={{ checked: value === sort.value }}
              aria-checked={value === sort.value}
              onPress={() => { onChange(sort.value); setOpen(false); }}
              style={[styles.option, value === sort.value && styles.selected]}>
              <Text style={styles.text}>{sort.label}{value === sort.value ? ' ✓' : ''}</Text>
            </ActionPressable>
          ))}
          <Text style={styles.note}>
            {assetType === 'crypto'
              ? '거래량은 최근 24시간 코인 수량입니다. 코인마다 단위가 달라 거래대금 순위와 다릅니다.'
              : assetType === 'all' || !assetType
                ? '주식은 거래 세션의 누적 주식 수, 암호화폐는 최근 24시간 코인 수량입니다. 상품마다 기간과 단위가 다릅니다.'
                : '거래량은 거래 세션의 누적 주식 수입니다. 휴장 중에는 최근 완료 세션의 마지막 유효 값을 사용합니다.'}
          </Text>
          <Text style={styles.note}>확인할 수 없는 값은 마지막에 표시합니다. 새로고침하면 최신 기준으로 정렬합니다.</Text>
          <ActionPressable accessibilityRole="button" onPress={() => setOpen(false)} style={styles.option}>
            <Text style={styles.text}>닫기</Text>
          </ActionPressable>
        </ScrollView>
      </BottomSheetBackdrop>
    </View>
  );
}
const styles = StyleSheet.create({
  trigger: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center', alignSelf: 'flex-end' },
  text: { fontSize: 13, lineHeight: 20, fontWeight: '600', color: semantic.text },
  heading: { fontSize: 18, lineHeight: 26, fontWeight: '700', color: semantic.text },
  sheet: { gap: 8 },
  option: { minHeight: 48, justifyContent: 'center', padding: 12, borderRadius: 8 },
  selected: { backgroundColor: semantic.raised },
  note: { fontSize: 12, lineHeight: 18, color: semantic.secondary },
});
