import { useCallback, useEffect, useRef } from 'react';
import { Keyboard, Platform, type ScrollView, type View, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';

type Bounds = { top: number; bottom: number };

// Fit the input and submit together when possible. On short viewports/large
// fonts, keep the input readable; the submit remains reachable by scrolling.
export function getFocusedInputScrollDelta(viewport: Bounds, input: Bounds, submit?: Bounds): number {
  const gap = 12;
  const top = viewport.top + gap;
  const bottom = viewport.bottom - gap;
  const groupBottom = submit && submit.bottom >= input.bottom && submit.bottom - input.top <= bottom - top
    ? submit.bottom : input.bottom;
  if (input.top < top || groupBottom - input.top > bottom - top) return input.top - top;
  if (groupBottom > bottom) return groupBottom - bottom;
  return 0;
}

/**
 * Scrolls `target` into the scroll view's visible area: the same rule as a
 * focused input (`nearest`), or `start` to bring it near the top so a beginner
 * quest guide card has room beside it.
 */
export function revealInScrollView(
  scroll: ScrollView | null,
  offset: number,
  target: Pick<View, 'measureInWindow'>,
  options: { align?: 'nearest' | 'start'; keyboardTop?: number } = {},
) {
  if (!scroll) return;
  scroll.getNativeScrollRef()?.measureInWindow((_x, y, _width, height) => {
    const viewport = { top: y, bottom: Math.min(y + height, options.keyboardTop ?? Infinity) };
    if (viewport.bottom <= viewport.top) return;
    target.measureInWindow((_targetX, targetY, _targetWidth, targetHeight) => {
      const delta = options.align === 'start'
        ? targetY - (viewport.top + 12)
        : getFocusedInputScrollDelta(viewport, { top: targetY, bottom: targetY + targetHeight });
      if (Math.abs(delta) > 1) scroll.scrollTo({ y: Math.max(0, offset + delta), animated: true });
    });
  });
}

/** Measure after keyboard/resize layout, rather than guessing an input offset. */
export function useFocusedInputScroll() {
  const scrollRef = useRef<ScrollView>(null);
  const submitRef = useRef<View>(null);
  const focusedRef = useRef<View | null>(null);
  const offsetRef = useRef(0);
  const keyboardTopRef = useRef(Infinity);
  const frameRef = useRef<number | null>(null);
  const revisionRef = useRef(0);

  const revealFocusedInput = useCallback(() => {
    const revision = ++revisionRef.current;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const scroll = scrollRef.current;
      const input = focusedRef.current;
      if (!scroll || !input) return;
      scroll.getNativeScrollRef()?.measureInWindow((_x, y, _width, height) => {
        const viewport = { top: y, bottom: Math.min(y + height, keyboardTopRef.current) };
        if (viewport.bottom <= viewport.top) return;
        input.measureInWindow((_inputX, inputY, _inputWidth, inputHeight) => {
          const apply = (submit?: Bounds) => {
            if (revision !== revisionRef.current || focusedRef.current !== input) return;
            const delta = getFocusedInputScrollDelta(viewport, { top: inputY, bottom: inputY + inputHeight }, submit);
            if (Math.abs(delta) > 1) scroll.scrollTo({ y: Math.max(0, offsetRef.current + delta), animated: false });
          };
          if (submitRef.current) {
            submitRef.current.measureInWindow((_submitX, submitY, _submitWidth, submitHeight) => apply({ top: submitY, bottom: submitY + submitHeight }));
          } else apply();
        });
      });
    });
  }, []);

  // A control the beginner quest guide points at, above any open keyboard.
  const revealView = useCallback((target: Pick<View, 'measureInWindow'>, align: 'nearest' | 'start' = 'nearest') => {
    revealInScrollView(scrollRef.current, offsetRef.current, target, { align, keyboardTop: keyboardTopRef.current });
  }, []);

  const onInputFocus = useCallback((input: View | null) => {
    focusedRef.current = input;
    revealFocusedInput();
  }, [revealFocusedInput]);
  const onInputBlur = useCallback(() => {
    focusedRef.current = null;
    revisionRef.current += 1;
  }, []);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', event => {
      keyboardTopRef.current = event.endCoordinates.screenY;
      revealFocusedInput();
    });
    const change = Platform.OS === 'ios' ? Keyboard.addListener('keyboardWillChangeFrame', event => {
      keyboardTopRef.current = event.endCoordinates.screenY;
      revealFocusedInput();
    }) : null;
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardTopRef.current = Infinity;
      // Android Back can hide the keyboard without blurring the input. Keep
      // that field so tapping it to reopen still receives focus scrolling.
      revisionRef.current += 1;
    });
    return () => {
      show.remove(); change?.remove(); hide.remove();
      revisionRef.current += 1;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [revealFocusedInput]);

  return { scrollRef, submitRef, onInputFocus, onInputBlur, onScroll, revealFocusedInput, revealView };
}
