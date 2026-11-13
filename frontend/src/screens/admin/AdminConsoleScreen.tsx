import React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MyStackParamList } from '../../app/navigation/types';
import { Platform, ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getMe } from '../../features/me/api';
import { isAdminRole } from '../../features/admin/adminRole';
import ActionPressable from '../../components/common/ActionPressable';
import WhaleLoader from '../../components/states/WhaleLoader';

type Props = NativeStackScreenProps<MyStackParamList, 'AdminConsole'>;

/**
 * 관리자 전용 콘솔 (2026-11-13): shown to an admin only (MY › 관리자 전용
 * 콘솔). It lists what is actually built — today only 공지사항 관리; nothing
 * else is shown as if it worked. The server still checks the role on every
 * request, so reaching this screen grants nothing by itself.
 */
export default function AdminConsoleScreen({ navigation }: Props) {
  const me = useQuery({ queryKey: QUERY_KEYS.me, queryFn: getMe });
  if (me.isPending) {
    return <View style={styles.center}><WhaleLoader size={32} accessibilityLabel="권한을 확인하는 중" /></View>;
  }
  if (!isAdminRole(me.data?.role)) {
    return (
      <Text testID="admin-console-blocked" accessibilityLiveRegion="polite" style={styles.blocked}>
        관리자 권한이 확인된 계정에서만 이용할 수 있습니다.
      </Text>
    );
  }
  return (
    <ScrollView testID="admin-console-screen" style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.caption}>관리자 계정에만 보이는 화면입니다. 지금은 공지사항 관리를 이용할 수 있습니다.</Text>
      <ActionPressable testID="admin-console-notices" accessibilityRole="button" accessibilityLabel="공지사항 관리"
        onPress={() => navigation.navigate('AdminNotices')} style={styles.menu}>
        <Text style={styles.menuTitle}>공지사항 관리</Text>
        <Text style={styles.caption}>공지 작성·미리보기·게시·철회, 게시 상태 확인</Text>
      </ActionPressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: getHeaderScreenContentStyle(Platform.OS),
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: semantic.screen },
  blocked: { padding: 24, fontSize: 15, lineHeight: 22, color: semantic.secondary },
  caption: { fontSize: 14, lineHeight: 21, color: semantic.secondary },
  menu: { gap: 4, padding: 20, borderWidth: 1, borderColor: semantic.border, borderRadius: 14, backgroundColor: semantic.surface },
  menuTitle: { fontSize: 18, lineHeight: 25, fontWeight: '700', color: semantic.text },
});
