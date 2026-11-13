import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from '../../theme/native';
import type { InstalledApp } from './appUpdate.ts';

/**
 * This build as the stores know it: the native app id and version (what the
 * store compares), whether it is an EAS `production` release build (the
 * stamp app.config.js adds; preview APKs and development clients are not),
 * and on iOS whether it is App Store-signed. A failed read is "not a store
 * build", which shows no notice.
 */
export async function readInstalledApp(): Promise<InstalledApp> {
  const build = (Constants.expoConfig?.extra as { build?: { profile?: unknown } } | undefined)?.build;
  const production = !__DEV__ && build?.profile === 'production';
  let appStoreSigned = false;
  if (Platform.OS === 'ios' && production) {
    try {
      appStoreSigned = (await Application.getIosApplicationReleaseTypeAsync()) === Application.ApplicationReleaseType.APP_STORE;
    } catch {
      appStoreSigned = false;
    }
  }
  const buildNumber = Number(Application.nativeBuildVersion);
  return {
    platform: Platform.OS,
    applicationId: Application.applicationId,
    version: Application.nativeApplicationVersion,
    buildNumber: Application.nativeBuildVersion && Number.isSafeInteger(buildNumber) && buildNumber > 0 ? buildNumber : null,
    production,
    appStoreSigned,
  };
}
