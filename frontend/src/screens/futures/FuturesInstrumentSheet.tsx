import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import type { FuturesInstrument } from '../../features/futures/api';

/**
 * Contract picker over the futures screen, the counterpart of the spot order
 * screen's asset sheet. It lists the verified catalog only (a position outside
 * it stays reachable from its card); the screen owns the selection and what a
 * change resets. Search appears beyond 12 contracts.
 */
export default function FuturesInstrumentSheet({ visible, instruments, selectedId, onSelect, onClose }: {
  visible: boolean;
  instruments: FuturesInstrument[];
  selectedId: string | undefined;
  onSelect: (instrumentId: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const searchable = instruments.length > 12;
  const query = searchable ? search.trim().toLowerCase() : '';
  const rows = instruments.filter((i) => `${i.underlying.symbol} ${i.underlying.name}`.toLowerCase().includes(query));
  return (
    <SheetPortal>
      <InlineBottomSheet testID="futures-instrument-sheet" title="선물 상품" floating visible={visible} onClose={onClose}>
        {searchable ? (
          <TextInput
            accessibilityLabel="선물 상품 검색"
            value={search}
            onChangeText={setSearch}
            placeholder="이름 또는 심볼"
            style={styles.search}
            autoCapitalize="none"
          />
        ) : null}
        <ScrollView testID="futures-instrument-list" style={styles.scroll} bounces={false} keyboardShouldPersistTaps="handled">
          <View accessibilityRole="radiogroup" accessibilityLabel="선물 상품" style={styles.list}>
            {rows.map((i) => {
              const selected = i.id === selectedId;
              return (
                <ActionPressable
                  key={i.id}
                  testID={`futures-instrument-${i.id}`}
                  accessibilityRole="radio"
                  accessibilityLabel={`${i.underlying.symbol}, ${i.underlying.name}`}
                  accessibilityState={{ selected, checked: selected }}
                  aria-selected={selected}
                  onPress={() => onSelect(i.id)}
                  style={[styles.row, selected && styles.rowSelected]}
                >
                  <View style={styles.rowCopy}>
                    <Text style={styles.symbol}>{i.underlying.symbol}</Text>
                    <Text style={styles.name}>{i.underlying.name} · USD 무기한</Text>
                  </View>
                  {selected ? <Text style={styles.check} accessible={false} importantForAccessibility="no">✓</Text> : null}
                </ActionPressable>
              );
            })}
            {!rows.length ? <Text style={styles.empty}>{query ? '검색 결과가 없습니다.' : '현재 검증된 선물 상품이 없습니다.'}</Text> : null}
          </View>
        </ScrollView>
      </InlineBottomSheet>
    </SheetPortal>
  );
}

const styles = StyleSheet.create({
  search: {
    minHeight: 46,
    paddingHorizontal: 12,
    fontSize: 15,
    color: semantic.text,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 10,
    backgroundColor: semantic.input,
  },
  scroll: { flexGrow: 0, flexShrink: 1 },
  list: { gap: 2, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10, paddingHorizontal: 8, borderRadius: 14 },
  rowSelected: { backgroundColor: semantic.raised },
  rowCopy: { flex: 1, minWidth: 0, gap: 2 },
  symbol: { fontSize: 16, lineHeight: 22, fontWeight: '700', color: semantic.text },
  name: { fontSize: 13, lineHeight: 18, color: semantic.secondary },
  check: { flexShrink: 0, fontSize: 20, lineHeight: 24, fontWeight: '700', color: semantic.info },
  empty: { fontSize: 14, lineHeight: 21, color: semantic.secondary, paddingVertical: 12, paddingHorizontal: 8 },
});
