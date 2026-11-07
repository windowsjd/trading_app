import { Platform } from 'react-native';
import { ensureAdsReady, getAdUnit, loadAdsModule } from '../ads/adsRuntime';
import type { RewardedAdOutcome, RewardedAdPhase, RewardedAdProvider } from './rewardedAdTypes';

export type { RewardedAdOutcome, RewardedAdPhase, RewardedAdProvider, RewardedAdPurpose } from './rewardedAdTypes';

/** No ad within this long (no fill, a stuck SDK): unavailable, nothing to claim. */
const LOAD_TIMEOUT_MS = 45_000;

/** One rewarded ad on screen at a time, app-wide. */
let presenting = false;

/**
 * AdMob rewarded ads (2026-11-07): this build's rewarded unit (Google's
 * sample unit in development/preview, Trading Class's own in production —
 * adMobUnits), loaded fresh for each attempt with the server session's SSV
 * options and shown as soon as it loads. Every listener is removed when the
 * attempt ends. The `earned` outcome only lets the app ask the server; the
 * server pays on Google's signed callback.
 */
export function getRewardedAdProvider(): RewardedAdProvider | null {
  const unitId = getAdUnit('rewarded');
  const platform = Platform.OS;
  if (!unitId || (platform !== 'android' && platform !== 'ios')) return null;
  return { key: 'admob', platform, show: (input) => showRewarded(unitId, input) };
}

async function showRewarded(
  unitId: string,
  { ssv, onPhase }: { ssv: { userId: string; customData: string }; onPhase?: (phase: RewardedAdPhase) => void },
): Promise<RewardedAdOutcome> {
  if (presenting) return { status: 'unavailable', reason: 'busy' };
  presenting = true;
  try {
    onPhase?.('loading');
    const readiness = await ensureAdsReady().catch(() => null);
    if (!readiness) return { status: 'unavailable', reason: 'load' };
    if (!readiness.canRequestAds) return { status: 'unavailable', reason: 'consent' };
    const ads = await loadAdsModule();
    const ad = ads.RewardedAd.createForAdRequest(unitId, {
      requestNonPersonalizedAdsOnly: true,
      serverSideVerificationOptions: { userId: ssv.userId, customData: ssv.customData },
    });
    return await new Promise<RewardedAdOutcome>((resolve) => {
      let earned = false;
      let opened = false;
      let settled = false;
      const finish = (outcome: RewardedAdOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        ad.removeAllListeners();
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ status: 'unavailable', reason: 'load' }), LOAD_TIMEOUT_MS);
      const unsubscribe = ad.addAdEventsListener(({ type }) => {
        if (type === ads.RewardedAdEventType.LOADED) {
          clearTimeout(timer);
          onPhase?.('showing');
          ad.show().catch(() => finish({ status: 'unavailable', reason: 'show' }));
        } else if (type === ads.AdEventType.OPENED) {
          opened = true;
        } else if (type === ads.RewardedAdEventType.EARNED_REWARD) {
          earned = true;
          onPhase?.('earned');
        } else if (type === ads.AdEventType.CLOSED) {
          finish(earned ? { status: 'earned' } : { status: 'dismissed' });
        } else if (type === ads.AdEventType.ERROR) {
          // After the reward Google may still send its callback: let the
          // server decide (never shown as success before it does).
          finish(earned ? { status: 'earned' } : { status: 'unavailable', reason: opened ? 'show' : 'load' });
        }
      });
      ad.load();
    });
  } catch {
    return { status: 'unavailable', reason: 'load' };
  } finally {
    presenting = false;
  }
}
