import React from 'react';
import * as RN from 'react-native';
import { useAppearance } from './appearance';
import { resolveSemanticColor, resolveSemanticStyle } from './tokens';

export * from 'react-native';
export type View = RN.View;
export type ScrollView = RN.ScrollView;
export type Text = RN.Text;
export type TextInput = RN.TextInput;

const ThemedView = React.forwardRef<RN.View, RN.ViewProps>((props, ref) => {
  const { colors, mode, financialPreference } = useAppearance();
  return <RN.View {...props} ref={ref} style={resolveSemanticStyle(props.style, colors, mode, financialPreference)} />;
});
const ThemedText = React.forwardRef<RN.Text, RN.TextProps>((props, ref) => {
  const { colors, mode, financialPreference } = useAppearance();
  return <RN.Text {...props} ref={ref} style={[{ color: colors.text }, resolveSemanticStyle(props.style, colors, mode, financialPreference)]} />;
});
const ThemedScrollView = React.forwardRef<RN.ScrollView, RN.ScrollViewProps>((props, ref) => {
  const { colors, mode, financialPreference } = useAppearance();
  return <RN.ScrollView {...props} ref={ref} style={resolveSemanticStyle(props.style, colors, mode, financialPreference)}
    contentContainerStyle={resolveSemanticStyle(props.contentContainerStyle, colors, mode, financialPreference)} />;
});
const ThemedFlatList = React.forwardRef<RN.FlatList<unknown>, RN.FlatListProps<unknown>>((props, ref) => {
  const { colors, mode, financialPreference } = useAppearance();
  return <RN.FlatList {...props} ref={ref} style={resolveSemanticStyle(props.style, colors, mode, financialPreference)}
    contentContainerStyle={resolveSemanticStyle(props.contentContainerStyle, colors, mode, financialPreference)} />;
}) as unknown as typeof RN.FlatList;
const ThemedPressable = React.forwardRef<RN.View, RN.PressableProps>((props, ref) => {
  const { colors, mode, financialPreference } = useAppearance();
  const originalStyle = props.style;
  const style = typeof originalStyle === 'function'
    ? (state: RN.PressableStateCallbackType) => resolveSemanticStyle(originalStyle(state), colors, mode, financialPreference)
    : resolveSemanticStyle(originalStyle, colors, mode, financialPreference);
  return <RN.Pressable {...props} ref={ref} style={style} />;
});
const ThemedInput = React.forwardRef<RN.TextInput, RN.TextInputProps>((props, ref) => {
  const { mode, colors, financialPreference } = useAppearance();
  return <RN.TextInput {...props} ref={ref}
    style={[{ color: colors.text, backgroundColor: colors.input }, resolveSemanticStyle(props.style, colors, mode, financialPreference), props.editable === false && { opacity: 0.7 }]}
    placeholderTextColor={resolveSemanticColor(props.placeholderTextColor, colors, mode, financialPreference) ?? colors.placeholder}
    selectionColor={resolveSemanticColor(props.selectionColor, colors, mode, financialPreference) ?? colors.cursor}
    cursorColor={resolveSemanticColor(props.cursorColor, colors, mode, financialPreference) ?? colors.cursor}
    keyboardAppearance={props.keyboardAppearance ?? mode}
    underlineColorAndroid={props.underlineColorAndroid ?? 'transparent'}
    textAlignVertical={props.textAlignVertical ?? (props.multiline ? undefined : 'center')}
  />;
});
const ThemedSafeAreaView = React.forwardRef<RN.SafeAreaView, RN.ViewProps>((props, ref) => {
  const { colors, mode, financialPreference } = useAppearance();
  return <RN.SafeAreaView {...props} ref={ref} style={resolveSemanticStyle(props.style, colors, mode, financialPreference)} />;
});
const ThemedKeyboardAvoidingView = React.forwardRef<RN.KeyboardAvoidingView, RN.KeyboardAvoidingViewProps>((props, ref) => {
  const { colors, mode, financialPreference } = useAppearance();
  return <RN.KeyboardAvoidingView {...props} ref={ref} style={resolveSemanticStyle(props.style, colors, mode, financialPreference)} />;
});
const ThemedActivityIndicator = React.forwardRef<RN.ActivityIndicator, RN.ActivityIndicatorProps>((props, ref) => {
  const { colors, mode, financialPreference } = useAppearance();
  return <RN.ActivityIndicator {...props} ref={ref} color={resolveSemanticColor(props.color, colors, mode, financialPreference) ?? colors.secondary} />;
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
