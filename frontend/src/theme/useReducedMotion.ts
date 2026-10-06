import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/** Shared OS setting for navigation and touch animations. */
export function useReducedMotion() {
  // No motion until the OS preference is known, including read failures.
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined' || !window.matchMedia) return;
      const media = window.matchMedia('(prefers-reduced-motion: reduce)');
      setReduced(media.matches);
      const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    }
    let active = true;
    let changed = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active && !changed) setReduced(value); }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => { changed = true; setReduced(value); });
    return () => { active = false; subscription.remove(); };
  }, []);
  return reduced;
}
