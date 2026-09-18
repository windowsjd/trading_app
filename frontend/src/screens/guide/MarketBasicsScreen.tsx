import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  ['호가창 (Order Book)', '아직 체결되지 않고 대기 중인 매수·매도 주문을 가격대별로 확인하는 화면입니다.'],
  ['현재가 (Last Price)', '가장 최근에 거래가 체결된 가격입니다. 이 가이드에서는 현재가를 최근 체결가격 기준으로 표시합니다. 매수·매도호가가 변하더라도 실제 체결이 발생하지 않으면 현재가는 변하지 않을 수 있습니다.'],
  ['매도호가 (Ask)', '시장에 대기 중인 매도 주문의 가격입니다.'],
  ['매수호가 (Bid)', '시장에 대기 중인 매수 주문의 가격입니다.'],
  ['매도잔량 / 매수잔량', '각 가격에 아직 체결되지 않고 대기 중인 매도·매수 주문의 수량입니다.'],
  ['체결 / 체결량 (Trade / Trade Size)', '매수 주문과 매도 주문이 실제 거래로 성사되는 것을 체결이라 하며, 이때 실제로 거래된 수량을 체결량이라고 합니다.'],
];

const takeaways = [
  '호가창에는 가격대별로 대기 중인 매수·매도 주문과 잔량이 표시됩니다.',
  '거래는 매수 주문과 매도 주문이 실제로 체결될 때 발생합니다.',
  '현재가는 가장 최근에 거래가 체결된 가격을 기준으로 표시됩니다.',
  '매수 주문이 더 높은 가격대의 매도호가까지 순차적으로 체결되면 현재가가 상승할 수 있습니다.',
  '평균 매입단가는 체결가격과 수량을 함께 반영합니다. 이번 주문의 평균 체결가와 전체 보유 평단가는 계산에 포함하는 범위가 다릅니다.',
];

const won = (price: number) => `${price.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`;

type LessonValues = Pick<ReturnType<typeof useOrderBookLesson>, 'frame' | 'order' | 'holding'>;
type Exercise = 1 | 2;
type QuoteLayout = { y: number; height: number };
type ExerciseLayout = { y?: number; bookY?: number; quotes: Record<number, QuoteLayout> };

// The existing IDs continue to identify the current lesson values. Completed
// first-exercise views have separate IDs and never announce live changes.
const viewTestId = (id: string, snapshot: boolean) =>
  snapshot ? TEST_IDS.guide.firstSnapshot(id) : id;

function QuoteRow({
  quote, side, best, active = false, filledQuantity, stacked, snapshot = false, onLayout,
}: {
  quote: Quote;
  side: '매도' | '매수';
  best: boolean;
  active?: boolean;
  filledQuantity?: number;
  stacked: boolean;
  snapshot?: boolean;
  onLayout?: (layout: QuoteLayout) => void;
}) {
  const label = `${side}, 가격 ${won(quote.price)}, 잔량 ${quote.quantity}주${best ? `, 최우선 ${side}호가` : ''}${active ? (filledQuantity ? `, ${filledQuantity}주 체결` : ', 체결 대상') : ''}`;

  return (
    <View
      testID={viewTestId(side === '매도' ? TEST_IDS.guide.ask(quote.price) : TEST_IDS.guide.bid(quote.price), snapshot)}
      accessible
      accessibilityLabel={label}
      onLayout={onLayout ? (event) => onLayout(event.nativeEvent.layout) : undefined}
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

function OrderBook({ frame, stacked, snapshot = false, onLayout, onQuoteLayout }: {
  frame: LessonValues['frame'];
  stacked: boolean;
  snapshot?: boolean;
  onLayout?: (y: number) => void;
  onQuoteLayout?: (price: number, layout: QuoteLayout) => void;
}) {
  const bestAsk = frame.asks.filter((quote) => quote.quantity > 0).at(-1)?.price;
  return (
    <View
      testID={viewTestId(TEST_IDS.guide.orderBook, snapshot)}
      style={styles.book}
      onLayout={(event) => onLayout?.(event.nativeEvent.layout.y)}
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
          snapshot={snapshot}
          onLayout={(layout) => onQuoteLayout?.(quote.price, layout)}
        />
      ))}

      <View
        testID={viewTestId(TEST_IDS.guide.lastPrice, snapshot)}
        accessible
        accessibilityLabel={`현재가 ${won(frame.lastPrice)}. 최근 체결가 기준`}
        style={[styles.lastPrice, frame.filledQuantity !== undefined && styles.priceChanged]}
      >
        <Text style={styles.helper}>현재가</Text>
        {frame.previousPrice !== undefined ? (
          <Text style={styles.previousPrice}>{won(frame.previousPrice)} →</Text>
        ) : null}
        <Text style={styles.lastPriceValue}>{won(frame.lastPrice)}</Text>
        <Text style={styles.helper}>최근 체결가 기준</Text>
      </View>

      <Text accessibilityRole="header" style={[styles.sideTitle, styles.bidText]}>매수</Text>
      {!stacked ? (
        <View style={styles.columnHeadings}>
          <Text style={[styles.helper, styles.priceCell]}>가격</Text>
          <Text style={[styles.helper, styles.quantityHeading]}>잔량</Text>
        </View>
      ) : null}
      {LESSON_BIDS.map((quote, index) => (
        <QuoteRow key={quote.price} quote={quote} side="매수" best={index === 0} stacked={stacked} snapshot={snapshot} />
      ))}
      <Text
        testID={viewTestId(TEST_IDS.guide.executionStatus, snapshot)}
        accessibilityLiveRegion={snapshot ? 'none' : 'polite'}
        style={styles.executionStatus}
      >
        {frame.status}
      </Text>
    </View>
  );
}

