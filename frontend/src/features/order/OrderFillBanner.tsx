import React, { useCallback, useContext, useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Platform,
  Text,
  View,
} from '../../theme/native';
import { SafeAreaInsetsContext, initialWindowMetrics } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { useReducedMotion } from '../../theme/useReducedMotion';
import ActionPressable from '../../components/common/ActionPressable';
import type { FillNotice } from './fillTracker';

/** Visible time after the entrance; long enough to read the title and act. */
export const FILL_BANNER_VISIBLE_MS = 4000;
const ENTER_MS = 220;
const EXIT_MS = 180;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInQuad = (t: number) => t * t;

/**
 * Non-blocking top banner for one real fill (reference video 2): it drops in,
 * stays a few seconds and leaves; nothing behind it is covered except its own
 * card. Reduced Motion shows and hides it without movement.
 */
export default function OrderFillBanner({ notice, onDone, onOpenHistory }: {
  notice: FillNotice | null;
  onDone: () => void;
  onOpenHistory: (notice: FillNotice) => void;
}) {
  // Resolved once here, not per banner: the hook starts reduced until known.
  const reduced = useReducedMotion();
  return notice ? (
    <BannerFrame key={notice.id} notice={notice} reduced={reduced} onDone={onDone} onOpenHistory={onOpenHistory} />
  ) : null;
}

function BannerFrame({ notice, reduced, onDone, onOpenHistory }: {
  notice: FillNotice;
  reduced: boolean;
  onDone: () => void;
  onOpenHistory: (notice: FillNotice) => void;
}) {
  // Outside the navigators there is no inset provider; window metrics hold
  // the status bar / notch height.
  const insets = useContext(SafeAreaInsetsContext) ?? initialWindowMetrics?.insets ?? null;
  const progress = useRef(new Animated.Value(0)).current;
  const finished = useRef(false);
  const native = Platform.OS !== 'web';
  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    onDone();
  }, [onDone]);
  const leave = useCallback(() => {
    if (reduced) {
      progress.setValue(0);
      finish();
      return;
    }
    Animated.timing(progress, { toValue: 0, duration: EXIT_MS, easing: easeInQuad, useNativeDriver: native, isInteraction: false })
      .start(() => finish());
  }, [finish, native, progress, reduced]);

  useEffect(() => {
    const message = notice.detail ? `${notice.title}. ${notice.detail}` : notice.title;
    if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility?.(message);
    if (reduced) progress.setValue(1);
    else Animated.timing(progress, { toValue: 1, duration: ENTER_MS, easing: easeOutCubic, useNativeDriver: native, isInteraction: false }).start();
    const timer = setTimeout(leave, FILL_BANNER_VISIBLE_MS);
    return () => clearTimeout(timer);
    // One run per banner; the frame is keyed by notice id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const overflow = notice.overflow ? `외 ${notice.overflow}건 체결` : null;
  const detail = [notice.detail, overflow].filter(Boolean).join(' · ') || null;
  return (
    <View pointerEvents="box-none" style={[styles.layer, { top: (insets?.top ?? 0) + 8 }]}>
      <Animated.View
        style={[styles.motion, {
          opacity: progress,
          transform: reduced ? [] : [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-20, 0] }) }],
        }]}
      >
        {/* Themed colors resolve on View, not on the Animated wrapper. */}
        <View
          testID="order-fill-banner"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={styles.card}
        >
          {/* The action wraps under the text on narrow screens / large fonts,
              so the title keeps a readable width and the card stays short. */}
          <View style={styles.head}>
            <View style={styles.icon} accessible={false} importantForAccessibility="no-hide-descendants">
              <Text style={styles.iconText}>✓</Text>
            </View>
            <View style={styles.copy}>
              <Text testID="order-fill-banner-title" style={styles.title}>{notice.title}</Text>
              {detail ? <Text testID="order-fill-banner-detail" style={styles.detail}>{detail}</Text> : null}
            </View>
          </View>
          <ActionPressable
            testID="order-fill-banner-history"
            accessibilityRole="button"
            accessibilityLabel={`내역 보기, ${notice.title}`}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            style={styles.action}
            onPress={() => {
              onOpenHistory(notice);
              leave();
            }}
          >
            <Text style={styles.actionText}>내역 보기</Text>
          </ActionPressable>
        </View>
      </Animated.View>
    </View>
  );
}

// Plain objects: mounted beside the root navigator (see MainTabs gotchas).
const styles = {
  layer: { position: 'absolute', left: 12, right: 12, alignItems: 'center', zIndex: 50, elevation: 50 },
  motion: { width: '100%', maxWidth: 520 },
  card: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 10,
    rowGap: 6,
    minHeight: 56,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.surface,
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  icon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: semantic.success,
  },
  iconText: { fontSize: 15, lineHeight: 18, fontWeight: '800', color: semantic.surface },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, flexGrow: 1, flexShrink: 1, flexBasis: 170, minWidth: 0 },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 15, lineHeight: 21, fontWeight: '700', color: semantic.text },
  detail: { fontSize: 12, lineHeight: 17, color: semantic.secondary },
  action: {
    flexShrink: 0,
    marginLeft: 'auto',
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: semantic.raised,
  },
  actionText: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: semantic.secondary },
} as const;
