import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking, Platform } from 'react-native';
import type { PermissionSnapshot } from './pushPermission';

/**
 * The only module that talks to expo-notifications. Everything that decides
 * (permission policy, token ownership, tap routing) is pure and lives beside
 * it; this file just adapts the native calls, so screens and tests can stub
 * it as one boundary. Web has no push: `supported` is false there and no
 * native call is made.
 */

/** Must match the server's Android channel id (push-dispatcher.service.ts). */
export const PUSH_CHANNEL_ID = 'default';

const PERMISSION_REQUESTED_KEY = 'trading-app:push-permission-requested';
const REGISTERED_TOKEN_KEY = 'trading-app:push-token';

const supported = Platform.OS === 'ios' || Platform.OS === 'android';

function snapshot(response: Notifications.NotificationPermissionsStatus): PermissionSnapshot {
  return {
    status: response.status,
    granted: response.granted,
    canAskAgain: response.canAskAgain,
    iosStatus: Platform.OS === 'ios' ? (response.ios?.status ?? null) : null,
  };
}

export type ReceivedPush = { identifier: string; data: unknown };

export const nativePush = {
  supported,
  platform: Platform.OS === 'ios' ? ('ios' as const) : ('android' as const),

  async ensureChannel() {
    if (Platform.OS !== 'android') return;
    await Notifications.setNotificationChannelAsync(PUSH_CHANNEL_ID, {
      name: '알림',
      importance: Notifications.AndroidImportance.HIGH,
    });
  },

  async getPermission(): Promise<PermissionSnapshot> {
    return snapshot(await Notifications.getPermissionsAsync());
  },

  async requestPermission(): Promise<PermissionSnapshot> {
    return snapshot(await Notifications.requestPermissionsAsync());
  },

  async getToken(): Promise<string> {
    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
        ?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) throw new Error('EAS projectId is not configured.');
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  },

  /** While the app is in the foreground the OS shows no banner, list entry
   * or sound: the app updates its own screens instead. */
  suppressForegroundPresentation() {
    Notifications.setNotificationHandler({
      handleNotification: () =>
        Promise.resolve({
          shouldShowBanner: false,
          shouldShowList: false,
          shouldPlaySound: false,
          shouldSetBadge: false,
        }),
    });
  },

  onReceived(listener: (push: ReceivedPush) => void) {
    return Notifications.addNotificationReceivedListener((notification) =>
      listener({
        identifier: notification.request.identifier,
        data: notification.request.content.data,
      }),
    );
  },

  onTapped(listener: (push: ReceivedPush) => void) {
    return Notifications.addNotificationResponseReceivedListener((response) =>
      listener({
        identifier: response.notification.request.identifier,
        data: response.notification.request.content.data,
      }),
    );
  },

  /** The tap that launched the app from a terminated state, if any. */
  takeLaunchTap(): ReceivedPush | null {
    const response = Notifications.getLastNotificationResponse();
    if (!response) return null;
    Notifications.clearLastNotificationResponse();
    return {
      identifier: response.notification.request.identifier,
      data: response.notification.request.content.data,
    };
  },

  onTokenChanged(listener: () => void) {
    return Notifications.addPushTokenListener(() => listener());
  },

  async readPermissionRequested() {
    return (await AsyncStorage.getItem(PERMISSION_REQUESTED_KEY)) === '1';
  },

  async writePermissionRequested() {
    await AsyncStorage.setItem(PERMISSION_REQUESTED_KEY, '1');
  },

  readStoredToken: () => AsyncStorage.getItem(REGISTERED_TOKEN_KEY),

  async writeStoredToken(token: string | null) {
    if (token) await AsyncStorage.setItem(REGISTERED_TOKEN_KEY, token);
    else await AsyncStorage.removeItem(REGISTERED_TOKEN_KEY);
  },

  openSystemSettings: () => Linking.openSettings(),
};

export type NativePush = typeof nativePush;