function PurchaseSummary({ values: { frame, order, holding }, snapshot = false }: {
  values: LessonValues;
  snapshot?: boolean;
}) {
  return (
    <View style={styles.explanation} testID={viewTestId(TEST_IDS.guide.purchaseSummary, snapshot)}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>체결가격과 평균 매입단가</Text>
      <Text style={styles.body}>
        평균 매입단가(평단가)는 매입금액을 매입수량으로 나눈 값입니다.
        각 가격에서 실제로 체결된 수량을 반영하므로, 체결 수량이 많은 가격이 평균에 더 큰 영향을 줍니다.
      </Text>
      <View style={styles.term} testID={viewTestId(TEST_IDS.guide.orderFills, snapshot)}>
        <Text style={[styles.body, styles.bold]}>
          실습 {order.number} · {order.requestedQuantity}주 매수
        </Text>
        <Text style={styles.helper}>이번 주문 체결 수량: {order.quantity}주 / {order.requestedQuantity}주</Text>
        {order.fills.length === 0 ? (
          <Text style={styles.helper}>아직 체결된 수량이 없습니다.</Text>
        ) : order.fills.map((fill) => (
          <Text key={fill.price} style={styles.body}>
            {won(fill.price)} × {fill.quantity}주 = {won(fill.price * fill.quantity)}
          </Text>
        ))}
      </View>
      <View style={styles.term}>
        <Text style={[styles.body, styles.bold]}>현재가</Text>
        <Text style={styles.summaryValue}>{won(frame.lastPrice)}</Text>
        <Text style={styles.helper}>시장에서 가장 최근에 체결된 가격입니다.</Text>
      </View>
      <View
        testID={viewTestId(TEST_IDS.guide.orderAverage, snapshot)}
        style={styles.term}
        accessible
        accessibilityLabel={`이번 주문 평균 체결가 ${order.averagePrice === null ? '체결 전' : won(order.averagePrice)}. 이번 주문 체결 ${order.quantity}주, 체결금액 ${won(order.amount)}. 이번 주문에서 지금까지 체결된 금액을 체결 수량으로 나눈 값입니다.`}
      >
        <Text style={[styles.body, styles.bold]}>이번 주문 평균 체결가</Text>
        <Text style={styles.summaryValue}>{order.averagePrice === null ? '체결 전' : won(order.averagePrice)}</Text>
        <Text style={styles.helper}>이번 주문에서 지금까지 체결된 금액을 체결 수량으로 나눈 값입니다.</Text>
        {order.averagePrice !== null ? (
          <Text style={styles.body}>{won(order.amount)} ÷ {order.quantity}주 = {won(order.averagePrice)}</Text>
        ) : null}
      </View>
      <View
        testID={viewTestId(TEST_IDS.guide.holdingAverage, snapshot)}
        style={styles.section}
        accessible
        accessibilityLabel={`전체 보유 평단가 ${holding.averagePrice === null ? '보유 없음' : won(holding.averagePrice)}. 보유 수량 ${holding.quantity}주, 총 매입금액 ${won(holding.amount)}. 이전 주문과 이번 주문으로 보유한 주식 전체의 매입금액을 보유 수량으로 나눈 값입니다.`}
      >
        <Text style={[styles.body, styles.bold]}>전체 보유 평단가</Text>
        <Text style={styles.summaryValue}>{holding.averagePrice === null ? '보유 없음' : won(holding.averagePrice)}</Text>
        <Text style={styles.helper}>이전 주문과 이번 주문으로 보유한 주식 전체의 매입금액을 보유 수량으로 나눈 값입니다.</Text>
        <Text style={styles.body}>보유 수량 {holding.quantity}주 · 총 매입금액 {won(holding.amount)}</Text>
        {holding.averagePrice !== null ? (
          <Text style={styles.body}>{won(holding.amount)} ÷ {holding.quantity}주 = {won(holding.averagePrice)}</Text>
        ) : null}
      </View>
    </View>
  );
}

