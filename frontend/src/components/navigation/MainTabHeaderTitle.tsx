import React from 'react';
import { HeaderTitle } from '@react-navigation/elements';
import { useTheme } from '@react-navigation/native';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { StyleSheet, View } from '../../theme/native';
import { useAppearance } from '../../theme/appearance';
import TabBarIcon, { type TabIconName } from './TabBarIcon';

type Props = React.ComponentProps<typeof HeaderTitle> & { icon: TabIconName };

export default function MainTabHeaderTitle({ icon, style, onLayout, ...titleProps }: Props) {
  const { colors } = useAppearance();
  const { fonts } = useTheme();
  const iconColor = titleProps.tintColor ?? colors.text;
  return (
    <View style={styles.row} pointerEvents="none" onLayout={onLayout}>
      <TabBarIcon name={icon} size={20} color={iconColor} focused={icon === 'home'} />
      <HeaderTitle {...titleProps} style={[style, fonts.heavy, styles.title]} maxFontSizeMultiplier={2} />
    </View>
  );
}

// Customize only the title slot; Navigation continues to own the toolbar,
// safe area and back button. Each stack applies this to its root screen only.
export function mainTabHeaderTitle(icon: TabIconName): NativeStackNavigationOptions['headerTitle'] {
  return (props) => <MainTabHeaderTitle {...props} icon={icon} />;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, maxWidth: '100%' },
  // Keep HeaderTitle's platform size and Navigation's 700-weight font family.
  // Cap title scaling at 2x to retain the native toolbar's height.
  title: { flexShrink: 1 },
});
