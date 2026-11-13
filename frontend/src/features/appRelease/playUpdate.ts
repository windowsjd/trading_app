import { requireOptionalNativeModule } from 'expo';

/** Google Play's answer for this install (modules/play-app-update, Android only). */
export type PlayUpdateInfo = { updateAvailability: number; availableVersionCode: number };

type PlayAppUpdateNative = { getUpdateInfoAsync(): Promise<PlayUpdateInfo> };

/**
 * The local native module, or null where it does not exist (iOS, web, an
 * Android binary built before 2026-11-13). Without it there is no Play
 * notice — never a guess.
 */
const PlayAppUpdate = requireOptionalNativeModule<PlayAppUpdateNative>('PlayAppUpdate');

/** Whether Google Play offers this install a newer version; throws when Play cannot say. */
export async function readPlayUpdate(): Promise<PlayUpdateInfo> {
  if (!PlayAppUpdate) throw new Error('PLAY_APP_UPDATE_UNAVAILABLE');
  return PlayAppUpdate.getUpdateInfoAsync();
}
