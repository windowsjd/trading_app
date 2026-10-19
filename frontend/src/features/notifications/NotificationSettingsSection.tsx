import React, { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppState, Platform, StyleSheet, Switch, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import { QUERY_KEYS } from '../../constants/queryKeys';
import ActionPressable from '../../components/common/ActionPressable';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { getNotificationPreferences, updateNotificationPreferences } from './api';
import { nativePush } from './nativePush';
import { permissionAction, toDevicePermission } from './pushPermission';
import {
  NOTIFICATION_PREFERENCE_ITEMS,
  type DevicePushPermission,
  type NotificationPreferenceKey,
  type NotificationSettings,
} from './types';

/** The device's OS permission, re-read when the app returns from Settings. */
function useDevicePushPermission() {
  const [state, setState] = useState<{ permission: DevicePushPermission; canAskAgain: boolean }>({
    permission: nativePush.supported ? 'undetermined' : 'unsupported',
    canAskAgain: true,
  });
  const read = useCallback(async () => {
    if (!nativePush.supported) return;
    try {
      const snapshot = await nativePush.getPermission();
      setState({ permission: toDevicePermission(snapshot), canAskAgain: snapshot.canAskAgain });
    } catch {
      // Unknown: keep the last state; the in-app switches still work.
    }
  }, []);
  useEffect(() => {
    void read();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void read();
    });
    return () => subscription.remove();
  }, [read]);
  const request = useCallback(async () => {
    try {
      const snapshot = await nativePush.requestPermission();
      setState({ permission: toDevicePermission(snapshot), canAskAgain: snapshot.canAskAgain });
    } catch {
      void read();
    }
  }, [read]);
  return { ...state, request, openSettings: () => void nativePush.openSystemSettings() };
}

type Change = { key: NotificationPreferenceKey | 'allEnabled'; value: boolean };

/**
 * 설정 > 알림. 전체 알림 and seven server-stored switches (all on until turned
 * off), and the device's own notification permission, shown as a separate
 * state. 전체 알림 off holds every push without touching the seven, so turning
 * it on again restores them. The seven sit under 알림 종류별 설정, folded by
 * default (a screen state only, never stored). A switch shows the saved
 * value; while a change is being saved it shows the request as "저장 중" and
 * every switch waits, and a failed save returns it to the saved value with an
 * error and 다시 시도. Keyed by user: another user's switches never show. A
 * server without 전체 알림 shows the seven as before.
 */
