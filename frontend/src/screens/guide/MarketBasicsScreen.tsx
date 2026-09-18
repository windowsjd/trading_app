import React, { useEffect, useRef } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import ActionPressable from '../../components/common/ActionPressable';
import { TEST_IDS } from '../../constants/testIds';
import { LESSON_BIDS, useOrderBookLesson, type Quote } from './useOrderBookLesson';

const terms = [
  ['매도호가(Ask)', '현재 시장에 대기 중인 매도 주문의 가격입니다.'],
  ['매수호가(Bid)', '현재 시장에 대기 중인 매수 주문의 가격입니다.'],
  ['잔량', '해당 가격에 아직 체결되지 않고 대기 중인 주문 수량입니다.'],
  ['최우선 매도호가', '현재 대기 중인 매도 주문 가운데 가장 낮은 가격입니다.'],
  ['최우선 매수호가', '현재 대기 중인 매수 주문 가운데 가장 높은 가격입니다.'],
  ['체결(Execution)', '매수 주문과 매도 주문이 실제 거래로 성사되는 것을 의미합니다.'],
  ['최근 체결가', '가장 최근에 거래가 체결된 가격입니다.'],
];

const takeaways = [
  '호가창은 가격대별로 대기 중인 매수·매도 주문과 잔량을 보여줍니다.',
  '거래는 매수와 매도 주문이 실제로 체결될 때 발생합니다.',
  '최근 체결가는 가장 최근에 거래가 성사된 가격입니다.',
  '주문이 여러 가격대의 호가를 순차적으로 체결하면 최근 체결가격도 이동할 수 있습니다.',
];

const won = (price: number) => `${price.toLocaleString('ko-KR')}원`;

function QuoteRow({
  quote, side, best, active = false, filledQuantity, stacked, onLayout,
}: {
  quote: Quote;
  side: '매도' | '매수';
  best: boolean;
  active?: boolean;
  filledQuantity?: number;
  stacked: boolean;
  onLayout?: (y: number) => void;
}) {
  const label = `${side}, 가격 ${won(quote.price)}, 잔량 ${quote.quantity}주${best ? `, 최우선 ${side}호가` : ''}${active ? (filledQuantity ? `, ${filledQuantity}주 체결` : ', 체결 대상') : ''}`;

  return (
    <View
      testID={side === '매도' ? TEST_IDS.guide.ask(quote.price) : TEST_IDS.guide.bid(quote.price)}
      accessible
      accessibilityLabel={label}
      onLayout={onLayout ? (event) => onLayout(event.nativeEvent.layout.y) : undefined}
      style={[styles.quoteRow, side === '매도' ? styles.askRow : styles.bidRow, active && styles.activeRow]}
    >
      <View style={[styles.columns, stacked && styles.stackedColumns]}>
        <Text style={[styles.priceCell, stacked && styles.stackedCell, side === '매도' ? styles.askText : styles.bidText]}>
          {stacked ? '가격 ' : ''}{won(quote.price)}
        </Text>
        <View style={[styles.quantityCell, stacked && styles.stackedCell]}>
          {filledQuantity !== undefined ? (
            <Text style={styles.previousQuantity}>{quote.quantity + filledQuantity}주 →</Text>
          ) : null}
          <Text style={styles.quantity}>{stacked ? '잔량 ' : ''}{quote.quantity}주</Text>
        </View>
      </View>
      {best || active ? (
        <Text style={styles.rowNote}>
          {active ? (filledQuantity ? `${filledQuantity}주 체결` : '체결 대상') : `최우선 ${side}호가`}
          {active && quote.quantity === 0 ? ' · 잔량 소진' : ''}
        </Text>
      ) : null}
    </View>
  );
}

