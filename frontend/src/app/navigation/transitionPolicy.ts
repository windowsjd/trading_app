import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import type { BottomTabNavigationOptions } from '@react-navigation/bottom-tabs';

/** Native push/pop owns easing and gestures. Android owns its animation clock. */
export function stackTransition(reducedMotion: boolean, platform: string): NativeStackNavigationOptions {
  if (reducedMotion) return { animation: 'none' };
  return platform === 'ios'
    ? { animation: 'simple_push', animationDuration: 230 }
    : { animation: 'ios_from_right' };
}

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
