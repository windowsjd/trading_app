import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import type { TimedFrame } from './lessonCalculations';

// Shared playback for the new lessons; the original order-book hook is intact.
export function useLessonSequence<T>(frames: TimedFrame<T>[]) {
  const [index, setIndex] = useState(0);
  const current = useRef(0);
  const move = useCallback((next: number) => {
    current.current = next;
    setIndex(next);
  }, []);
  const frame = frames[index];
  useFocusEffect(
    useCallback(() => {
      if (frame.delay === undefined) return;
      const timer = setTimeout(() => move(index + 1), frame.delay);
      return () => clearTimeout(timer);
    }, [frame.delay, index, move]),
  );
  return {
    value: frame.value,
    started: index > 0,
    running: frame.delay !== undefined,
    complete: index === frames.length - 1,
    start: () => {
      if (current.current === 0) move(1);
    },
  };
}
