import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { buildWsUrl } from '../../constants/env';
import ActionPressable from '../../components/common/ActionPressable';
import AssetOrderLadder from '../../features/asset/AssetOrderLadder';
import { useFuturesOrderBook } from '../../features/futures/useFuturesOrderBook';

/**
 * The contract's own Binance USDⓈ-M ten-level book, in the Spot ladder.
 * Display only: virtual fills never use these quantities, and the middle
 * row is the Futures Last price this app executes against. Collapsing it
 * releases the subscription. Keyed by instrument by the caller.
 */
export default function FuturesOrderBookCard({ instrumentId, lastPrice, active }: {
  instrumentId: string;
  lastPrice: string;
  active: boolean;
}) {
  const wsUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);
  const [open, setOpen] = useState(true);
  const { latestOrderBook, statusMessage } = useFuturesOrderBook({
    instrumentId,
    wsUrl: wsUrl ?? '',
    enabled: active && open && !!wsUrl,
  });
  return (
    <View style={styles.card} testID="futures-order-book-card">
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.heading}>호가</Text>
        <ActionPressable
          testID="futures-order-book-toggle"
          accessibilityRole="button"
          accessibilityLabel={open ? '호가 접기' : '호가 펼치기'}
          accessibilityState={{ expanded: open }}
          aria-expanded={open}
          style={styles.toggle}
          onPress={() => setOpen((value) => !value)}
        >
          <Text style={styles.toggleText}>{open ? '접기' : '펼치기'}</Text>
        </ActionPressable>
      </View>
      {open ? (
        <>
          <AssetOrderLadder
            book={latestOrderBook?.assetId === instrumentId ? latestOrderBook : null}
            statusMessage={statusMessage}
            currentPrice={
              <View style={styles.current} testID="futures-order-book-last">
                <Text style={styles.label}>현재가 · 선물 Last</Text>
                <Text selectable style={styles.price}>{lastPrice}</Text>
              </View>
            }
          />
          <Text style={styles.note}>
            바이낸스 USDⓈ-M 실제 호가입니다. 가상 주문 체결은 이 잔량과 무관하며
            선물 Last 가격을 기준으로 합니다.
          </Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, borderRadius: 12, backgroundColor: semantic.surface, gap: 10, minWidth: 0 },
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 4 },
  heading: { fontSize: 16, fontWeight: '700', lineHeight: 24, color: semantic.text, flexShrink: 1 },
  toggle: { minHeight: 44, minWidth: 44, paddingHorizontal: 10, borderRadius: 8, backgroundColor: semantic.raised, alignItems: 'center', justifyContent: 'center' },
  toggleText: { fontSize: 13, fontWeight: '600', color: semantic.secondary },
  current: { paddingVertical: 14, gap: 4, minWidth: 0 },
  label: { fontSize: 11, color: semantic.muted },
  price: { fontSize: 19, fontWeight: '700', fontVariant: ['tabular-nums'], color: semantic.text },
  note: { fontSize: 12, lineHeight: 18, color: semantic.secondary },
});
