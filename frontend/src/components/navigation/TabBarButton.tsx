import React from 'react';
import type { BottomTabBarButtonProps } from '@react-navigation/bottom-tabs';
import { PlatformPressable } from '@react-navigation/elements';
import { useAppearance } from '../../theme/appearance';

/** Keep Navigation's touch target, links, events and accessibility intact. */
export default function TabBarButton(props: BottomTabBarButtonProps) {
  const { colors } = useAppearance();
  return (
    <PlatformPressable
      {...props}
      // Android: a soft ripple confined to this tab. iOS/web: instant dimming.
      pressColor={colors.pressed}
      pressOpacity={0.82}
      android_ripple={{ ...props.android_ripple, borderless: false }}
    />
  );
}
