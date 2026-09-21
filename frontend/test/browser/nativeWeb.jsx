import React from 'react';
import * as Native from 'react-native-web';
export * from 'react-native-web';
const scale = Number(
  new URLSearchParams(location.search).get('fontScale') ?? 1,
);
export const Text = React.forwardRef((props, ref) => {
  const style = Native.StyleSheet.flatten(props.style) ?? {};
  return (
    <Native.Text
      {...props}
      ref={ref}
      style={[
        props.style,
        {
          fontSize: (style.fontSize ?? 14) * scale,
          ...(style.lineHeight ? { lineHeight: style.lineHeight * scale } : {}),
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
export function useWindowDimensions() {
  return { ...Native.useWindowDimensions(), fontScale: scale };
}
