import React from 'react';
// Required once at the app root by react-native-gesture-handler (the chart's
// pinch / horizontal-pan / long-press gestures). This is the ONLY place it is
// wrapped — nested roots are unnecessary and break gesture delivery.
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { featureFlags } from 'react-native-screens';
import AppProviders from './src/app/AppProviders';
import RootNavigator from './src/app/navigation/RootNavigator';

// Android buttons that show their press but never run (2026-11-11, Home's HOT
// tabs and 자세히 보기). react-native-screens 4.19–4.28 resets every screen's
// shadow state when the window size changes (a rotation: the activity is not
// orientation-locked and the chart follows it). A screen with a native header
// that was not in front then (another tab, under a pushed screen or the
// full-screen chart) never re-sends its state, so Fabric's measure() puts its
// content one header height lower than it is drawn. Pressability keeps a press
// only while the finger stays inside that measured box: the first finger jitter
// leaves it, and the release calls no onPress until the screen remounts
// (upstream issues #4551, #4289; fixed in 4.29 by #4760). Without the reset a
// rotation only lays the visible screen out a moment late (#2933), as before
// 4.19. Set before any screen renders.
featureFlags.experiment.androidResetScreenShadowStateOnOrientationChangeEnabled = false;

const rootStyle = { flex: 1 } as const;

export default function App() {
  return (
    <GestureHandlerRootView style={rootStyle}>
      <AppProviders>
        <RootNavigator />
      </AppProviders>
    </GestureHandlerRootView>
  );
}
