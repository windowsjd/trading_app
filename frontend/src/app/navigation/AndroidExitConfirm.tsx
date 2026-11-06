import { useEffect } from 'react';
import { BackHandler, Platform, ToastAndroid } from '../../theme/native';
import { createExitConfirm } from './exitConfirm';
import { rootNavigationRef } from './navigationRef';

/**
 * Android: the Back that would leave the app asks first (exitConfirm). Mounted
 * inside NavigationContainer, so its listener is added before navigation's and
 * runs after it; it still checks, so it never takes a Back navigation would
 * handle. Draws nothing.
 */
export default function AndroidExitConfirm() {
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', createExitConfirm({
      canGoBack: () => rootNavigationRef.isReady() && rootNavigationRef.canGoBack(),
      notify: (message) => ToastAndroid.show(message, ToastAndroid.SHORT),
    }));
    return () => subscription.remove();
  }, []);
  return null;
}
