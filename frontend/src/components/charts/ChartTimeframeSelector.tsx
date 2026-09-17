import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ASSET_CHART_TIMEFRAMES, type AssetChartTimeframe } from '../../features/asset/chartTimeframes';
import ActionPressable from '../common/ActionPressable';
import BottomSheetBackdrop from '../common/BottomSheetBackdrop';

const groups = [
  { title: '분', intervals: ASSET_CHART_TIMEFRAMES.filter((item) => item.interval.endsWith('m')) },
  { title: '시간', intervals: ASSET_CHART_TIMEFRAMES.filter((item) => item.interval.endsWith('h')) },
  { title: '일 / 주', intervals: ASSET_CHART_TIMEFRAMES.filter((item) => /[dw]$/.test(item.interval)) },
];

const label = ({ interval }: AssetChartTimeframe) => interval
  .replace('m', '분').replace('h', '시간').replace('d', '일').replace('w', '주');

export default function ChartTimeframeSelector({ selectedTimeframe, onSelect }: {
  selectedTimeframe: AssetChartTimeframe;
  onSelect: (timeframe: AssetChartTimeframe) => void;
}) {
  const [open, setOpen] = useState(false);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const close = () => setOpen(false);

  return (
    <>
      <ActionPressable
        testID="asset-timeframe-selector"
        style={styles.trigger}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`시간봉 선택. 현재 ${label(selectedTimeframe)}`}
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.triggerText}>{label(selectedTimeframe)} ▾</Text>
      </ActionPressable>
      <BottomSheetBackdrop visible={open} onClose={close}>
        <View style={[styles.sheetContent, { maxHeight: Math.max(0, height - insets.top - 64) }]} accessibilityViewIsModal>
          <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: insets.bottom }}>
            <View style={styles.header}>
              <Text style={styles.title} accessibilityRole="header">시간봉</Text>
              <ActionPressable
                testID="asset-timeframe-close"
                style={styles.close}
                onPress={close}
                accessibilityRole="button"
                accessibilityLabel="시간봉 목록 닫기"
              >
                <Text style={styles.closeText}>닫기</Text>
              </ActionPressable>
            </View>
            {groups.map((group) => (
              <View key={group.title}>
                <Text style={styles.groupTitle} accessibilityRole="header">{group.title}</Text>
                {group.intervals.map((timeframe) => {
                  const selected = timeframe.interval === selectedTimeframe.interval;
                  return (
                    <ActionPressable
                      key={timeframe.interval}
                      testID={`asset-timeframe-option-${timeframe.interval}`}
                      style={[styles.option, selected && styles.selected]}
                      accessibilityRole="button"
                      accessibilityLabel={label(timeframe)}
                      accessibilityState={{ selected }}
                      onPress={() => {
                        close();
                        if (!selected) onSelect(timeframe);
                      }}
                    >
                      <Text style={[styles.optionText, selected && styles.selectedText]}>{label(timeframe)}</Text>
                      {selected ? <Text style={styles.selectedText} accessible={false}>✓</Text> : null}
                    </ActionPressable>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </View>
      </BottomSheetBackdrop>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: { alignSelf: 'flex-start', maxWidth: '100%', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#111' },
  triggerText: { color: '#fff', fontWeight: '600', flexShrink: 1 },
  sheetContent: { flexShrink: 1 },
  header: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  title: { flexGrow: 1, flexShrink: 1, fontSize: 20, fontWeight: '700' },
  close: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, maxWidth: '100%' },
  closeText: { fontSize: 16, color: '#444', flexShrink: 1 },
  list: { flexShrink: 1 },
  groupTitle: { fontSize: 14, color: '#666', marginTop: 12, marginBottom: 8 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10 },
  optionText: { flex: 1, fontSize: 16, color: '#111' },
  selected: { backgroundColor: '#111' },
  selectedText: { color: '#fff', fontWeight: '700' },
});
