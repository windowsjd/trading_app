import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import type { BottomTabNavigationOptions } from '@react-navigation/bottom-tabs';

/** Detail hierarchy: native push/pop. Retain existing durations until
 * device comparisons support tuning; Android owns its native animation clock. */
export function stackTransition(reducedMotion: boolean, platform: string): NativeStackNavigationOptions {
  if (reducedMotion) return { animation: 'none' };
  return platform === 'ios'
    ? { animation: 'simple_push', animationDuration: 210 }
    : { animation: 'ios_from_right' };
}

export function rootTransition(reducedMotion: boolean): NativeStackNavigationOptions {
  return reducedMotion ? { animation: 'none' } : { animation: 'fade', animationDuration: 170 };
}

/** Peer destinations have no horizontal depth; keep the existing short fade. */
export function tabTransition(reducedMotion: boolean): BottomTabNavigationOptions {
  return {
    animation: reducedMotion ? 'none' : 'fade',
    transitionSpec: { animation: 'timing', config: { duration: reducedMotion ? 0 : 130 } },
  };
}

/** Secondary visualization retains the native modal/back contract. */
export function chartTransition(reducedMotion: boolean): NativeStackNavigationOptions {
  return { ...rootTransition(reducedMotion), presentation: 'fullScreenModal' };
}
