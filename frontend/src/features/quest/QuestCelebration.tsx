import React, { useEffect, useMemo, useRef } from 'react';
import Svg, { Path } from 'react-native-svg';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from '../../theme/native';
import { useAppearance } from '../../theme/appearance';
import { primaryGradient, semantic } from '../../theme/tokens';
import PrimaryButtonBackground from '../../components/common/PrimaryButtonBackground';
import { QUEST_GUIDE_COPY } from './questContent';

type Piece = { x: number; peak: number; fall: number; spin: number; width: number; height: number; color: number };

/** Deterministic burst: the same quest completion always looks the same. */
export function buildConfetti(count: number, spread: number, rise = spread * 1.3): Piece[] {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  return Array.from({ length: count }, (_, index) => {
    const fan = (2 * index) / Math.max(1, count - 1) - 1;
    return {
      x: fan * spread * (0.75 + random() * 0.25),
      peak: -rise * (0.75 + random() * 0.25),
      fall: rise + spread * (0.5 + random() * 0.45),
      spin: (random() > 0.5 ? 1 : -1) * (180 + random() * 360),
      width: 6 + Math.round(random() * 3),
      height: 9 + Math.round(random() * 5),
      color: index % 9 === 0 ? 3 : index % 3,
    };
  });
}

const FLIGHT_STOPS = [0, 0.06, 0.12, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1];
/** Fast lift, zero velocity at the apex, then gravity: no abrupt reversal. */
export function confettiFlight(piece: Pick<Piece, 'peak' | 'fall'>): number[] {
  return FLIGHT_STOPS.map(time => {
    if (time === 0) return 0;
    if (time <= 0.3) {
      const up = time / 0.3;
      return piece.peak * (2 * up - up * up);
    }
    const down = (time - 0.3) / 0.7;
    return piece.peak + piece.fall * down * down;
  });
}

/** Launch in a narrow column, then open the fan high above the success copy. */
function confettiSpread(x: number): number[] {
  return FLIGHT_STOPS.map(time => {
    const fan = Math.min(1, Math.max(0, (time - 0.1) / 0.5));
    return x * fan * fan * (3 - 2 * fan);
  });
}

/**
 * A short, one-time "퀘스트 완료!" moment. It only renders after the server
 * proved the quest; it blocks touches so nothing on the practice screen can be
 * pressed while the guide returns to the quest list underneath it.
 */
export default function QuestCelebration({ title, summary, leaving, reducedMotion, replay = false }: {
  title: string;
  summary: string | null;
  leaving: boolean;
  reducedMotion: boolean;
  replay?: boolean;
}) {
  const { colors } = useAppearance();
  const { width, height } = useWindowDimensions();
  const appear = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  const burst = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(reducedMotion || replay ? 1 : 0.6)).current;
  const native = Platform.OS !== 'web';
  const pieces = useMemo(() => buildConfetti(26, Math.min(175, width * 0.42), Math.min(240, height * 0.28)), [width, height]);
  const palette = [primaryGradient.colors[0], primaryGradient.colors[1], '#70AFFF', '#F2B705'];

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(title);
  }, [title]);

  useEffect(() => {
    if (reducedMotion) {
      appear.setValue(leaving ? 0 : 1);
      return;
    }
    const animation = Animated.timing(appear, {
      toValue: leaving ? 0 : 1,
      duration: leaving ? 240 : 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: native,
    });
    animation.start();
    return () => animation.stop();
  }, [appear, leaving, native, reducedMotion]);

  useEffect(() => {
    if (reducedMotion || replay) { pop.setValue(1); return; }
    const animation = Animated.parallel([
      Animated.timing(burst, { toValue: 1, duration: 1600, easing: Easing.linear, useNativeDriver: native, isInteraction: false }),
      Animated.spring(pop, { toValue: 1, friction: 6, tension: 120, useNativeDriver: native }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [burst, native, pop, reducedMotion, replay]);

  return (
    <Animated.View
      testID="quest-guide-celebration"
      style={[StyleSheet.absoluteFill, styles.scrim, { backgroundColor: `${colors.screen}F2`, opacity: appear }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      accessibilityViewIsModal
    >
      <View style={styles.center}>
        <View style={styles.burstOrigin} pointerEvents="none">
          {reducedMotion || replay ? null : pieces.map((piece, index) => (
            <Animated.View
              key={index}
              testID="quest-confetti-piece"
              style={[styles.piece, {
                width: piece.width,
                height: piece.height,
                backgroundColor: palette[piece.color],
                opacity: burst.interpolate({ inputRange: [0, 0.08, 0.7, 1], outputRange: [0, 1, 1, 0] }),
                transform: [
                  { translateX: burst.interpolate({ inputRange: FLIGHT_STOPS, outputRange: confettiSpread(piece.x) }) },
                  { translateY: burst.interpolate({ inputRange: FLIGHT_STOPS, outputRange: confettiFlight(piece) }) },
                  { rotate: burst.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${piece.spin}deg`] }) },
                ],
              }]}
            />
          ))}
        </View>
        <Animated.View style={[styles.badge, { transform: [{ scale: pop }] }]}
          accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <PrimaryButtonBackground shape={{ borderRadius: styles.badge.borderRadius }} />
          <Svg style={styles.check} width={44} height={44} viewBox="0 0 24 24" fill="none" stroke={primaryGradient.foreground}
            strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" focusable={false} aria-hidden>
            <Path d="M5 12.5l4.5 4.5L19 7.5" />
          </Svg>
        </Animated.View>
        <Text style={styles.title} accessibilityRole="header" testID="quest-guide-celebration-title">{title}</Text>
        {summary ? <Text style={styles.summary}>{summary}</Text> : null}
        <Text style={styles.note}>{QUEST_GUIDE_COPY.celebrationNote}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  scrim: { zIndex: 20, elevation: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  center: { width: '100%', maxWidth: 420, alignItems: 'center', gap: 10 },
  burstOrigin: { position: 'absolute', top: 44, left: '50%', width: 0, height: 0 },
  piece: { position: 'absolute', left: -4, top: -6, borderRadius: 2 },
  badge: {
    width: 88,
    height: 88,
    borderRadius: 44,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
    backgroundColor: primaryGradient.colors[0],
  },
  // Above the absolutely positioned gradient on Web, like Wallet's icons.
  check: { position: 'relative' },
  title: { fontSize: 24, lineHeight: 32, fontWeight: '800', textAlign: 'center', color: semantic.text },
  summary: { fontSize: 16, lineHeight: 24, fontWeight: '600', textAlign: 'center', color: semantic.secondary },
  note: { fontSize: 14, lineHeight: 21, textAlign: 'center', color: semantic.muted },
});
