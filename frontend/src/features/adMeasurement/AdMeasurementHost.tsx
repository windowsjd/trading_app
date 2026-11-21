import React, { useEffect } from 'react';
import { AppState, Platform } from '../../theme/native';
import { SafeAreaProvider, initialWindowMetrics } from '../../theme/safeArea';
import { useRootRouteName } from '../notifications/PushNotificationsHost';
import AdMeasurementConsentSheet from './AdMeasurementConsentSheet';
import { adMeasurement, alertIfNotSaved, useAdMeasurement } from './adMeasurement';

/**
 * 광고 성과 측정 (2026-11-21), mounted once beside the root navigator like
 * the push host:
 *
 * 1. At start it reads this device's choice and starts the Meta SDK only if
 *    the choice (and on iOS 앱 추적 허용) allows it — before any sign-in, as
 *    the install itself is what is measured.
 * 2. Without a choice for the current notice it asks once, over the first
 *    screen after the splash. Both answers continue into the app.
 * 3. 설정's switch opens the same sheet to agree later.
 * 4. iOS, back from the background: 앱 추적 허용 may have been changed in the
 *    system settings; the measurement follows it.
 *
 * Its own safe-area provider: this layer sits outside every navigator.
 */
export default function AdMeasurementHost() {
  const state = useAdMeasurement();
  const rootRoute = useRootRouteName();

  useEffect(() => {
    void adMeasurement.init();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    // The system prompt only makes the app inactive; a return from the
    // settings app passes through the background.
    let wasInBackground = false;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') wasInBackground = true;
      else if (next === 'active' && wasInBackground) {
        wasInBackground = false;
        void adMeasurement.refreshTracking();
      }
    });
    return () => subscription.remove();
  }, []);

  const launch = state.prompt === 'launch' && rootRoute !== null && rootRoute !== 'Splash';
  if (!state.supported || (!launch && state.prompt !== 'settings')) return null;
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics} style={layer}>
      <AdMeasurementConsentSheet
        visible
        requiresAnswer={launch}
        busy={state.busy}
        platform={Platform.OS === 'ios' ? 'ios' : 'android'}
        onAgree={() => void adMeasurement.answer('granted').then(alertIfNotSaved)}
        onDecline={() => void adMeasurement.answer('declined').then(alertIfNotSaved)}
        onClose={adMeasurement.closePrompt}
      />
    </SafeAreaProvider>
  );
}

const layer = { position: 'absolute' as const, top: 0, right: 0, bottom: 0, left: 0 };
