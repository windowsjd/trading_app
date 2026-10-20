import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';
import { rewardedTestUnit } from './rewardedTestConfig';
import type { RewardedTestSdk, TestAdEvent } from './rewardedTest';

export const getRewardedTestUnit = () => rewardedTestUnit(Platform.OS,
  Constants.expoConfig?.extra?.adMob, Constants.executionEnvironment === ExecutionEnvironment.StoreClient);

let initialized: Promise<unknown> | undefined;
let presenting: object | undefined;

export async function loadRewardedTestSdk(): Promise<RewardedTestSdk> {
  if (!getRewardedTestUnit()) throw new Error('Test ads are disabled in this build.');
  // A missing native module (Expo Go/old APK) fails this optional action only.
  const ads = await import('react-native-google-mobile-ads');
  return {
    async prepare() {
      const consent = await ads.AdsConsent.gatherConsent();
      if (!consent.canRequestAds) throw new Error('Ad consent is not available.');
      if (initialized === undefined) {
        initialized = ads.default().setRequestConfiguration({ testDeviceIdentifiers: ['EMULATOR'] })
          .then(() => ads.default().initialize()).catch((error: unknown) => { initialized = undefined; throw error; });
      }
      await initialized;
      return { privacyOptionsRequired: consent.privacyOptionsRequirementStatus === ads.AdsConsentPrivacyOptionsRequirementStatus.REQUIRED };
    },
    showPrivacyOptions: () => ads.AdsConsent.showPrivacyOptionsForm().then(() => undefined),
    create(unitId) {
      if (unitId !== getRewardedTestUnit() || unitId !== ads.TestIds.REWARDED) throw new Error('Only the official test unit is permitted.');
      const native = ads.RewardedAd.createForAdRequest(unitId, { requestNonPersonalizedAdsOnly: true });
      let observer: ((event: TestAdEvent) => void) | undefined;
      let disposed = false, consumed = false;
      const events: Record<string, TestAdEvent> = {
        [ads.RewardedAdEventType.LOADED]: 'loaded', [ads.RewardedAdEventType.EARNED_REWARD]: 'earned',
        [ads.AdEventType.OPENED]: 'opened', [ads.AdEventType.CLOSED]: 'closed', [ads.AdEventType.ERROR]: 'error',
      };
      const cleanup = () => { unsubscribe(); native.removeAllListeners(); };
      const unsubscribe = native.addAdEventsListener(({ type }) => {
        const event = events[type];
        if (!event) return;
        if (event === 'closed' || event === 'error') {
          if (presenting === native) presenting = undefined;
          cleanup();
        }
        observer?.(event);
      });
      return {
        listen(listener) { observer = listener; },
        load() { if (!disposed) native.load(); },
        async show() {
          if (disposed || consumed || presenting) throw new Error('Ad is unavailable or another ad is presenting.');
          consumed = true; presenting = native;
          try { await native.show(); }
          catch (error) { if (presenting === native) presenting = undefined; cleanup(); throw error; }
        },
        dispose() {
          disposed = true; observer = undefined;
          // v16 cannot dismiss a visible native ad. Keep only terminal native
          // events so a disposed screen cannot release the global display lock early.
          if (presenting !== native) cleanup();
        },
      };
    },
  };
}
