import { semantic } from '../../theme/tokens';
import React from 'react';
import { ScrollView, Text, StyleSheet, Platform, View } from '../../theme/native';
import { getScreenContentStyle } from '../../theme/screenLayout';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MyStackParamList } from '../../app/navigation/types';
import ActionPressable from '../../components/common/ActionPressable';
import { usePendingFriendRequests } from '../../features/friends/usePendingFriendRequests';

const menus = [
  { route: 'My', title: 'MY' },
  { route: 'Friends', title: '친구' },
  { route: 'Record', title: '전적' },
  { route: 'Notices', title: '공지사항' },
  { route: 'Inquiry', title: '문의하기' },
  { route: 'Settings', title: '설정' },
] as const;
// One red for both appearances: at least 3:1 against the light (#ffffff) and
// dark (#1c1d21) row surfaces.
const NEW_REQUEST_DOT = '#F04452';

export default function OverallScreen({
  navigation,
}: NativeStackScreenProps<MyStackParamList, 'Overall'>) {
  const friendRequests = usePendingFriendRequests();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {menus.map((menu) => {
        const dot = menu.route === 'Friends' && friendRequests;
        return (
          <ActionPressable
            key={menu.route}
            testID={`overall-${menu.route}`}
            accessibilityRole="button"
            accessibilityLabel={dot ? `${menu.title}, 받은 친구 요청 있음` : undefined}
            style={styles.row}
            onPress={() => navigation.navigate(menu.route)}
          >
            <Text style={styles.label}>{menu.title}</Text>
            {/* A small dot, not a count: it sits in the box's corner padding,
                so the box keeps its height and the label its place. */}
            {dot ? (
              <View testID="overall-Friends-request-dot" style={styles.dot} pointerEvents="none"
                accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
            ) : null}
          </ActionPressable>
        );
      })}
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
  dot: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: NEW_REQUEST_DOT,
  },
});