export default function MarketBasicsScreen() {
  const lesson = useOrderBookLesson();
  const { frame, running, firstComplete, complete, order, holding } = lesson;
  // A display-only snapshot taken at the second button press. The hook remains
  // the only source of live execution and average-price calculations.
  const [firstSnapshot, setFirstSnapshot] = useState<LessonValues | null>(null);
  const firstValues = firstSnapshot ?? { frame, order, holding };
  const scroll = useRef<ScrollView>(null);
  const layouts = useRef<Record<Exercise, ExerciseLayout>>({ 1: { quotes: {} }, 2: { quotes: {} } });
  const viewport = useRef({ y: 0, height: 0 });
  const activeExercise: Exercise = firstComplete ? 2 : 1;
  const { width, fontScale } = useWindowDimensions();
  const stacked = width / fontScale < 240;

  const revealActiveQuote = useCallback(() => {
    if (frame.targetPrice === undefined) return;
    const section = layouts.current[activeExercise];
    const quote = section.quotes[frame.targetPrice];
    const visible = viewport.current;
    // Wait for this exercise's measurements; never fall back to the first book.
    if (section.y === undefined || section.bookY === undefined || !quote || visible.height <= 0) return;
    const top = section.y + section.bookY + quote.y;
    const bottom = top + quote.height;
    let nextY = visible.y;
    if (top < visible.y) nextY = top;
    else if (bottom > visible.y + visible.height) {
      nextY = quote.height > visible.height ? top : bottom - visible.height;
    }
    // Only reveal the active row, and never cross back into a previous exercise.
    if (nextY !== visible.y) {
      nextY = Math.max(section.y, nextY);
      visible.y = nextY;
      scroll.current?.scrollTo({ y: nextY, animated: false });
    }
  }, [activeExercise, frame.targetPrice]);

  useEffect(revealActiveQuote, [revealActiveQuote]);

  const renderBook = (step: Exercise, values: LessonValues, snapshot = false) => (
    <OrderBook
      frame={values.frame}
      stacked={stacked}
      snapshot={snapshot}
      onLayout={(y) => {
        layouts.current[step].bookY = y;
        if (step === activeExercise) revealActiveQuote();
      }}
      onQuoteLayout={(price, layout) => {
        layouts.current[step].quotes[price] = layout;
        if (step === activeExercise && price === frame.targetPrice) revealActiveQuote();
      }}
    />
  );

  return (
    <SafeAreaView style={styles.container} testID={TEST_IDS.guide.marketBasicsScreen}>
      <ScrollView
        ref={scroll}
        contentContainerStyle={styles.content}
        onLayout={(event) => { viewport.current.height = event.nativeEvent.layout.height; revealActiveQuote(); }}
        onScroll={(event) => {
          viewport.current = { y: event.nativeEvent.contentOffset.y, height: event.nativeEvent.layoutMeasurement.height };
        }}
        scrollEventThrottle={16}
      >
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
          style={styles.section}
          testID={TEST_IDS.guide.exercise(1)}
          onLayout={(event) => {
            layouts.current[1].y = event.nativeEvent.layout.y;
            if (activeExercise === 1) revealActiveQuote();
          }}
        >
          <Text accessibilityRole="header" style={styles.sectionTitle}>실습 1 · 3주 매수</Text>
          <Text style={styles.body}>
            현재 최우선 매도호가에 대기 중인 수량을 확인한 뒤 3주 매수를 실행해보세요.
          </Text>
          {renderBook(1, firstValues, firstComplete)}
          {!firstComplete ? (
            <ActionPressable
              testID={TEST_IDS.guide.buyThree}
              style={[styles.button, running && styles.disabledButton]}
              accessibilityRole="button"
              accessibilityLabel="3주 매수 실행"
              accessibilityState={{ disabled: running, busy: running }}
              disabled={running}
              onPress={lesson.buyThree}
            >
              <Text style={styles.buttonText}>{running ? '체결 과정 진행 중…' : '3주 매수 실행'}</Text>
            </ActionPressable>
          ) : null}
          {firstComplete ? (
            <View style={styles.explanation} testID={TEST_IDS.guide.result(1)}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>실습 1 · 체결 결과</Text>
              <Text style={styles.body}>
                3주의 매수 요청은 10,010원에 대기 중이던 매도 3주와 전량 체결되었습니다.
                해당 가격의 매도잔량이 소진되었고, 가장 최근 체결가격이 10,010원이 되면서 현재가도 10,010원으로 변경됩니다.
              </Text>
              <Text style={styles.body}>
                3주 모두 같은 가격에서 체결되어 매입금액은 30,030원입니다.
                첫 주문의 평균 체결가와 전체 보유 3주의 평단가는 모두 10,010원입니다.
              </Text>
              <Text style={[styles.body, styles.bold]}>
                대기 중인 매도호가가 실제 매수 주문에 의해 순차적으로 체결되면서 거래 가격이 형성됩니다.
              </Text>
            </View>
          ) : null}
          <PurchaseSummary values={firstValues} snapshot={order.number === 2} />
        </View>

        {firstComplete ? (
          <View
            style={styles.section}
            testID={TEST_IDS.guide.exercise(2)}
            onLayout={(event) => { layouts.current[2].y = event.nativeEvent.layout.y; revealActiveQuote(); }}
          >
            <Text accessibilityRole="header" style={styles.sectionTitle}>실습 2 · 여러 가격대 체결</Text>
            <Text style={styles.body}>
              이번에는 최우선 매도호가의 잔량보다 큰 8주 매수를 실행해보세요.
            </Text>
            {renderBook(2, lesson)}
            {!complete ? (
              <ActionPressable
                testID={TEST_IDS.guide.buyEight}
                style={[styles.button, running && styles.disabledButton]}
                accessibilityRole="button"
                accessibilityLabel="8주 매수 실행"
                accessibilityState={{ disabled: running, busy: running }}
                disabled={running}
                onPress={() => {
                  if (running || order.number !== 1) return;
                  setFirstSnapshot({ frame, order, holding });
                  lesson.buyEight();
                }}
              >
                <Text style={styles.buttonText}>{running ? '체결 과정 진행 중…' : '8주 매수 실행'}</Text>
              </ActionPressable>
            ) : null}
            {complete ? (
              <View style={styles.explanation} testID={TEST_IDS.guide.result(2)}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>실습 2 · 체결 결과</Text>
                <Text style={styles.body}>
                  매수 수량이 최우선 매도호가의 잔량보다 많으면 하나의 가격에서 주문 전체가 체결되지 않습니다.
                  남은 수량은 다음 매도호가와 순차적으로 체결됩니다.
                </Text>
                <Text style={styles.body}>
                  8주의 매수 요청 중 5주는 10,020원에서 먼저 체결되고, 남은 3주는 다음 매도호가인 10,030원에서 체결됩니다.
                  마지막 체결가격이 10,030원이므로 현재가 역시 10,030원으로 변경됩니다.
                </Text>
                <Text style={styles.body}>
                  이번 주문은 10,020원 × 5주와 10,030원 × 3주를 합한 {won(order.amount)}을
                  8주로 나누어 평균 체결가 {won(order.averagePrice)}이 됩니다.
                  현재가 {won(frame.lastPrice)}과 달리 8주 모두의 체결가격과 수량을 반영한 결과입니다.
                </Text>
                <Text style={styles.body}>
                  첫 주문의 30,030원과 이번 주문의 {won(order.amount)}을 합하면 총 매입금액은 {won(holding.amount)}입니다.
                  이를 전체 {holding.quantity}주로 나눈 보유 평단가는 {won(holding.averagePrice)}입니다.
                </Text>
                <Text style={[styles.body, styles.bold]}>
                  매수 주문이 더 높은 가격대의 매도호가까지 순차적으로 체결되면 현재가가 상승할 수 있습니다.
                </Text>
              </View>
            ) : null}
            {order.number === 2 ? <PurchaseSummary values={lesson} /> : null}
          </View>
        ) : null}

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
              onPress={() => {
                setFirstSnapshot(null);
                lesson.restart();
                viewport.current.y = 0;
                scroll.current?.scrollTo({ y: 0, animated: false });
              }}
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
  title: { fontSize: 24, lineHeight: 34, fontWeight: '700', color: '#111' },
  sectionTitle: { fontSize: 19, lineHeight: 28, fontWeight: '700', color: '#111' },
  summaryValue: { fontSize: 19, lineHeight: 28, fontWeight: '700', color: '#111', fontVariant: ['tabular-nums'] },
  body: { fontSize: 16, lineHeight: 27, color: '#37474f' },
  helper: { fontSize: 14, lineHeight: 23, color: '#546e7a' },
  bold: { fontWeight: '700' },
  book: { borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 14, padding: 12, gap: 4 },
  bookHeading: { gap: 4, marginBottom: 8 },
  sideTitle: { fontSize: 16, lineHeight: 24, fontWeight: '700', marginVertical: 4 },
  columnHeadings: { flexDirection: 'row', paddingHorizontal: 12, paddingBottom: 4, gap: 12 },
  quoteRow: { padding: 10, borderWidth: 2, borderColor: 'transparent', borderRadius: 8, gap: 4 },
  columns: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stackedColumns: { flexDirection: 'column', alignItems: 'stretch', gap: 4 },
  priceCell: { flex: 3, textAlign: 'right', fontSize: 16, lineHeight: 25, fontWeight: '600', fontVariant: ['tabular-nums'] },
  quantityCell: { flex: 2, alignItems: 'flex-end' },
  quantityHeading: { flex: 2, textAlign: 'right' },
  stackedCell: { flex: 0, textAlign: 'left', alignItems: 'flex-start' },
  quantity: { fontSize: 16, lineHeight: 25, color: '#263238', fontVariant: ['tabular-nums'] },
  previousQuantity: { fontSize: 14, lineHeight: 22, color: '#546e7a', fontVariant: ['tabular-nums'] },
  askRow: { backgroundColor: '#f1f5fc' },
  bidRow: { backgroundColor: '#fcf3f2' },
  askText: { color: '#315f9b' },
  bidText: { color: '#a13e3b' },
  activeRow: { borderColor: '#527b91', backgroundColor: '#e7f0f4' },
  rowNote: { fontSize: 14, lineHeight: 22, color: '#37474f' },
  lastPrice: { alignItems: 'center', padding: 12, gap: 4, marginVertical: 8, borderRadius: 8, backgroundColor: '#fafafa' },
  priceChanged: { backgroundColor: '#e7f0f4' },
  previousPrice: { fontSize: 15, lineHeight: 24, color: '#546e7a', fontVariant: ['tabular-nums'], maxWidth: '100%', textAlign: 'center' },
  lastPriceValue: { fontSize: 26, lineHeight: 38, fontWeight: '700', color: '#111', fontVariant: ['tabular-nums'], maxWidth: '100%', textAlign: 'center' },
  executionStatus: { fontSize: 15, lineHeight: 25, color: '#37474f', marginTop: 12 },
  button: { backgroundColor: '#111', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  disabledButton: { backgroundColor: '#626262' },
  buttonText: { color: '#fff', fontSize: 16, lineHeight: 25, fontWeight: '700', textAlign: 'center', maxWidth: '100%' },
  explanation: { borderWidth: 1, borderColor: '#e8e8e8', borderRadius: 14, padding: 16, backgroundColor: '#fafafa', gap: 12 },
  term: { gap: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#eee' },
});
