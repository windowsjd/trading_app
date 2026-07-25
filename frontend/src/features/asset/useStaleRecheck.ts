import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { STALE_RECHECK_INTERVAL_MS } from './assetTickerPolicy';

/**
 * Drives the "a ticker goes stale because time passed" re-check for a screen.
 *
 * The timer runs ONLY while the screen actually holds a realtime ticker AND
 * the app is in the foreground — a backgrounded app must not keep waking up
 * for a display-only recheck. Returning to the foreground re-checks once
 * immediately so the screen never shows a stale price as fresh.
 */
export function useStaleRecheck(
  enabled: boolean,
  onRecheck: () => void,
  intervalMs: number = STALE_RECHECK_INTERVAL_MS,
): void {
  const onRecheckRef = useRef(onRecheck);
  onRecheckRef.current = onRecheck;

  useEffect(() => {
    if (!enabled) return undefined;

    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (timer) return;
      timer = setInterval(() => onRecheckRef.current(), intervalMs);
      // Node (tests) would otherwise keep the process alive; RN timers have no
      // unref, hence the optional call.
      (timer as { unref?: () => void }).unref?.();
    };

    if (AppState.currentState !== 'background') start();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        onRecheckRef.current();
        start();
      } else if (state === 'background') {
        stop();
      }
    });

    return () => {
      stop();
      subscription.remove();
    };
  }, [enabled, intervalMs]);
}
