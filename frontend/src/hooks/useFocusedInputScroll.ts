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

  return { scrollRef, submitRef, onInputFocus, onInputBlur, onScroll, revealFocusedInput };
}
