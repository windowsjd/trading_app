import React from 'react';
import type { BottomTabBarButtonProps } from '@react-navigation/bottom-tabs';
import { PlatformPressable } from '@react-navigation/elements';
import { useAppearance } from '../../theme/appearance';

/** Keep Navigation's touch target, links, events and accessibility intact. */
export default function TabBarButton({ reducedMotion = false, ...props }: BottomTabBarButtonProps & { reducedMotion?: boolean }) {
  const { colors } = useAppearance();
  return (
    <PlatformPressable
      {...props}
      // Android: a soft ripple confined to this tab. iOS/web: instant dimming.
      pressColor={reducedMotion ? 'transparent' : colors.pressed}
      pressOpacity={reducedMotion ? 1 : 0.82}
      android_ripple={{ ...props.android_ripple, borderless: false, ...(reducedMotion ? { color: 'transparent' } : {}) }}
      // Also hide an in-flight opacity animation when the OS setting changes.
      style={reducedMotion ? [props.style, { opacity: 1 }] : props.style}
    />
  );
}
