import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';
import { adMobUnit, isAdMobTestMode, type AdUnitKind } from './adMobUnits';

/**
 * The AdMob SDK for this app session (2026-11-07), shared by the rewarded
 * ads and the banners. Nothing loads the native module until a unit exists
 * for this build (adMobUnits); the consent (UMP) is gathered first and the
 * SDK starts only when Google answers that ads may be requested. A failed
 * start is not remembered, so a later screen may try again; it never blocks
 * anything but the ad that asked.
 */
export type AdsReadiness = { canRequestAds: boolean; privacyOptionsRequired: boolean };
type AdsModule = typeof import('react-native-google-mobile-ads');

let adsModule: Promise<AdsModule> | undefined;
let started: Promise<AdsReadiness> | undefined;

const expoGo = () => Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
const config = () => Constants.expoConfig?.extra?.adMob;

/** The unit this build may request for `kind`, or null (web, Expo Go, unknown build). */
export function getAdUnit(kind: AdUnitKind): string | null {
  return adMobUnit(kind, Platform.OS, config(), expoGo());
}

export function loadAdsModule(): Promise<AdsModule> {
  if (!getAdUnit('rewarded') && !getAdUnit('banner')) return Promise.reject(new Error('Ads are disabled in this build.'));
  adsModule ??= import('react-native-google-mobile-ads').catch((error: unknown) => {
    adsModule = undefined;
    throw error;
  });
  return adsModule;
}

export function ensureAdsReady(): Promise<AdsReadiness> {
  started ??= (async () => {
    const ads = await loadAdsModule();
    const consent = await ads.AdsConsent.gatherConsent();
    const privacyOptionsRequired =
      consent.privacyOptionsRequirementStatus === ads.AdsConsentPrivacyOptionsRequirementStatus.REQUIRED;
    if (!consent.canRequestAds) return { canRequestAds: false, privacyOptionsRequired };
    // Emulators are test devices only for the sample units' builds.
    if (isAdMobTestMode(config())) await ads.default().setRequestConfiguration({ testDeviceIdentifiers: ['EMULATOR'] });
    await ads.default().initialize();
    return { canRequestAds: true, privacyOptionsRequired };
  })().catch((error: unknown) => {
    started = undefined;
    throw error;
  });
  return started;
}

/** Google's privacy options form (shown only when UMP requires it); the next ad reads the new choice. */
export async function showAdsPrivacyOptions(): Promise<AdsReadiness> {
  const ads = await loadAdsModule();
  await ads.AdsConsent.showPrivacyOptionsForm();
  started = undefined;
  return ensureAdsReady();
}
