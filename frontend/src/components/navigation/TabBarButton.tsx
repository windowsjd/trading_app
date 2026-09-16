import React from 'react';
import type { BottomTabBarButtonProps } from '@react-navigation/bottom-tabs';
import { PlatformPressable } from '@react-navigation/elements';

/** Keep Navigation's touch target, links, events and accessibility intact. */
export default function TabBarButton(props: BottomTabBarButtonProps) {
  return (
    <PlatformPressable
      {...props}
      // Android: a soft ripple confined to this tab. iOS/web: instant dimming.
      pressColor="rgba(0, 0, 0, 0.12)"
      pressOpacity={0.76}
      android_ripple={{ ...props.android_ripple, borderless: false }}
    />
  );
}
