// The existing adapter scales Text, but Navigation's HeaderTitle uses
// Animated.Text. Scale that host too so the audit really measures large titles.
import React from 'react';
import * as Native from 'react-native-web';
export * from './nativeWeb';
const scale = Number(new URLSearchParams(location.search).get('fontScale') ?? 1);
const HeaderText = React.forwardRef(({ style, allowFontScaling, maxFontSizeMultiplier, ...props }, ref) => {
  const flat = Native.StyleSheet.flatten(style) ?? {};
  const multiplier = allowFontScaling === false ? 1 : maxFontSizeMultiplier
    ? Math.min(scale, maxFontSizeMultiplier) : scale;
  return <Native.Text {...props} ref={ref} style={[style, {
    fontSize: (flat.fontSize ?? 14) * multiplier,
    ...(flat.lineHeight ? { lineHeight: flat.lineHeight * multiplier } : {}),
  }]} />;
});
export const Animated = { ...Native.Animated, Text: Native.Animated.createAnimatedComponent(HeaderText) };
