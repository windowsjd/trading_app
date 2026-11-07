import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { ensureAdsReady, getAdUnit, loadAdsModule } from '../../features/ads/adsRuntime';

type AdsModule = typeof import('react-native-google-mobile-ads');
type BannerInstance = InstanceType<AdsModule['BannerAd']>;

/**
 * One anchored adaptive banner (2026-11-07) at the bottom of Home and of the
 * community feed — its own band in the layout, never drawn over content, a
 * button or a sheet. This build's banner unit only (Google's sample in
 * development/preview, Trading Class's own in production; never a rewarded
 * unit), requested once the consent allows it, non-personalized like the
 * rewarded ad. Nothing is drawn (no space taken) until an ad arrives, and a
 * failed load just leaves the screen as it was; it is tried again only after
 * the app comes back to the foreground — no retry loop. Coming back, iOS
 * reloads the banner (its web view may have been dropped in the background).
 * The banner pays nothing and never touches the reward APIs. One banner per
 * slot instance; unmounting removes it and its subscription.
 */
export default function BannerAdSlot({ testID }: { testID: string }) {
  const [unitId] = useState(() => getAdUnit('banner'));
  const [ads, setAds] = useState<AdsModule | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const banner = useRef<BannerInstance | null>(null);

  useEffect(() => {
    if (!unitId) return undefined;
    let live = true;
    ensureAdsReady()
      .then((readiness) => (readiness.canRequestAds ? loadAdsModule() : null))
      .then((module) => { if (live && module) setAds(module); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [unitId]);

  useEffect(() => {
    if (!ads) return undefined;
    // Back from the background (also via 'inactive'); a mere 'inactive' (Notification Center) is not a return.
    let backgrounded = false;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') backgrounded = true;
      else if (next === 'active' && backgrounded) {
        backgrounded = false;
        if (failed) {
          setFailed(false);
          setLoaded(false);
          setAttempt((count) => count + 1);
        } else if (Platform.OS === 'ios') {
          banner.current?.load();
        }
      }
    });
    return () => subscription.remove();
  }, [ads, failed]);

  if (!unitId || !ads || failed) return null;
  const Banner = ads.BannerAd;
  return (
    <View testID={testID} style={loaded ? styles.slot : styles.pending}>
      <Banner key={attempt} ref={banner} unitId={unitId} size={ads.BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
        requestOptions={{ requestNonPersonalizedAdsOnly: true }}
        onAdLoaded={() => setLoaded(true)} onAdFailedToLoad={() => setFailed(true)} />
    </View>
  );
}

// Plain objects: harnesses load this with minimal react-native mocks.
const styles = {
  // A band of its own under the content: a top line and the surface tone
  // set it apart from the app's cards and buttons.
  slot: { alignItems: 'center' as const, borderTopWidth: 1, borderTopColor: semantic.border, backgroundColor: semantic.surface },
  // Loading: no space and no line yet (the banner draws itself once it has an ad).
  pending: { alignItems: 'center' as const, height: 0, overflow: 'hidden' as const },
};
