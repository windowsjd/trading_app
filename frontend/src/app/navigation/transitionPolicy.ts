import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import type { BottomTabNavigationOptions } from '@react-navigation/bottom-tabs';

/**
 * Native push/pop owns easing and gestures. Reference video 3: the new screen
 * enters from the right on a strong decelerate (90% in ~170ms, settled ~350ms)
 * while the previous one parallaxes left 30% under a light dim. iOS simple_push
 * is exactly that (overdamped spring, -30%, 0.1 dim), at the measured length.
 * Android's closest native option is ios_from_right (-30% parallax, platform
 * clock, no dim). Back reverses natively on both, gestures included.
 */
export const IOS_PUSH_DURATION = 350;
export function stackTransition(reducedMotion: boolean, platform: string): NativeStackNavigationOptions {
  if (reducedMotion) return { animation: 'none' };
  return platform === 'ios'
    ? { animation: 'simple_push', animationDuration: IOS_PUSH_DURATION }
    : { animation: 'ios_from_right' };
}

/** Web has no native stack motion: a short directional ease-in (see stackScreenLayout). */
export const webPushMotion = {
  duration: 260,
  widthShare: 0.3,
  maxDistance: 120,
  /** Back returns from the left with the 30% parallax share of a push. */
  backShare: 0.3,
  pushOpacity: 0.4,
  backOpacity: 0.7,
} as const;

export function rootTransition(reducedMotion: boolean, platform: string): NativeStackNavigationOptions {
  return reducedMotion ? { animation: 'none' } : { animation: 'fade', ...(platform === 'ios' ? { animationDuration: 190 } : {}) };
}

// Fast onset, smooth settling and no overshoot for peer destinations.
export const tabEaseOut = (progress: number) => 1 - (1 - progress) * (1 - progress);

/** Peer destinations have no horizontal depth; allow a brief settling fade. */
export function tabTransition(reducedMotion: boolean): BottomTabNavigationOptions {
  return {
    animation: reducedMotion ? 'none' : 'fade',
    transitionSpec: { animation: 'timing', config: { duration: reducedMotion ? 0 : 190, easing: tabEaseOut } },
  };
}

/** Secondary visualization retains the native modal/back contract. */
export function chartTransition(reducedMotion: boolean, platform: string): NativeStackNavigationOptions {
  return { ...rootTransition(reducedMotion, platform), presentation: 'fullScreenModal' };
}
