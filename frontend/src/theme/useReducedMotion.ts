import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/** Shared OS setting for navigation and touch animations. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
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
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReduced(value); });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { active = false; subscription.remove(); };
  }, []);
  return reduced;
}
