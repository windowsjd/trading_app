import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';

export type Quote = { price: number; quantity: number };

type LessonFrame = {
  asks: Quote[];
  lastPrice: number;
  previousPrice?: number;
  targetPrice?: number;
  filledQuantity?: number;
  status: string;
  delay?: number;
};

const initialAsks: Quote[] = [
  { price: 10030, quantity: 8 },
  { price: 10020, quantity: 5 },
  { price: 10010, quantity: 3 },
];
const afterFirst = initialAsks.slice(0, 2);
const afterSecond = [{ price: 10030, quantity: 5 }];

export const LESSON_BIDS: Quote[] = [
  { price: 9990, quantity: 4 },
  { price: 9980, quantity: 7 },
  { price: 9970, quantity: 10 },
];

// Fixed teaching frames, not a matching engine. Zero remains visible briefly
// before removal so the learner can follow which resting order was consumed.
const frames: LessonFrame[] = [
  { asks: initialAsks, lastPrice: 10000, status: '매수 요청 전입니다. 최우선 매도호가는 10,010원, 잔량은 3주입니다.' },
  { asks: initialAsks, lastPrice: 10000, targetPrice: 10010, status: '체결 대상: 10,010원에 대기 중인 매도 3주입니다.', delay: 1000 },
  {
    asks: [...afterFirst, { price: 10010, quantity: 0 }],
    lastPrice: 10010, previousPrice: 10000, targetPrice: 10010, filledQuantity: 3,
    status: '10,010원에서 3주 체결. 잔량이 3주에서 0주가 되고, 최근 체결가는 10,010원으로 변경됩니다.', delay: 1300,
  },
  {
    asks: afterFirst, lastPrice: 10010, previousPrice: 10000,
    status: '3주 매수 완료. 10,010원 매도호가가 소진되어 사라졌습니다. 새로운 최우선 매도호가는 10,020원, 잔량은 5주입니다.',
  },
  { asks: afterFirst, lastPrice: 10010, targetPrice: 10020, status: '8주 중 먼저 체결할 대상: 10,020원에 대기 중인 매도 5주입니다.', delay: 1000 },
  {
    asks: [initialAsks[0], { price: 10020, quantity: 0 }],
    lastPrice: 10020, previousPrice: 10010, targetPrice: 10020, filledQuantity: 5,
    status: '10,020원에서 5주 체결. 해당 잔량은 0주입니다. 최근 체결가는 10,020원이며, 매수 요청 중 3주가 남았습니다.', delay: 1300,
  },
  {
    asks: [initialAsks[0]], lastPrice: 10020, targetPrice: 10030,
    status: '10,020원 매도호가가 소진되어 사라졌습니다. 남은 매수 3주는 다음 매도호가인 10,030원에서 체결됩니다.', delay: 1200,
  },
  {
    asks: afterSecond, lastPrice: 10030, previousPrice: 10020, targetPrice: 10030, filledQuantity: 3,
    status: '10,030원에서 나머지 3주 체결. 해당 잔량은 8주에서 5주가 되고, 최근 체결가는 10,030원으로 변경됩니다.', delay: 1300,
  },
  {
    asks: afterSecond, lastPrice: 10030, previousPrice: 10010,
    status: '8주 매수 완료. 10,020원에서 5주, 10,030원에서 3주가 순서대로 체결되었습니다. 최근 체결가는 10,030원입니다.',
  },
];

export function useOrderBookLesson() {
  const [frameIndex, setFrameIndex] = useState(0);
  const currentIndex = useRef(0);
  const frame = frames[frameIndex];

  const moveTo = useCallback((index: number) => {
    currentIndex.current = index;
    setFrameIndex(index);
  }, []);

  // A blurred screen pauses the sequence; leaving the screen cancels the timer.
  useFocusEffect(useCallback(() => {
    if (frame.delay === undefined) return;
    const timer = setTimeout(() => moveTo(frameIndex + 1), frame.delay);
    return () => clearTimeout(timer);
  }, [frame.delay, frameIndex, moveTo]));

  return {
    frame,
    running: frame.delay !== undefined,
    firstComplete: frameIndex >= 3,
    complete: frameIndex === 8,
    buyThree: () => {
      // Guard synchronous repeated presses before React commits disabled state.
      if (currentIndex.current !== 0) return;
      moveTo(1);
    },
    buyEight: () => {
      if (currentIndex.current !== 3) return;
      moveTo(4);
    },
    restart: () => moveTo(0),
  };
}