export default function NotificationSettingsSection({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const { colors } = useAppearance();
  const device = useDevicePushPermission();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const preferencesQuery = useQuery({
    queryKey: QUERY_KEYS.notifications.preferences(userId),
    queryFn: ({ signal }) => getNotificationPreferences(signal),
    staleTime: 0,
  });
  const mutation = useMutation({
    mutationFn: (change: Change) =>
      updateNotificationPreferences({ [change.key]: change.value }),
    onMutate: (change) => ({ userId, generation: getSessionGeneration(), change }),
    onSuccess: (settings, _change, context) => {
      // A late answer after logout or another user's sign-in is dropped.
      if (!context || !isCurrentSession(context.generation)) return;
      queryClient.setQueryData<NotificationSettings>(
        QUERY_KEYS.notifications.preferences(context.userId),
        settings,
      );
    },
  });
  const pending =
    mutation.isPending && mutation.context?.userId === userId ? mutation.variables : undefined;
  const failed =
    mutation.isError &&
    mutation.context?.userId === userId &&
    isCurrentSession(mutation.context.generation);
  const trackColor = { false: colors.border, true: colors.secondaryActionSurface };
  // RN Web selects the active thumb through a separate prop; native uses thumbColor.
  const activeThumb = Platform.OS === 'web' ? { activeThumbColor: colors.secondaryActionForeground } : {};
  const action = permissionAction(device.permission, device.canAskAgain);
  const saved = preferencesQuery.data;
  const save = (change: Change) => {
    if (mutation.isPending) return;
    mutation.mutate(change);
  };
  // 전체 알림 as saved (or as being saved); null without one on the server.
  const masterSaving = pending?.key === 'allEnabled';
  const master = !saved || saved.allEnabled === null ? null : masterSaving ? pending.value : saved.allEnabled;
  const held = master === false;
  const detailsShown = master === null || detailsOpen;
  const onCount = saved ? NOTIFICATION_PREFERENCE_ITEMS.filter((item) => saved.preferences[item.key]).length : 0;
  const switchColors = (value: boolean) => ({
    ...activeThumb,
    trackColor,
    thumbColor: value ? colors.secondaryActionForeground : colors.text,
    ios_backgroundColor: colors.border,
  });

  return (
    <View testID="settings-notifications" style={styles.card}>
      <Text style={styles.sectionTitle}>알림 설정</Text>
      <View testID="settings-notification-device" style={styles.device}>
        <Text style={styles.helper}>
          {device.permission === 'unsupported'
            ? '웹에서는 푸시 알림을 받을 수 없어요. 아래 설정은 모바일 앱에 적용돼요.'
            : device.permission === 'granted'
              ? '이 기기에서 푸시 알림을 받을 수 있어요.'
              : device.permission === 'denied'
                ? '기기 알림이 꺼져 있어 푸시 알림을 받을 수 없어요. 기기 설정에서 알림을 허용해 주세요.'
                : '기기 알림 권한을 아직 허용하지 않았어요.'}
        </Text>
        {action !== 'none' ? (
          <ActionPressable feedback="button" testID="settings-notification-permission"
            accessibilityRole="button" style={styles.permissionButton}
            onPress={() => (action === 'request' ? void device.request() : device.openSettings())}>
            <Text style={styles.permissionText}>{action === 'request' ? '알림 허용하기' : '기기 설정 열기'}</Text>
          </ActionPressable>
        ) : null}
      </View>
      {preferencesQuery.isPending ? (
        <Text style={styles.helper}>알림 설정을 불러오는 중입니다.</Text>
      ) : !saved ? (
        <View style={styles.device}>
          <Text testID="settings-notifications-load-error" style={styles.error}>
            알림 설정을 불러오지 못했습니다.
          </Text>
          <ActionPressable feedback="button" testID="settings-notifications-retry" accessibilityRole="button"
            style={styles.permissionButton} onPress={() => void preferencesQuery.refetch()}>
            <Text style={styles.permissionText}>다시 불러오기</Text>
          </ActionPressable>
          <AdminDiagnosticPanel error={preferencesQuery.error} />
        </View>
      ) : (
        <>
          {master !== null ? (
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.label}>전체 알림</Text>
                <Text testID="settings-notification-all-helper" style={styles.helper}>
                  {masterSaving ? '저장 중…' : master
                    ? '아래에서 켠 알림을 받아요.'
                    : '모든 푸시 알림을 받지 않아요. 다시 켜면 이전에 고른 알림이 그대로 돌아와요.'}
                </Text>
              </View>
              <Switch {...switchColors(master)} testID="settings-notification-all" accessibilityLabel="전체 알림"
                value={master} disabled={mutation.isPending}
                onValueChange={(next: boolean) => save({ key: 'allEnabled', value: next })} />
            </View>
          ) : null}
          {master !== null ? (
            <ActionPressable testID="settings-notification-details-toggle" accessibilityRole="button"
              accessibilityLabel="알림 종류별 설정" accessibilityState={{ expanded: detailsOpen }}
              style={styles.disclosure} onPress={() => setDetailsOpen((open) => !open)}>
              <Text style={styles.disclosureTitle}>알림 종류별 설정</Text>
              <Text style={styles.disclosureValue}>
                {`${onCount}/${NOTIFICATION_PREFERENCE_ITEMS.length} 켜짐 · ${detailsOpen ? '접기' : '펼치기'}`}
              </Text>
            </ActionPressable>
          ) : null}
          {detailsShown ? (
            <View testID="settings-notification-details" style={styles.details}>
              {held ? (
                <Text testID="settings-notification-held" style={styles.helper}>
                  전체 알림이 꺼져 있어 아래 알림을 받지 않아요. 고른 설정은 그대로 남아 있어요.
                </Text>
              ) : null}
              {NOTIFICATION_PREFERENCE_ITEMS.map((item) => {
                const saving = pending?.key === item.key;
                const value = saving ? pending.value : saved.preferences[item.key];
                return (
                  <View key={item.key} style={styles.row}>
                    <View style={styles.rowText}>
                      <Text style={[styles.label, held && styles.heldText]}>{item.label}</Text>
                      <Text style={styles.helper}>{saving ? '저장 중…' : item.description}</Text>
                    </View>
                    <Switch {...switchColors(value)} testID={`settings-notification-${item.key}`}
                      accessibilityLabel={`${item.label} 알림`} value={value}
                      // Held by 전체 알림: kept as chosen, changed only once it is on again.
                      disabled={mutation.isPending || held}
                      onValueChange={(next: boolean) => save({ key: item.key, value: next })} />
                  </View>
                );
              })}
            </View>
          ) : null}
        </>
      )}
      {failed ? (
        <View style={styles.device}>
          <Text testID="settings-notifications-save-error" accessibilityRole="alert" style={styles.error}>
            알림 설정을 저장하지 못했습니다. 다시 시도해주세요.
          </Text>
          {mutation.variables ? (
            <ActionPressable feedback="button" testID="settings-notifications-save-retry" accessibilityRole="button"
              style={styles.permissionButton} onPress={() => { if (mutation.variables) save(mutation.variables); }}>
              <Text style={styles.permissionText}>다시 시도</Text>
            </ActionPressable>
          ) : null}
          <AdminDiagnosticPanel error={mutation.error} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    padding: 16,
    backgroundColor: semantic.surface,
    gap: 12,
  },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  device: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  label: { fontSize: 16, fontWeight: '600', color: semantic.text },
  heldText: { color: semantic.secondary },
  details: { gap: 12 },
  disclosure: {
    minHeight: 44,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: 12,
    rowGap: 2,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: semantic.border,
  },
  disclosureTitle: { fontSize: 15, fontWeight: '600', color: semantic.text },
  disclosureValue: { fontSize: 14, color: semantic.secondary, lineHeight: 20 },
  helper: { fontSize: 14, color: semantic.secondary, lineHeight: 20 },
  error: { fontSize: 14, color: semantic.error, lineHeight: 21 },
  permissionButton: {
    alignSelf: 'flex-start',
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.raised,
    justifyContent: 'center',
  },
  permissionText: { fontSize: 14, fontWeight: '700', color: semantic.text },
});
