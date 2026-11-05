import React, { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import ActionPressable from './ActionPressable';

/**
 * What the banner's action did. Only `opened` moved anywhere; the banner
 * stays (and says why) when an active beginner guide held the move or
 * navigation is not ready yet.
 */
export type BannerActionOutcome = 'opened' | 'held' | 'unavailable';

export type TopNotice = {
  /** One banner per id within its channel. */
  id: string;
  title: string;
  detail: string | null;
};

const ENTER_MS = 220;
const EXIT_MS = 180;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInQuad = (t: number) => t * t;

/*
 * One top banner on screen at a time, app-wide (2026-11-06): the real-fill
 * banner and the friend-request banner share this place. The first to show
 * holds it until it leaves; the other's next notice waits, so two banners
 * never stack over the screen.
 */
let holder: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const currentHolder = () => holder;
const setHolder = (next: string | null) => {
  holder = next;
  listeners.forEach((listener) => listener());
};

/**
 * Non-blocking top banner (reference video 2): it drops in, stays a few
 * seconds and leaves; nothing behind it is covered except its own card.
 * Reduced Motion shows and hides it without movement. Ids are `${testID}`,
 * `-title`, `-detail`, `-not-opened` and `actionTestID`.
 */
export default function TopNoticeBanner({ channel, notice, visibleMs, heldMs, icon, actionLabel, actionTestID, notOpened, testID, onAction, onDone }: {
  /** Who shows it (one place, several notifiers). */
  channel: string;
  notice: TopNotice | null;
  /** Visible time after the entrance; long enough to read the title and act. */
  visibleMs: number;
  /** After a held action: time to read why, end the guide and press again. */
  heldMs: number;
  icon: { glyph: string; tone: 'success' | 'info' };
  actionLabel: string;
  actionTestID: string;
  notOpened: Record<Exclude<BannerActionOutcome, 'opened'>, string>;
  testID: string;
  onAction: () => BannerActionOutcome;
  onDone: () => void;
}) {
  // Resolved once here, not per banner: the hook starts reduced until known.
  const reduced = useReducedMotion();
  const held = useSyncExternalStore(subscribe, currentHolder, currentHolder);
  const slot = notice ? `${channel}:${notice.id}` : null;
  // Another banner holds the place: this one waits (its timer has not started).
  if (!notice || !slot || (held !== null && held !== slot)) return null;
  return (
    <BannerFrame key={slot} slot={slot} notice={notice} reduced={reduced} visibleMs={visibleMs} heldMs={heldMs} icon={icon}
      actionLabel={actionLabel} actionTestID={actionTestID} notOpened={notOpened} testID={testID} onAction={onAction} onDone={onDone} />
  );
}

function BannerFrame({ slot, notice, reduced, visibleMs, heldMs, icon, actionLabel, actionTestID, notOpened, testID, onAction, onDone }: {
  slot: string;
  notice: TopNotice;
  reduced: boolean;
  visibleMs: number;
  heldMs: number;
  icon: { glyph: string; tone: 'success' | 'info' };
  actionLabel: string;
  actionTestID: string;
  notOpened: Record<Exclude<BannerActionOutcome, 'opened'>, string>;
  testID: string;
  onAction: () => BannerActionOutcome;
  onDone: () => void;
}) {
  // Before paint: two banners mounting together never both show.
  useLayoutEffect(() => {
    if (currentHolder() === null) setHolder(slot);
    return () => {
      if (currentHolder() === slot) setHolder(null);
    };
  }, [slot]);
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

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveAfter = useCallback((ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(leave, ms);
  }, [leave]);
  const [held, setHeld] = useState<Exclude<BannerActionOutcome, 'opened'> | null>(null);

  useEffect(() => {
    const message = notice.detail ? `${notice.title}. ${notice.detail}` : notice.title;
    if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility?.(message);
    if (reduced) progress.setValue(1);
    else Animated.timing(progress, { toValue: 1, duration: ENTER_MS, easing: easeOutCubic, useNativeDriver: native, isInteraction: false }).start();
    leaveAfter(visibleMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // One run per banner; the frame is keyed by notice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = () => {
    const outcome = onAction();
    if (outcome === 'opened') {
      leave();
      return;
    }
    // Nothing opened: the notice stays on screen with the reason, not dismissed.
    setHeld(outcome);
    if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility?.(notOpened[outcome]);
    leaveAfter(heldMs);
  };

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
          testID={testID}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={styles.card}
        >
          {/* The action wraps under the text on narrow screens / large fonts,
              so the title keeps a readable width and the card stays short. */}
          <View style={styles.head}>
            <View style={[styles.icon, icon.tone === 'info' ? styles.infoIcon : styles.successIcon]}
              accessible={false} importantForAccessibility="no-hide-descendants">
              <Text style={styles.iconText}>{icon.glyph}</Text>
            </View>
            <View style={styles.copy}>
              <Text testID={`${testID}-title`} style={styles.title}>{notice.title}</Text>
              {notice.detail ? <Text testID={`${testID}-detail`} style={styles.detail}>{notice.detail}</Text> : null}
              {held ? <Text testID={`${testID}-not-opened`} style={styles.notOpened}>{notOpened[held]}</Text> : null}
            </View>
          </View>
          <ActionPressable
            testID={actionTestID}
            accessibilityRole="button"
            accessibilityLabel={`${actionLabel}, ${notice.title}`}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            style={styles.action}
            onPress={act}
          >
            <Text style={styles.actionText}>{actionLabel}</Text>
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
  },
  successIcon: { backgroundColor: semantic.success },
  infoIcon: { backgroundColor: semantic.info },
  iconText: { fontSize: 15, lineHeight: 18, fontWeight: '800', color: semantic.surface },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, flexGrow: 1, flexShrink: 1, flexBasis: 170, minWidth: 0 },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 15, lineHeight: 21, fontWeight: '700', color: semantic.text },
  detail: { fontSize: 12, lineHeight: 17, color: semantic.secondary },
  notOpened: { fontSize: 12, lineHeight: 17, fontWeight: '600', color: semantic.warning },
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
