import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * How far the software keyboard reaches up from the bottom of the window
 * (0 while hidden), for a view whose bottom edge is the window's.
 *
 * Android draws edge to edge (`edgeToEdgeEnabled`): `adjustResize` no longer
 * shrinks the window, so the keyboard covers its bottom, the navigation bar
 * area included. Android's `endCoordinates.height` leaves that area out (iOS
 * counts the home indicator), so the caller's bottom inset is added back.
 * Nothing is measured: on Android, Fabric's `measureInWindow` is offset by the
 * status bar while the keyboard's `screenY` is not.
 */
export function useKeyboardCover(enabled = true, bottomInset = 0) {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const ios = Platform.OS === 'ios';
    const apply = (metrics?: { height: number } | null) => setHeight(metrics ? Math.max(0, metrics.height) : 0);
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (event) => apply(event.endCoordinates));
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => apply(null));
    // Opened while the keyboard is already up (Android reports a show once).
    if (Keyboard.isVisible?.()) apply(Keyboard.metrics?.());
    return () => {
      show.remove();
      hide.remove();
      setHeight(0);
    };
  }, [enabled]);
  return height > 0 ? height + (Platform.OS === 'android' ? bottomInset : 0) : 0;
}
