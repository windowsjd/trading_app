import type { PressableProps, PressableStateCallbackType } from 'react-native';

const pressedStyle = { opacity: 0.76 };

/** Visual feedback only: Pressable still owns events, cancellation and timing. */
export function withPressedFeedback(
  style: PressableProps['style'],
  disabled = false,
) {
  return (state: PressableStateCallbackType) => {
    const baseStyle = typeof style === 'function' ? style(state) : style;
    return state.pressed && !disabled ? [baseStyle, pressedStyle] : baseStyle;
  };
}