export default function MarketBasicsScreen() {
  const lesson = useOrderBookLesson();
  const { frame, running, firstComplete, complete } = lesson;
  const scroll = useRef<ScrollView>(null);
  const bookY = useRef(0);
  const quoteY = useRef<Record<number, number>>({});
  const { width, fontScale } = useWindowDimensions();
  // Preserve full numbers at large accessibility font sizes on narrow screens.
  const stacked = width / fontScale < 240;
  const bestAsk = frame.asks.filter((quote) => quote.quantity > 0).at(-1)?.price;
  const showBook = () => scroll.current?.scrollTo({ y: bookY.current, animated: false });

  useEffect(() => {
    // With enlarged text the entire book cannot fit in one viewport. Keep the
    // current execution row visible as the second exercise moves to the next ask.
    if (stacked && frame.targetPrice !== undefined) {
      scroll.current?.scrollTo({
        y: bookY.current + (quoteY.current[frame.targetPrice] ?? 0),
        animated: false,
      });
    }
  }, [frame.targetPrice, stacked]);

  return (
    <SafeAreaView style={styles.container} testID={TEST_IDS.guide.marketBasicsScreen}>
      <ScrollView ref={scroll} contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.title}>시장 가격은 어떻게 형성될까요?</Text>
          <Text style={styles.body}>
            시장 가격은 시장 참여자들이 제출한 매수·매도 주문이 서로 매칭되고 체결되는 과정에서 형성됩니다.
            {'\n\n'}이때 각 가격대에 대기 중인 주문의 분포와 실제 체결 흐름을 확인할 수 있는 화면이{' '}
            <Text style={styles.bold}>호가창(Order Book)</Text>입니다.
          </Text>
          <Text style={styles.helper}>
            호가창은 현재 거래소에 제출되어 대기 중인 주문을 보여줍니다.
          </Text>
        </View>

        <View
          testID={TEST_IDS.guide.orderBook}
          style={styles.book}
          onLayout={(event) => { bookY.current = event.nativeEvent.layout.y; }}
        >
          <View style={styles.bookHeading}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>LOT 주식</Text>
            <Text style={styles.helper}>교육용 가상 자산 · 모의 호가</Text>
          </View>

          <Text accessibilityRole="header" style={[styles.sideTitle, styles.askText]}>매도</Text>
          {!stacked ? (
            <View style={styles.columnHeadings}>
              <Text style={[styles.helper, styles.priceCell]}>가격</Text>
              <Text style={[styles.helper, styles.quantityHeading]}>잔량</Text>
            </View>
          ) : null}
          {frame.asks.map((quote) => (
            <QuoteRow
              key={quote.price}
              quote={quote}
              side="매도"
              best={quote.price === bestAsk}
              active={quote.price === frame.targetPrice}
              filledQuantity={quote.price === frame.targetPrice ? frame.filledQuantity : undefined}
              stacked={stacked}
              onLayout={(y) => {
                quoteY.current[quote.price] = y;
                if (stacked && quote.price === frame.targetPrice) {
                  scroll.current?.scrollTo({ y: bookY.current + y, animated: false });
                }
              }}
            />
          ))}

          <View
            testID={TEST_IDS.guide.lastPrice}
            accessible
            accessibilityLabel={`최근 체결가 ${won(frame.lastPrice)}`}
            style={[styles.lastPrice, frame.filledQuantity !== undefined && styles.priceChanged]}
          >
            <Text style={styles.helper}>최근 체결가</Text>
            {frame.previousPrice !== undefined ? (
              <Text style={styles.previousPrice}>{won(frame.previousPrice)} →</Text>
            ) : null}
            <Text style={styles.lastPriceValue}>{won(frame.lastPrice)}</Text>
          </View>

          <Text accessibilityRole="header" style={[styles.sideTitle, styles.bidText]}>매수</Text>
          {!stacked ? (
            <View style={styles.columnHeadings}>
              <Text style={[styles.helper, styles.priceCell]}>가격</Text>
              <Text style={[styles.helper, styles.quantityHeading]}>잔량</Text>
            </View>
          ) : null}
          {LESSON_BIDS.map((quote, index) => (
            <QuoteRow key={quote.price} quote={quote} side="매수" best={index === 0} stacked={stacked} />
          ))}
          <Text
            testID={TEST_IDS.guide.executionStatus}
            accessibilityLiveRegion="polite"
            style={styles.executionStatus}
          >
            {frame.status}
          </Text>
        </View>

        {!complete ? (
          <View style={styles.section}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              {firstComplete ? '실습 2 · 여러 가격대 체결' : '실습 1 · 3주 매수'}
            </Text>
            <Text style={styles.body}>
              {firstComplete
                ? '이번에는 최우선 매도호가의 잔량보다 큰 8주 매수를 실행해보세요.'
                : '현재 최우선 매도호가에 대기 중인 수량을 확인한 뒤 3주 매수를 실행해보세요.'}
            </Text>
            <ActionPressable
              testID={firstComplete ? TEST_IDS.guide.buyEight : TEST_IDS.guide.buyThree}
              style={[styles.button, running && styles.disabledButton]}
              accessibilityRole="button"
              accessibilityLabel={firstComplete ? '8주 매수 실행' : '3주 매수 실행'}
              accessibilityState={{ disabled: running, busy: running }}
              disabled={running}
              onPress={() => {
                showBook();
                if (firstComplete) lesson.buyEight();
                else lesson.buyThree();
              }}
            >
              <Text style={styles.buttonText}>
                {running ? '체결 과정 진행 중…' : firstComplete ? '8주 매수 실행' : '3주 매수 실행'}
              </Text>
            </ActionPressable>
            {!firstComplete ? (
              <Text style={styles.helper}>실습 2는 첫 번째 실습을 완료한 뒤 진행할 수 있습니다.</Text>
            ) : null}
          </View>
        ) : null}

        {firstComplete ? (
          <View style={styles.explanation}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>실습 1 · 체결 결과</Text>
            <Text style={styles.body}>
              3주의 매수 요청은 최우선 매도호가인 10,010원에 대기 중이던 3주와 전량 체결되었습니다.
              이에 따라 10,010원의 매도 잔량이 소진되었고, 최근 체결가는 10,010원으로 변경되었습니다.
            </Text>
            <Text style={[styles.body, styles.bold]}>
              대기 중인 매도호가가 실제 매수 주문에 의해 체결되면서 새로운 거래 가격이 형성됩니다.
            </Text>
          </View>
        ) : null}

        {complete ? (
          <View style={styles.explanation}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>실습 2 · 체결 결과</Text>
            <Text style={styles.body}>
              매수 수량이 최우선 매도호가의 잔량보다 많으면 하나의 가격에서 주문 전체가 체결되지 않습니다.
              남은 수량은 다음 매도호가와 순차적으로 체결됩니다.
            </Text>
            <Text style={styles.body}>
              이번 실습에서는 10,020원의 5주가 먼저 체결된 뒤 남은 3주가 10,030원에서 체결되었습니다.
              마지막 체결가격이 10,030원이므로 최근 체결가 역시 10,030원으로 변경됩니다.
            </Text>
            <Text style={[styles.body, styles.bold]}>
              충분한 매수 주문이 더 높은 가격대의 매도호가까지 체결시키면 시장의 최근 체결가격은 위쪽으로 이동할 수 있습니다.
            </Text>
          </View>
        ) : null}

        <Text style={styles.helper}>
          이 실습에서는 매수 요청이 가장 낮은 매도호가부터 즉시 체결되는 것으로 단순화합니다.
          주문 방식의 차이는 별도 가이드에서 다룹니다.
          {'\n'}실제 계정이나 시장 데이터와 연결되지 않으며, 학습 진행도는 저장하지 않습니다.
        </Text>

        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>호가창 용어</Text>
          {terms.map(([term, definition]) => (
            <View key={term} style={styles.term}>
              <Text style={[styles.body, styles.bold]}>{term}</Text>
              <Text style={styles.body}>{definition}</Text>
            </View>
          ))}
        </View>

        {complete ? (
          <View style={styles.explanation}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>핵심 정리</Text>
            {takeaways.map((takeaway, index) => (
              <Text key={takeaway} style={styles.body}>{index + 1}. {takeaway}</Text>
            ))}
            <ActionPressable
              testID={TEST_IDS.guide.restart}
              style={styles.button}
              accessibilityRole="button"
              accessibilityLabel="처음부터 다시 보기"
              onPress={() => { lesson.restart(); showBook(); }}
            >
              <Text style={styles.buttonText}>처음부터 다시 보기</Text>
            </ActionPressable>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 32, gap: 24 },
  section: { gap: 12 },
  title: { fontSize: 22, lineHeight: 32, fontWeight: '700', color: '#111' },
  sectionTitle: { fontSize: 17, lineHeight: 26, fontWeight: '700', color: '#111' },
  body: { fontSize: 15, lineHeight: 25, color: '#37474f' },
  helper: { fontSize: 13, lineHeight: 21, color: '#546e7a' },
  bold: { fontWeight: '700' },
  book: { borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 14, padding: 12, gap: 4 },
  bookHeading: { gap: 4, marginBottom: 8 },
  sideTitle: { fontSize: 14, lineHeight: 22, fontWeight: '700', marginVertical: 4 },
  columnHeadings: { flexDirection: 'row', paddingHorizontal: 12, paddingBottom: 4, gap: 12 },
  quoteRow: { padding: 10, borderWidth: 2, borderColor: 'transparent', borderRadius: 8, gap: 4 },
  columns: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stackedColumns: { flexDirection: 'column', alignItems: 'stretch', gap: 4 },
  priceCell: { flex: 3, textAlign: 'right', fontSize: 15, lineHeight: 23, fontWeight: '600', fontVariant: ['tabular-nums'] },
  quantityCell: { flex: 2, alignItems: 'flex-end' },
  quantityHeading: { flex: 2, textAlign: 'right' },
  stackedCell: { flex: 0, textAlign: 'left', alignItems: 'flex-start' },
  quantity: { fontSize: 15, lineHeight: 23, color: '#263238', fontVariant: ['tabular-nums'] },
  previousQuantity: { fontSize: 12, lineHeight: 19, color: '#546e7a', fontVariant: ['tabular-nums'] },
  askRow: { backgroundColor: '#f1f5fc' },
  bidRow: { backgroundColor: '#fcf3f2' },
  askText: { color: '#315f9b' },
  bidText: { color: '#a13e3b' },
  activeRow: { borderColor: '#527b91', backgroundColor: '#e7f0f4' },
  rowNote: { fontSize: 12, lineHeight: 19, color: '#37474f' },
  lastPrice: { alignItems: 'center', padding: 12, gap: 4, marginVertical: 8, borderRadius: 8, backgroundColor: '#fafafa' },
  priceChanged: { backgroundColor: '#e7f0f4' },
  previousPrice: { fontSize: 14, lineHeight: 22, color: '#546e7a', fontVariant: ['tabular-nums'] },
  lastPriceValue: { fontSize: 24, lineHeight: 34, fontWeight: '700', color: '#111', fontVariant: ['tabular-nums'] },
  executionStatus: { fontSize: 14, lineHeight: 23, color: '#37474f', marginTop: 12 },
  button: { backgroundColor: '#111', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  disabledButton: { backgroundColor: '#626262' },
  buttonText: { color: '#fff', fontSize: 15, lineHeight: 23, fontWeight: '700', textAlign: 'center' },
  explanation: { borderWidth: 1, borderColor: '#e8e8e8', borderRadius: 14, padding: 16, backgroundColor: '#fafafa', gap: 12 },
  term: { gap: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#eee' },
});
