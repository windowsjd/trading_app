import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from '../../theme/native';
import { useSafeAreaInsets } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { useKeyboardCover } from '../../hooks/useKeyboardCover';
import ActionPressable from './ActionPressable';

/** Bottom sheets rise on a decelerate and fall on a short accelerate. */
export const sheetMotion = { openDuration: 280, closeDuration: 220 } as const;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInQuad = (t: number) => t * t;

/**
 * Presence for a bottom sheet: `progress` 0→1 drives the dim (opacity) and the
 * sheet (translateY) together; the content stays mounted through the closing
 * motion only. A reopen during closing continues from the current point.
 */
export function useSheetMotion(visible: boolean) {
  const reduced = useReducedMotion();
  const native = Platform.OS !== 'web';
  const [mounted, setMounted] = useState(visible);
  const openedRef = useRef(false);
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible && !openedRef.current) return;
    openedRef.current = visible;
    if (visible) setMounted(true);
    if (reduced) {
      progress.setValue(visible ? 1 : 0);
      if (!visible) setMounted(false);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? sheetMotion.openDuration : sheetMotion.closeDuration,
      easing: visible ? easeOutCubic : easeInQuad,
      useNativeDriver: native,
      isInteraction: false,
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [native, progress, reduced, visible]);
  return { mounted: visible || mounted, progress };
}

/**
 * A bottom sheet drawn in the app's own view tree (see ScreenSheetHost), so a
 * beginner quest spotlight can still point into it; native modals would cover
 * the guide. The dim fades while the sheet rises from and returns to the
 * bottom. `dismissible=false` (a command in flight) keeps every close path —
 * backdrop, close button, Android back — from looking like a cancel.
 */
export default function InlineBottomSheet(props: SheetProps) {
  const { mounted, progress } = useSheetMotion(props.visible);
  // Closed sheets mount nothing (no insets, keyboard or back listeners).
  return mounted ? <SheetFrame {...props} progress={progress} /> : null;
}

type SheetProps = {
  visible: boolean;
  onClose: () => void;
  dismissible?: boolean;
  title?: string;
  testID?: string;
  /** An inset card with every corner rounded, lifted off the screen edges. */
  floating?: boolean;
  children: React.ReactNode;
};

function SheetFrame({ visible, onClose, dismissible = true, title, testID, floating = false, children, progress }: SheetProps & { progress: Animated.Value }) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!visible) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (dismissible) onClose();
      return true;
    });
    return () => subscription.remove();
  }, [dismissible, onClose, visible]);

  // The sheet rises above the keyboard on both platforms. Android draws edge
  // to edge, so the keyboard covers the window instead of resizing it. The
  // sheet layer spans the app window, so its bottom is the window's.
  const keyboard = useKeyboardCover(visible, insets.bottom);

  const close = () => { if (dismissible) { Keyboard.dismiss(); onClose(); } };
  return (
    <View testID={testID} style={StyleSheet.absoluteFill} pointerEvents={visible ? 'auto' : 'none'}>
      <Animated.View pointerEvents="none" style={[styles.dim, { opacity: progress }]} />
      <Pressable testID={testID ? `${testID}-backdrop` : undefined} accessible={false} importantForAccessibility="no"
        style={StyleSheet.absoluteFill} onPress={close} />
      <Animated.View accessibilityViewIsModal style={[styles.anchor, floating && {
        left: FLOAT_GAP, right: FLOAT_GAP, bottom: (keyboard ? 0 : insets.bottom) + FLOAT_GAP,
      }, {
        maxHeight: height * 0.92 - keyboard - (floating ? insets.top + FLOAT_GAP : 0),
        marginBottom: keyboard,
        transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }],
      }]}>
        {/* Themed colors resolve on View, not on the Animated wrapper. */}
        <View style={[styles.sheet, floating ? styles.floatingSheet : { paddingBottom: (keyboard ? 12 : Math.max(insets.bottom, 12)) + 8 }]}>
        <View style={styles.grabber} accessible={false} />
        {title ? (
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>{title}</Text>
            <ActionPressable testID={testID ? `${testID}-close` : undefined} accessibilityRole="button" accessibilityLabel="닫기"
              accessibilityState={{ disabled: !dismissible }} disabled={!dismissible} onPress={close} style={styles.close}>
              <Text style={[styles.closeText, !dismissible && styles.closeDisabled]}>닫기</Text>
            </ActionPressable>
          </View>
        ) : null}
        {children}
        </View>
      </Animated.View>
    </View>
  );
}

const FLOAT_GAP = 10;

const styles = StyleSheet.create({
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.32)' },
  anchor: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  sheet: {
    flexShrink: 1,
    backgroundColor: semantic.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    paddingHorizontal: 16,
    gap: 8,
  },
  floatingSheet: { borderRadius: 24, paddingBottom: 12 },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: semantic.border, marginBottom: 4 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, paddingHorizontal: 4 },
  title: { flex: 1, minWidth: 0, fontSize: 18, lineHeight: 26, fontWeight: '700' },
  close: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  closeText: { fontSize: 15, lineHeight: 22, fontWeight: '600', color: semantic.secondary },
  closeDisabled: { opacity: 0.4 },
});
