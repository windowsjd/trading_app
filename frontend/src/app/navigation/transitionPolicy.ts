import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

/** Native push keeps back direction and edge gestures; iOS supports a short duration. */
export function stackTransition(reducedMotion: boolean, platform: string): NativeStackNavigationOptions {
  if (reducedMotion) return { animation: 'none' };
  return platform === 'ios'
    ? { animation: 'simple_push', animationDuration: 210 }
    : { animation: 'ios_from_right' };
}

export function rootTransition(reducedMotion: boolean): NativeStackNavigationOptions {
  return reducedMotion ? { animation: 'none' } : { animation: 'fade', animationDuration: 170 };
}
