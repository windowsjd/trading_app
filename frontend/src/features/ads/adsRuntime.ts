import type { AdUnitKind } from './adMobUnits';

/**
 * Web/Node/unsupported hosts never import the native ads module (see
 * adsRuntime.native.ts, whose signatures these mirror for the type checker).
 */
export type AdsReadiness = { canRequestAds: boolean; privacyOptionsRequired: boolean };
type AdsModule = typeof import('react-native-google-mobile-ads');

const unsupported = () => new Error('Native ads need a development, preview or production build.');

export const getAdUnit = (_kind: AdUnitKind): string | null => null;
export const loadAdsModule = (): Promise<AdsModule> => Promise.reject(unsupported());
export const ensureAdsReady = (): Promise<AdsReadiness> => Promise.reject(unsupported());
export const showAdsPrivacyOptions = (): Promise<AdsReadiness> => Promise.reject(unsupported());
