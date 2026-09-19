import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { formatKstDateTime } from '../../utils/format';
import { formatOrderBookDecimal, normalizeOrderBook, type AssetOrderBook } from './orderBook';

interface Props {
  book: AssetOrderBook;
  isPreview?: boolean;
}

/** Read-only display. No quote selection or coupling to order/valuation state. */
export default function AssetOrderBookCard({ book, isPreview = false }: Props) {
  const snapshot = useMemo(() => normalizeOrderBook(book), [book]);
  const { fontScale } = useWindowDimensions();
  const [availableWidth, setAvailableWidth] = useState(0);
  const levels = [...snapshot.asks, ...snapshot.bids];
  // Leave room for every digit, even at large accessibility font sizes. Only
  // the table scrolls horizontally when it cannot fit; the page stays vertical.
  const priceWidth = Math.max(9, ...levels.map((level) => formatOrderBookDecimal(level.price).length)) * 9 * fontScale + 24;
  const quantityWidth = Math.max(9,
    `잔량 (${snapshot.quantityUnit})`.length,
    ...levels.map((level) => formatOrderBookDecimal(level.quantity).length),
    ...[snapshot.totalAskQuantity, snapshot.totalBidQuantity]
      .map((value) => value == null ? 0 : formatOrderBookDecimal(value).length),
  ) * 9 * fontScale + 24;
  const tableWidth = Math.max(availableWidth, priceWidth + quantityWidth);
  const effectiveTime = snapshot.effectiveAt ?? snapshot.capturedAt;

  return (
    <View testID="asset-order-book" style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>호가 · 매도 / 매수</Text>
      {snapshot.marketLabel ? <Text style={styles.helper}>{snapshot.marketLabel}</Text> : null}
      {isPreview ? (
        <Text testID="asset-order-book-preview-notice" style={styles.preview}>
          개발용 예시 · 실제 시세가 아닙니다.
        </Text>
      ) : null}
      <Text style={styles.helper}>가격 ({snapshot.priceUnit}) · 잔량 ({snapshot.quantityUnit})</Text>
      <Text style={styles.helper}>
        {snapshot.effectiveAt ? '기준' : '수집'} {formatKstDateTime(effectiveTime)} (한국시간)
      </Text>
      {availableWidth > 0 && tableWidth > availableWidth ? (
        <Text style={styles.helper}>좌우로 밀어 가격과 잔량 전체를 확인하세요.</Text>
      ) : null}
      <View onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}>
        <ScrollView horizontal testID="asset-order-book-scroll" showsHorizontalScrollIndicator>
          <View style={{ width: tableWidth }}>
            {(['asks', 'bids'] as const).map((side) => {
              const isAsk = side === 'asks';
              const label = isAsk ? '매도' : '매수';
              const entries = isAsk ? [...snapshot.asks].reverse() : snapshot.bids;
              const total = isAsk ? snapshot.totalAskQuantity : snapshot.totalBidQuantity;
              return (
                <View key={side} testID={`asset-order-book-${side}`} style={styles.side}>
                  <View style={styles.heading}>
                    <Text accessibilityRole="header" style={[styles.sideTitle, isAsk ? styles.askText : styles.bidText]}>
                      {label}호가 · {entries.length}단계
                    </Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={[styles.columnLabel, { width: priceWidth }]}>{label} 가격</Text>
                    <Text style={[styles.columnLabel, styles.quantity, { minWidth: quantityWidth }]}>잔량 ({snapshot.quantityUnit})</Text>
                  </View>
                  {entries.length === 0 ? <Text style={styles.helper}>{label}호가가 없습니다.</Text> : null}
                  {entries.map((level, index) => {
                    const rank = isAsk ? entries.length - index : index + 1;
                    return (
                      <View
                        key={rank}
                        testID={`asset-order-book-${side}-${rank}`}
                        accessible
                        accessibilityLabel={`${label} ${rank}호가, 가격 ${formatOrderBookDecimal(level.price)} ${snapshot.priceUnit}, 잔량 ${formatOrderBookDecimal(level.quantity)} ${snapshot.quantityUnit}`}
                        style={[styles.row, isAsk ? styles.askRow : styles.bidRow, rank === 1 && styles.bestRow]}
                      >
                        <Text style={[styles.number, { width: priceWidth }, isAsk ? styles.askText : styles.bidText]}>{formatOrderBookDecimal(level.price)}</Text>
                        <Text style={[styles.number, styles.quantity, { minWidth: quantityWidth }]}>{formatOrderBookDecimal(level.quantity)}</Text>
                      </View>
                    );
                  })}
                  {total != null ? (
                    <View testID={`asset-order-book-${side}-total`} style={styles.row}>
                      <Text style={[styles.columnLabel, { width: priceWidth }]}>총 {label}잔량</Text>
                      <Text style={[styles.number, styles.quantity, { minWidth: quantityWidth }]}>{formatOrderBookDecimal(total)}</Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: '#e8e8e8', borderRadius: 14, padding: 16, backgroundColor: '#fafafa', gap: 8 },
  title: { fontSize: 16, lineHeight: 24, fontWeight: '700', color: '#111' },
  preview: { fontSize: 13, lineHeight: 20, color: '#725400', backgroundColor: '#FFF8E1', padding: 8, borderRadius: 8 },
  helper: { fontSize: 12, lineHeight: 19, color: '#666' },
  side: { gap: 2, marginTop: 8 },
  heading: { paddingVertical: 4 },
  sideTitle: { fontSize: 14, lineHeight: 22, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 34 },
  columnLabel: { fontSize: 12, lineHeight: 20, color: '#666', padding: 8, textAlign: 'right', flexShrink: 0 },
  number: { fontSize: 14, lineHeight: 22, fontVariant: ['tabular-nums'], color: '#333', textAlign: 'right', paddingHorizontal: 12, paddingVertical: 6, flexShrink: 0 },
  quantity: { flex: 1 },
  askText: { color: '#315f9b' },
  bidText: { color: '#a13e3b' },
  askRow: { backgroundColor: '#f1f5fc' },
  bidRow: { backgroundColor: '#fcf3f2' },
  bestRow: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#bac5ce' },
});
