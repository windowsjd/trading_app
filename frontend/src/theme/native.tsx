import React from 'react';
import * as RN from 'react-native';
import { useAppearance } from './appearance';
import { themeStyle } from './colorStyles';

export * from 'react-native';
export type View = RN.View;
export type ScrollView = RN.ScrollView;
export type Text = RN.Text;
export type TextInput = RN.TextInput;

const ThemedView = React.forwardRef<RN.View, RN.ViewProps>((props, ref) => {
  const { mode } = useAppearance();
  return <RN.View {...props} ref={ref} style={themeStyle(props.style, mode)} />;
});
const ThemedText = React.forwardRef<RN.Text, RN.TextProps>((props, ref) => {
  const { mode, colors } = useAppearance();
  return <RN.Text {...props} ref={ref} style={mode === 'dark' ? [{ color: colors.text }, themeStyle(props.style, mode)] : props.style} />;
});
const ThemedScrollView = React.forwardRef<RN.ScrollView, RN.ScrollViewProps>((props, ref) => {
  const { mode } = useAppearance();
  return <RN.ScrollView {...props} ref={ref} style={themeStyle(props.style, mode)}
    contentContainerStyle={themeStyle(props.contentContainerStyle, mode)} />;
});
const ThemedFlatList = React.forwardRef<RN.FlatList<unknown>, RN.FlatListProps<unknown>>((props, ref) => {
  const { mode } = useAppearance();
  return <RN.FlatList {...props} ref={ref} style={themeStyle(props.style, mode)}
    contentContainerStyle={themeStyle(props.contentContainerStyle, mode)} />;
}) as unknown as typeof RN.FlatList;
const ThemedPressable = React.forwardRef<RN.View, RN.PressableProps>((props, ref) => {
  const { mode } = useAppearance();
  const originalStyle = props.style;
  const style = typeof originalStyle === 'function'
    ? (state: RN.PressableStateCallbackType) => themeStyle(originalStyle(state), mode)
    : themeStyle(originalStyle, mode);
  return <RN.Pressable {...props} ref={ref} style={style} />;
});
const ThemedInput = React.forwardRef<RN.TextInput, RN.TextInputProps>((props, ref) => {
  const { mode, colors } = useAppearance();
  return <RN.TextInput {...props} ref={ref}
    style={mode === 'dark'
      ? [themeStyle(props.style, mode), { color: colors.text, backgroundColor: colors.input }, props.editable === false && { opacity: 0.7 }]
      : [{ color: colors.text, backgroundColor: colors.input }, props.style, props.editable === false && { opacity: 0.7 }]}
    placeholderTextColor={mode === 'dark' ? colors.placeholder : (props.placeholderTextColor ?? colors.placeholder)}
    selectionColor={props.selectionColor ?? colors.cursor}
    cursorColor={props.cursorColor ?? colors.cursor}
    keyboardAppearance={props.keyboardAppearance ?? mode}
    underlineColorAndroid={props.underlineColorAndroid ?? 'transparent'}
    textAlignVertical={props.textAlignVertical ?? (props.multiline ? undefined : 'center')}
  />;
});
const ThemedSafeAreaView = React.forwardRef<RN.SafeAreaView, RN.ViewProps>((props, ref) => {
  const { mode } = useAppearance();
  return <RN.SafeAreaView {...props} ref={ref} style={themeStyle(props.style, mode)} />;
});
const ThemedKeyboardAvoidingView = React.forwardRef<RN.KeyboardAvoidingView, RN.KeyboardAvoidingViewProps>((props, ref) => {
  const { mode } = useAppearance();
  return <RN.KeyboardAvoidingView {...props} ref={ref} style={themeStyle(props.style, mode)} />;
});
const ThemedActivityIndicator = React.forwardRef<RN.ActivityIndicator, RN.ActivityIndicatorProps>((props, ref) => {
  const { colors } = useAppearance();
  return <RN.ActivityIndicator {...props} ref={ref} color={props.color ?? colors.secondary} />;
});

export {
  ThemedView as View,
  ThemedText as Text,
  ThemedScrollView as ScrollView,
  ThemedFlatList as FlatList,
  ThemedPressable as Pressable,
  ThemedInput as TextInput,
  ThemedSafeAreaView as SafeAreaView,
  ThemedKeyboardAvoidingView as KeyboardAvoidingView,
  ThemedActivityIndicator as ActivityIndicator,
};
