import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  formatOrderBookDecimal,
  normalizeOrderBook,
  type AssetOrderBook,
} from './orderBook';

/** Presentation only: depth never supplies the current price or an order input. */
export default function AssetOrderLadder({
  book,
  statusMessage,
  currentPrice,
}: {
  book: AssetOrderBook | null;
  statusMessage: string | null;
  currentPrice: React.ReactNode;
}) {
  const snapshot = useMemo(
    () => (book ? normalizeOrderBook(book) : null),
    [book],
  );
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const levels = [...(snapshot?.asks ?? []), ...(snapshot?.bids ?? [])];
  const priceWidth =
    Math.max(
      8,
      ...levels.map((row) => formatOrderBookDecimal(row.price).length),
    ) *
      6.6 *
      fontScale +
    8;
  const quantityWidth =
    Math.max(
      7,
      ...levels.map((row) => formatOrderBookDecimal(row.quantity).length),
    ) *
      6.6 *
      fontScale +
    8;
  const tableWidth = Math.max(width, priceWidth + quantityWidth);
  return (
    <View
      testID="asset-order-book"
      style={styles.container}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {statusMessage ? (
        <Text
          testID="asset-order-book-status"
          accessibilityLiveRegion="polite"
          style={styles.status}
        >
          {statusMessage}
        </Text>
      ) : null}
      {width > 0 && tableWidth > width ? (
        <Text style={styles.hint}>호가 좌우로 밀기 ↔</Text>
      ) : null}
      {(['asks', 'bids'] as const).map((side) => {
        const ask = side === 'asks';
        const entries = ask
          ? [...(snapshot?.asks ?? [])].reverse()
          : (snapshot?.bids ?? []);
        return (
          <React.Fragment key={side}>
            {!ask ? currentPrice : null}
            {snapshot ? (
              <ScrollView
                horizontal
                nestedScrollEnabled
                showsHorizontalScrollIndicator
                testID={`asset-order-book-${side}-scroll`}
                style={styles.scroll}
              >
                <View
                  style={{ width: tableWidth }}
                  testID={`asset-order-book-${side}`}
                >
                  {ask ? (
                    <View style={styles.row}>
                      <Text style={[styles.column, { width: priceWidth }]}>
                        가격 ({snapshot.priceUnit})
                      </Text>
                      <Text
                        style={[
                          styles.column,
                          { flex: 1, minWidth: quantityWidth },
                        ]}
                      >
                        수량 ({snapshot.quantityUnit})
                      </Text>
                    </View>
                  ) : null}
                  {entries.map((level, index) => {
                    const rank = ask ? entries.length - index : index + 1;
                    const price = formatOrderBookDecimal(level.price);
                    const quantity = formatOrderBookDecimal(level.quantity);
                    return (
                      <View
                        key={rank}
                        testID={`asset-order-book-${side}-${rank}`}
                        accessible
                        accessibilityLabel={`${ask ? '매도' : '매수'} ${rank}호가, 가격 ${price} ${snapshot.priceUnit}, 수량 ${quantity} ${snapshot.quantityUnit}`}
                        style={[
                          styles.row,
                          ask ? styles.askRow : styles.bidRow,
                        ]}
                      >
                        <Text
                          style={[
                            styles.number,
                            { width: priceWidth },
                            ask ? styles.ask : styles.bid,
                          ]}
                        >
                          {price}
                        </Text>
                        <Text
                          style={[
                            styles.number,
                            { flex: 1, minWidth: quantityWidth },
                          ]}
                        >
                          {quantity}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </ScrollView>
            ) : null}
          </React.Fragment>
        );
      })}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { minWidth: 0, overflow: 'hidden', gap: 4 },
  scroll: { flexGrow: 0, width: '100%' },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 23 },
  column: {
    fontSize: 10,
    color: '#7c8793',
    textAlign: 'right',
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  number: {
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    color: '#536170',
    textAlign: 'right',
    paddingHorizontal: 4,
    paddingVertical: 3,
    flexShrink: 0,
  },
  ask: { color: '#315f9b' },
  bid: { color: '#a13e3b' },
  askRow: { backgroundColor: '#f3f6fb' },
  bidRow: { backgroundColor: '#fcf4f3' },
  status: { fontSize: 11, color: '#8b641e' },
  hint: { fontSize: 10, color: '#7c8793' },
});
