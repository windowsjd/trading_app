import React from 'react';
import * as Native from 'react-native-web';
// Expo's Web modules read process.env outside Metro's inline-env transform.
globalThis.process ??= { env: { NODE_ENV: 'production', EXPO_OS: 'web' } };
export * from 'react-native-web';
const scale = Number(
  new URLSearchParams(location.search).get('fontScale') ?? 1,
);
export const Text = React.forwardRef((props, ref) => {
  const style = Native.StyleSheet.flatten(props.style) ?? {};
  // Like the device: text that opts out of the system font size keeps its size.
  const factor = props.allowFontScaling === false ? 1 : scale;
  return (
    <Native.Text
      {...props}
      ref={ref}
      style={[
        props.style,
        {
          fontSize: (style.fontSize ?? 14) * factor,
          ...(style.lineHeight ? { lineHeight: style.lineHeight * factor } : {}),
        },
      ]}
    />
  );
});
export const TextInput = React.forwardRef((props, ref) => {
  const style = Native.StyleSheet.flatten(props.style) ?? {};
  return (
    <Native.TextInput
      {...props}
      ref={ref}
      style={[props.style, { fontSize: (style.fontSize ?? 14) * scale }]}
    />
  );
});
// RN Web's Alert is a no-op. `?alertConfirm=1` presses the destructive button
// so a check can follow a confirmed action; otherwise nothing is pressed.
export const Alert = {
  alert: (title, message, buttons = []) => {
    if (new URLSearchParams(location.search).get('alertConfirm') !== '1') return;
    setTimeout(() => buttons.find((button) => button.style === 'destructive')?.onPress?.(), 0);
  },
};
export function useWindowDimensions() {
  return { ...Native.useWindowDimensions(), fontScale: scale };
}
