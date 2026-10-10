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
export function buildConfetti(count: number, spread: number): Piece[] {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  return Array.from({ length: count }, (_, index) => {
    const angle = (-165 + (150 * index) / Math.max(1, count - 1) + (random() - 0.5) * 14) * (Math.PI / 180);
    const distance = spread * (0.55 + random() * 0.45);
    return {
      x: Math.cos(angle) * distance,
      peak: Math.sin(angle) * distance * 0.9,
      fall: spread * (0.7 + random() * 0.5),
      spin: (random() > 0.5 ? 1 : -1) * (180 + random() * 360),
      width: 6 + Math.round(random() * 3),
      height: 9 + Math.round(random() * 5),
      color: index % 4,
    };
  });
}

/**
 * A short, one-time "퀘스트 완료!" moment. It only renders after the server
 * proved the quest; it blocks touches so nothing on the practice screen can be
 * pressed while the guide returns to the quest list underneath it.
 */
export default function QuestCelebration({ title, summary, leaving, reducedMotion }: {
  title: string;
  summary: string | null;
  leaving: boolean;
  reducedMotion: boolean;
}) {
  const { colors } = useAppearance();
  const { width } = useWindowDimensions();
  const appear = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  const burst = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(reducedMotion ? 1 : 0.6)).current;
  const native = Platform.OS !== 'web';
  const pieces = useMemo(() => buildConfetti(26, Math.min(190, Math.max(120, width * 0.42))), [width]);
  const palette = [primaryGradient.colors[0], primaryGradient.colors[1], '#F2B705', colors.success];

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
    if (reducedMotion) return;
    const animation = Animated.parallel([
      Animated.timing(burst, { toValue: 1, duration: 1500, easing: Easing.out(Easing.cubic), useNativeDriver: native }),
      Animated.spring(pop, { toValue: 1, friction: 6, tension: 120, useNativeDriver: native }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [burst, native, pop, reducedMotion]);

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
          {reducedMotion ? null : pieces.map((piece, index) => (
            <Animated.View
              key={index}
              testID="quest-confetti-piece"
              style={[styles.piece, {
                width: piece.width,
                height: piece.height,
                backgroundColor: palette[piece.color],
                opacity: burst.interpolate({ inputRange: [0, 0.08, 0.7, 1], outputRange: [0, 1, 1, 0] }),
                transform: [
                  { translateX: burst.interpolate({ inputRange: [0, 1], outputRange: [0, piece.x] }) },
                  { translateY: burst.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, piece.peak, piece.peak + piece.fall] }) },
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
