import { useSyncExternalStore } from 'react';
import { Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { measurementPlatform } from './consent';
import { createAdMeasurement, type AdMeasurementState, type DecisionResult } from './controller';
import { metaSdk } from './metaSdk';

/**
 * The app's one 광고 성과 측정 instance (2026-11-21): started by
 * AdMeasurementHost, read by the consent sheet and the 설정 cards. The choice
 * lives on this device under its own key; logout and account switches keep it.
 */
const RECORD_KEY = 'trading-app:ad-measurement-consent';

export const adMeasurement = createAdMeasurement({
  platform: measurementPlatform(Platform.OS),
  sdk: metaSdk,
  readRecord: () => AsyncStorage.getItem(RECORD_KEY),
  writeRecord: (raw) => AsyncStorage.setItem(RECORD_KEY, raw),
  now: () => new Date(),
});

export function useAdMeasurement(): AdMeasurementState {
  return useSyncExternalStore(adMeasurement.subscribe, adMeasurement.getState, adMeasurement.getState);
}

/** A choice that could not be saved was not applied (a withdrawal still stopped the SDK for now). */
export function alertIfNotSaved(result: DecisionResult) {
  if (result === 'failed') Alert.alert('저장하지 못했습니다', '광고 성과 측정 설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
}
