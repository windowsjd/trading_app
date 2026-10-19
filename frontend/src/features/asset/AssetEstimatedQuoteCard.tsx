import { financial } from '../../theme/financialColors';
import { semantic } from '../../theme/tokens';
import React, { useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from '../../theme/native';
import { formatKstDateTime } from '../../utils/format';
import { formatOrderBookDecimal } from './orderBook';
import {
  formatEstimatedSize,
  formatEstimatedSpread,
  type AssetEstimatedQuote,
} from './estimatedQuote';

const MISSING = '미제공';

/**
 * Estimated best bid/ask, one level per side. Presentation only: it is a
 * provider's statistical estimate — never an exchange order book, an order
 * price or an executable quantity — so each row stays 매도/매수 추정 and the
 * spread line 추정 스프레드. Without an estimate nothing is drawn (no empty
 * card); a delay or reconnection of a shown estimate is stated with it.
 */
export default function AssetEstimatedQuoteCard({
  estimate,
  statusMessage,
}: {
  estimate: AssetEstimatedQuote | null;
  statusMessage: string | null;
}) {
  const sides = [
    { key: 'ask', label: '매도 추정', side: estimate?.ask, color: styles.ask, row: styles.askRow },
    { key: 'bid', label: '매수 추정', side: estimate?.bid, color: styles.bid, row: styles.bidRow },
  ] as const;
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  if (!estimate) return null;
  const spread = formatEstimatedSpread(estimate.spread);
  const values = sides.map(({ side }) => ({
    price: side?.price != null ? `$${formatOrderBookDecimal(side.price)}` : null,
    size: formatEstimatedSize(side?.size ?? null),
  }));
  // Like the ladder: long exact values in a narrow column scroll sideways
  // instead of being clipped (never rounded away).
  const longest = Math.max(
    8,
    ...values.flatMap(({ price, size }) => [
      (price ?? MISSING).length,
      (size ? `${size}주` : MISSING).length,
    ]),
  );
  const scroll = width > 0 && longest * 7.4 * fontScale + 16 > width;
  return (
    <View
      testID="asset-estimated-quote"
      style={styles.container}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {statusMessage ? (
        <Text
          testID="asset-estimated-quote-status"
          accessibilityLiveRegion="polite"
          style={styles.status}
        >
          {statusMessage}
        </Text>
      ) : null}
      {scroll ? (
        <Text style={styles.hint}>추정 호가 좌우로 밀기 ↔</Text>
      ) : null}
      {sides.map(({ key, label, color, row }, index) => {
        const { price, size } = values[index];
        const content = (
          <View
            testID={`asset-estimated-quote-${key}`}
            accessible
            accessibilityLabel={`${label} 가격 ${price ?? MISSING}, 수량 ${size ? `${size}주` : MISSING}`}
            style={[styles.row, row, scroll && styles.scrollRow]}
          >
            <Text style={styles.sideLabel}>{label}</Text>
            <Text
              style={[styles.number, price ? color : styles.missing]}
              selectable
            >
              {price ?? MISSING}
            </Text>
            <Text
              style={[styles.number, size ? null : styles.missing]}
              selectable
            >
              {size ? `${size}주` : MISSING}
            </Text>
          </View>
        );
        return scroll ? (
          <ScrollView
            key={key}
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            testID={`asset-estimated-quote-${key}-scroll`}
            style={styles.scroll}
          >
            {content}
          </ScrollView>
        ) : (
          <React.Fragment key={key}>{content}</React.Fragment>
        );
      })}
      <Text testID="asset-estimated-quote-meta" style={styles.meta}>
        {`추정 스프레드 ${spread ?? MISSING} · ${formatKstDateTime(estimate.effectiveAt)} 기준`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 4,
    paddingTop: 10,
    borderTopWidth: 1,
    borderColor: semantic.border,
    minWidth: 0,
  },
  status: { fontSize: 11, color: semantic.warning },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: 8,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 6,
  },
  askRow: { backgroundColor: financial.sellSurface },
  bidRow: { backgroundColor: financial.buySurface },
  sideLabel: { fontSize: 11, color: semantic.secondary, minWidth: 52 },
  number: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: semantic.secondary,
    flexShrink: 1,
  },
  ask: { color: financial.sell },
  bid: { color: financial.buy },
  missing: { color: semantic.muted },
  meta: { fontSize: 10, color: semantic.muted },
  hint: { fontSize: 10, color: semantic.muted },
  scroll: { flexGrow: 0, width: '100%' },
  scrollRow: { flexWrap: 'nowrap' },
});
