import { semantic } from '../../theme/tokens';
import React from 'react';
import { ScrollView, Text, StyleSheet, Platform } from '../../theme/native';
import { getScreenContentStyle } from '../../theme/screenLayout';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MyStackParamList } from '../../app/navigation/types';
import ActionPressable from '../../components/common/ActionPressable';

const menus = [
  { route: 'My', title: 'MY' },
  { route: 'Friends', title: '친구' },
  { route: 'Notices', title: '공지사항' },
  { route: 'Settings', title: '설정' },
] as const;
export default function OverallScreen({
  navigation,
}: NativeStackScreenProps<MyStackParamList, 'Overall'>) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {menus.map((menu) => (
        <ActionPressable
          key={menu.route}
          testID={`overall-${menu.route}`}
          accessibilityRole="button"
          style={styles.row}
          onPress={() => navigation.navigate(menu.route)}
        >
          <Text style={styles.label}>{menu.title}</Text>
        </ActionPressable>
      ))}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, gap: 12 },
  row: {
    padding: 20,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.surface,
    borderRadius: 14,
  },
  label: { fontSize: 18, fontWeight: '700', flexShrink: 1 },
});
