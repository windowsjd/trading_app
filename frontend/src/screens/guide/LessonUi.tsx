import React from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import ActionPressable from '../../components/common/ActionPressable';
import { summarize, won, type BookFrame } from './lessonCalculations';

export const lessonStyles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 40, gap: 24 },
  section: { gap: 14 },
  title: { fontSize: 24, lineHeight: 34, fontWeight: '700', color: '#111' },
  heading: { fontSize: 19, lineHeight: 28, fontWeight: '700', color: '#172b35' },
  body: { fontSize: 16, lineHeight: 26, color: '#37474f', flexShrink: 1 },
  helper: { fontSize: 14, lineHeight: 23, color: '#546e7a', flexShrink: 1 },
  bold: { fontWeight: '700' },
  card: {
    padding: 14,
    borderWidth: 1,
    borderColor: '#dde4e8',
    borderRadius: 14,
    gap: 12,
    backgroundColor: '#fff',
    minWidth: 0,
  },
  result: { padding: 14, borderRadius: 12, backgroundColor: '#f0f6f8', gap: 12 },
  action: {
    maxWidth: '100%',
    flexShrink: 1,
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderRadius: 10,
    backgroundColor: '#245b76',
    borderWidth: 1,
    borderColor: '#245b76',
  },
  actionText: {
    fontSize: 16,
    lineHeight: 26,
    fontWeight: '700',
    textAlign: 'center',
    color: '#fff',
    flexShrink: 1,
  },
  secondary: { backgroundColor: '#fff' },
  secondaryText: { color: '#245b76' },
  disabled: { opacity: 0.6 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  comparison: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  stacked: { flexDirection: 'column', alignItems: 'stretch' },
  column: { flex: 1, minWidth: 0, gap: 12 },
  stackedColumn: { flex: 0 },
  row: {
    padding: 10,
    gap: 4,
    borderRadius: 6,
    backgroundColor: '#f5f7f8',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  ask: { color: '#315f9b' },
  bid: { color: '#a13e3b' },
  active: { borderColor: '#a87920', backgroundColor: '#fff5d9' },
  numbers: { flexDirection: 'row', gap: 12, justifyContent: 'space-between' },
  number: {
    fontSize: 16,
    lineHeight: 26,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
    color: '#263238',
  },
  price: {
    fontSize: 24,
    lineHeight: 36,
    fontWeight: '700',
    color: '#172b35',
    fontVariant: ['tabular-nums'],
  },
});
const s = lessonStyles;
type RevealQuote = (row: View, book: View, isCurrent: () => boolean) => void;
const RevealContext = React.createContext<RevealQuote>(() => {});
export function LessonPage({ children, id }: React.PropsWithChildren<{ id: string }>) {
  const scroll = React.useRef<ScrollView>(null);
  const content = React.useRef<View>(null);
  const viewport = React.useRef({ y: 0, height: 0 });
  const reveal = React.useCallback<RevealQuote>((row, book, isCurrent) => {
    const container = content.current;
    if (!container || viewport.current.height <= 0) return;
    book.measureLayout(container, (_x, bookTop) => {
      row.measureLayout(container, (_rowX, top, _width, height) => {
        if (!isCurrent()) return;
        const visible = viewport.current;
        let next = visible.y;
        if (top < visible.y) next = top;
        else if (top + height > visible.y + visible.height) {
          next = height > visible.height ? top : top + height - visible.height;
        }
        if (next !== visible.y) {
          // Measurements belong to this active book, never a prior exercise.
          visible.y = Math.max(bookTop, next);
          scroll.current?.scrollTo({ y: visible.y, animated: false });
        }
      });
    });
  }, []);
  return (
    <SafeAreaView style={s.page} testID={id}>
      <ScrollView
        ref={scroll}
        onLayout={(event) => {
          viewport.current.height = event.nativeEvent.layout.height;
        }}
        onScroll={(event) => {
          viewport.current = {
            y: event.nativeEvent.contentOffset.y,
            height: event.nativeEvent.layoutMeasurement.height,
          };
        }}
        scrollEventThrottle={16}
      >
        <RevealContext.Provider value={reveal}>
          <View ref={content} style={s.content}>
            {children}
          </View>
        </RevealContext.Provider>
      </ScrollView>
    </SafeAreaView>
  );
}
export function Section({
  title,
  children,
  id,
  introduction = false,
}: React.PropsWithChildren<{ title: string; id?: string; introduction?: boolean }>) {
  return (
    <View style={s.section} testID={id}>
      <Text accessibilityRole="header" style={introduction ? s.title : s.heading}>
        {title}
      </Text>
      {children}
    </View>
  );
}
export function Result({
  title = '실습 결과',
  children,
  id,
}: React.PropsWithChildren<{ title?: string; id?: string }>) {
  return (
    <View style={s.result} testID={id}>
      <Text accessibilityRole="header" style={s.heading}>
        {title}
      </Text>
      {children}
    </View>
  );
}
export function Body({ children }: React.PropsWithChildren) {
  return <Text style={s.body}>{children}</Text>;
}
export function LessonAction({
  label,
  onPress,
  id,
  disabled = false,
  secondary = false,
  selected,
}: {
  label: string;
  onPress: () => void;
  id: string;
  disabled?: boolean;
  secondary?: boolean;
  selected?: boolean;
}) {
  return (
    <ActionPressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={[s.action, secondary && s.secondary, disabled && s.disabled]}
    >
      <Text style={[s.actionText, secondary && s.secondaryText]}>{label}</Text>
    </ActionPressable>
  );
}
export function Comparison({ children }: React.PropsWithChildren) {
  const { width, fontScale } = useWindowDimensions();
  const stacked = width < 720 || fontScale > 1.3;
  return (
    <View style={[s.comparison, stacked && s.stacked]}>
      {React.Children.map(children, (child) => (
        <View style={[s.column, stacked && s.stackedColumn]}>{child}</View>
      ))}
    </View>
  );
}
export function SimulationBook({
  frame,
  id,
  title = 'LOT 주식',
  ownBid,
  follow = true,
}: {
  frame: BookFrame;
  id: string;
  title?: string;
  ownBid?: number;
  follow?: boolean;
}) {
  const book = React.useRef<View>(null);
  const target = React.useRef<View>(null);
  const reveal = React.useContext(RevealContext);
  const revealTarget = React.useCallback(() => {
    const row = target.current;
    if (follow && row && book.current) reveal(row, book.current, () => target.current === row);
  }, [follow, reveal]);
  React.useEffect(revealTarget, [revealTarget, frame.targetPrice, frame.filledQuantity]);
  const { width, fontScale } = useWindowDimensions();
  const stacked = width < 360 || fontScale > 1.3;
  const rows = (side: '매도' | '매수') =>
    (side === '매도' ? frame.asks : frame.bids).map((row) => {
      const active = row.price === frame.targetPrice && side === frame.targetSide;
      const own = side === '매수' && row.price === ownBid;
      const fill = active ? frame.filledQuantity : undefined;
      return (
        <View
          key={row.price}
          ref={active && follow ? target : undefined}
          onLayout={active && follow ? revealTarget : undefined}
          testID={`${id}-${side === '매도' ? 'ask' : 'bid'}-${row.price}`}
          accessible
          accessibilityLabel={`${side}, 가격 ${won(row.price)}, 잔량 ${row.quantity}주${own ? ', 내 지정가 주문' : ''}${active ? `, ${fill ? `${fill}주 체결` : '체결 대상'}` : ''}`}
          style={[s.row, active && s.active]}
        >
          <View style={[s.numbers, stacked && s.stacked]}>
            <Text style={[s.number, side === '매도' ? s.ask : s.bid]}>가격 {won(row.price)}</Text>
            <Text style={s.number}>
              잔량 {fill !== undefined ? `${row.quantity + fill} → ` : ''}
              {row.quantity}주
            </Text>
          </View>
          {active ? (
            <Text style={s.helper}>
              {fill ? `${fill}주 체결${row.quantity === 0 ? ' · 잔량 소진' : ''}` : '체결 대상'}
            </Text>
          ) : null}
          {own ? <Text style={s.helper}>내 지정가 매수 주문</Text> : null}
        </View>
      );
    });
  return (
    <View ref={book} style={s.card} testID={id}>
      <Text accessibilityRole="header" style={s.heading}>
        {title}
      </Text>
      <Text style={[s.body, s.bold, s.ask]}>매도</Text>
      {rows('매도')}
      <View
        style={s.result}
        testID={`${id}-price`}
        accessible
        accessibilityLabel={`현재가 ${won(frame.lastPrice)}. 최근 체결가 기준`}
      >
        <Text style={s.helper}>현재가</Text>
        <Text style={s.price}>{won(frame.lastPrice)}</Text>
        <Text style={s.helper}>최근 체결가 기준</Text>
      </View>
      <Text style={[s.body, s.bold, s.bid]}>매수</Text>
      {rows('매수')}
      <Text testID={`${id}-status`} accessibilityLiveRegion="polite" style={s.body}>
        {frame.status}
      </Text>
    </View>
  );
}
export function TradeValues({
  frame,
  initialAsks,
  id,
}: {
  frame: BookFrame;
  initialAsks?: BookFrame['asks'];
  id: string;
}) {
  const values = summarize(frame.fills);
  const depleted = (initialAsks ?? []).filter(
    (quote) => !frame.asks.some((row) => row.price === quote.price && row.quantity > 0),
  );
  return (
    <View style={s.section} testID={id}>
      <Text style={[s.body, s.bold]}>체결 내역</Text>
      {frame.fills.map((fill, i) => (
        <Text key={i} style={s.body}>
          {won(fill.price)} × {fill.quantity}주 = {won(fill.price * fill.quantity)}
        </Text>
      ))}
      <Text style={s.body}>
        체결 수량 {values.quantity}주 · 체결금액 {won(values.amount)}
      </Text>
      <Text testID={`${id}-average`} style={s.body}>
        평균 체결가 {values.average === null ? '체결 전' : won(values.average)}
      </Text>
      {values.average !== null ? (
        <Text style={s.helper}>
          {won(values.amount)} ÷ {values.quantity}주 = {won(values.average)}
        </Text>
      ) : null}
      <Text style={s.body}>현재가 {won(frame.lastPrice)} · 마지막 체결가격 기준</Text>
      {initialAsks ? (
        <Text style={s.helper}>
          소진된 매도호가:{' '}
          {depleted.length ? depleted.map((row) => won(row.price)).join(', ') : '없음'}
        </Text>
      ) : null}
    </View>
  );
}
export function Takeaways({ items }: { items: string[] }) {
  return (
    <Section title="핵심 정리" id="lesson-takeaways">
      {items.map((item, i) => (
        <Body key={item}>
          {i + 1}. {item}
        </Body>
      ))}
    </Section>
  );
}
