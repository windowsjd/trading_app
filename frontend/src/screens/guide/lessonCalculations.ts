// Local teaching fixtures only. These helpers do not submit or match live orders.
export type Quote = { price: number; quantity: number };
export type Fill = Quote;
export type BookFrame = {
  asks: Quote[];
  bids: Quote[];
  lastPrice: number;
  fills: Fill[];
  status: string;
  targetPrice?: number;
  targetSide?: '매도' | '매수';
  filledQuantity?: number;
};
export type TimedFrame<T> = { value: T; delay?: number };
export const won = (value: number) =>
  `${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`;
export const BIDS: Quote[] = [
  { price: 9990, quantity: 4 },
  { price: 9980, quantity: 7 },
];
export const THICK_ASKS: Quote[] = [
  { price: 10030, quantity: 500 },
  { price: 10020, quantity: 400 },
  { price: 10010, quantity: 300 },
];
export const THIN_ASKS: Quote[] = [
  { price: 10030, quantity: 10 },
  { price: 10020, quantity: 8 },
  { price: 10010, quantity: 5 },
];
export const CANCEL_ASKS: Quote[] = [
  { price: 10020, quantity: 5 },
  { price: 10010, quantity: 3 },
];
export const emptyBook = (asks: Quote[], bids = BIDS): BookFrame => ({
  asks,
  bids,
  lastPrice: 10000,
  fills: [],
  status: '체결 전',
});

export function summarize(fills: Fill[]) {
  const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
  const amount = fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
  return { quantity, amount, average: quantity ? amount / quantity : null };
}

// Walk a fixed, finite sell-side fixture. Retain zero for one frame so the
// learner sees depletion before removal. No order types, queues or live state.
export function buyFrames(
  asks: Quote[],
  quantity: number,
  initialPrice = 10000,
): TimedFrame<BookFrame>[] {
  let book: BookFrame = { ...emptyBook(asks), lastPrice: initialPrice };
  const frames: TimedFrame<BookFrame>[] = [{ value: book }];
  let remaining = quantity;
  for (const quote of [...asks].sort((a, b) => a.price - b.price)) {
    if (remaining <= 0) break;
    const filled = Math.min(quote.quantity, remaining);
    frames.push({
      value: {
        ...book,
        targetPrice: quote.price,
        targetSide: '매도',
        status: `${won(quote.price)}의 매도잔량 ${quote.quantity}주 중 ${filled}주를 체결합니다.`,
      },
      delay: 900,
    });
    remaining -= filled;
    book = {
      ...book,
      asks: book.asks.map((row) =>
        row.price === quote.price ? { ...row, quantity: row.quantity - filled } : row,
      ),
      lastPrice: quote.price,
      fills: [...book.fills, { price: quote.price, quantity: filled }],
      status: `${won(quote.price)}에서 ${filled}주 체결. 남은 매수 수량 ${remaining}주. 현재가 ${won(quote.price)}.`,
    };
    frames.push({
      value: { ...book, targetPrice: quote.price, targetSide: '매도', filledQuantity: filled },
      delay: 1100,
    });
    book = { ...book, asks: book.asks.filter((row) => row.quantity > 0) };
  }
  frames.push({
    value: {
      ...book,
      status: remaining
        ? `${summarize(book.fills).quantity}주 체결, 대기 매도잔량 부족으로 ${remaining}주 미체결.`
        : `${quantity}주 매수 완료. 현재가 ${won(book.lastPrice)}.`,
    },
  });
  return frames;
}

export type Ohlc = { open: number; high: number; low: number; close: number };
export const PATH_A = [10000, 10600, 9700, 10400];
export const PATH_B = [10000, 9700, 10600, 10400];
export const FIVE_MINUTE: Ohlc[] = [
  { open: 10000, high: 10300, low: 9900, close: 10200 },
  { open: 10200, high: 10600, low: 10100, close: 10400 },
  { open: 10400, high: 10500, low: 9700, close: 10400 },
];
export function ohlcFromPrices(prices: number[]): Ohlc {
  return {
    open: prices[0],
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: prices[prices.length - 1],
  };
}
export function candleParts(candle: Ohlc) {
  const bottom = Math.min(candle.open, candle.close);
  const top = Math.max(candle.open, candle.close);
  return {
    direction:
      candle.close > candle.open
        ? '양봉'
        : candle.close < candle.open
          ? '음봉'
          : '시가와 종가 동일',
    body: [bottom, top],
    upper: [top, candle.high],
    lower: [candle.low, bottom],
  };
}
export function aggregateCandles(candles: Ohlc[]): Ohlc {
  return {
    open: candles[0].open,
    high: Math.max(...candles.map((c) => c.high)),
    low: Math.min(...candles.map((c) => c.low)),
    close: candles[candles.length - 1].close,
  };
}
