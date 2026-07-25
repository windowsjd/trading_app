import React from 'react';
// Required once at the app root by react-native-gesture-handler (the chart's
// pinch / horizontal-pan / long-press gestures). This is the ONLY place it is
// wrapped — nested roots are unnecessary and break gesture delivery.
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AppProviders from './src/app/AppProviders';
import RootNavigator from './src/app/navigation/RootNavigator';

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
