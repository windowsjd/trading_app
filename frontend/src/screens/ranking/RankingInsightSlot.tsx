import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Platform,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from '../../theme/native';
import ActionPressable from '../../components/common/ActionPressable';
import { semantic } from '../../theme/tokens';
import { useAppearance, type AppearanceMode } from '../../theme/appearance';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { getFinancialColors, type FinancialColorPreference } from '../../theme/financialColors';
import {
  describeRankingInsights,
  type RankingInsight,
  type RankingInsightKey,
} from '../../features/ranking/rankingInsights';
import { getHomeTier } from '../home/tierPresentation';

/** How long a message stays after it has entered. */
export const RANKING_SLOT_DWELL_MS = 4000;
/** Fade + slight lift: out, a blank beat, in. Reduced Motion fades only. */
export const RANKING_SLOT_MOTION = { exitMs: 180, gapMs: 40, enterMs: 260, reducedMs: 120, shift: 8 } as const;
const easeInQuad = (t: number) => t * t;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

type Phase = 'rest' | 'exit' | 'gap' | 'enter';
const HIDDEN = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;
// Each dot's hit rect is 24 tall: its 12 px box plus 12 below. A later sibling
// takes touches in its own box first, so taps still land on the nearest dot;
// the slop only reaches past the first and last dots.
const DOT_SLOP = { top: 0, bottom: 12, left: 0, right: 0 };
const FIRST_DOT_SLOP = { ...DOT_SLOP, top: 12 };

const nextKey = (messages: readonly RankingInsight[], key: RankingInsightKey) =>
  messages[(messages.findIndex((message) => message.key === key) + 1) % messages.length].key;

/**
 * 순위 안내 between 내 순위 and the ranking tabs. One message is shown at a
 * time and the next one replaces it every few seconds; a single message stays
 * still. Screen readers get every message at once from the card, never the
 * rotation. Amounts are plain text (no number rolling).
 */
export default function RankingInsightSlot({ messages, paused }: {
  messages: RankingInsight[];
  /** Screen not focused: the shown message stays and the clock stops. */
  paused: boolean;
}) {
  return messages.length ? <SlotCard messages={messages} paused={paused} /> : null;
}

/** Foreground state, followed only while there is something to rotate. */
function useForeground(enabled: boolean) {
  const [foreground, setForeground] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    setForeground(AppState.currentState == null || AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => subscription.remove();
  }, [enabled]);
  return foreground;
}

function SlotCard({ messages, paused }: { messages: RankingInsight[]; paused: boolean }) {
  const { mode, financialPreference } = useAppearance();
  const reduced = useReducedMotion();
  const rotating = messages.length > 1;
  const foreground = useForeground(rotating);
  const running = rotating && !paused && foreground;
  const native = Platform.OS !== 'web';

  const [activeKey, setActiveKey] = useState(messages[0].key);
  const [phase, setPhase] = useState<Phase>('rest');
  // Bumped when the message is replaced without a transition: the dwell restarts.
  const [cycle, setCycle] = useState(0);
  const [heights, setHeights] = useState<Partial<Record<RankingInsightKey, number>>>({});
  const opacity = useRef(new Animated.Value(1)).current;
  const offset = useRef(new Animated.Value(0)).current;
  const phaseRef = useRef<Phase>('rest');
  const target = useRef<RankingInsightKey>(activeKey);
  const shown = messages.find((message) => message.key === activeKey) ?? messages[0];
  // Callbacks fired by timers read the latest render.
  const latest = useRef({ messages, shown: shown.key, reduced });
  useEffect(() => { latest.current = { messages, shown: shown.key, reduced }; });

  const go = (next: Phase) => { phaseRef.current = next; setPhase(next); };
  // Input during a transition (exit → blank → enter) is ignored.
  const begin = (key: RankingInsightKey) => {
    if (phaseRef.current !== 'rest' || key === latest.current.shown) return;
    target.current = key;
    go('exit');
  };

  // Dwell, then move on. A pause, a manual move or a replaced message starts a fresh dwell.
  useEffect(() => {
    if (phase !== 'rest' || !running) return;
    const timer = setTimeout(() => begin(nextKey(latest.current.messages, latest.current.shown)), RANKING_SLOT_DWELL_MS);
    return () => clearTimeout(timer);
    // `begin` only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, running, cycle]);

  useEffect(() => {
    if (phase === 'gap') {
      const timer = setTimeout(() => {
        // The target may have left with a refresh meanwhile.
        const { messages: current, shown: from } = latest.current;
        setActiveKey(current.some((message) => message.key === target.current) ? target.current : nextKey(current, from));
        go('enter');
      }, RANKING_SLOT_MOTION.gapMs);
      return () => clearTimeout(timer);
    }
    if (phase !== 'exit' && phase !== 'enter') return;
    const entering = phase === 'enter';
    const still = latest.current.reduced;
    const duration = still ? RANKING_SLOT_MOTION.reducedMs : entering ? RANKING_SLOT_MOTION.enterMs : RANKING_SLOT_MOTION.exitMs;
    const timing = (value: Animated.Value, toValue: number) => Animated.timing(value, {
      toValue, duration, easing: entering ? easeOutCubic : easeInQuad, useNativeDriver: native, isInteraction: false,
    });
    if (entering && !still) offset.setValue(RANKING_SLOT_MOTION.shift);
    const animations = [
      timing(opacity, entering ? 1 : 0),
      ...(still ? [] : [timing(offset, entering ? 0 : -RANKING_SLOT_MOTION.shift)]),
    ];
    let done = false;
    animations[0].start(({ finished }) => {
      if (!finished) return;
      done = true;
      go(entering ? 'rest' : 'gap');
    });
    animations.slice(1).forEach((animation) => animation.start());
    return () => { if (!done) animations.forEach((animation) => animation.stop()); };
  }, [phase, native, offset, opacity]);

  // The shown message left with a refresh: show the first one in place.
  useEffect(() => {
    if (messages.some((message) => message.key === activeKey)) return;
    opacity.setValue(1);
    offset.setValue(0);
    setActiveKey(messages[0].key);
    go('rest');
    setCycle((value) => value + 1);
  }, [activeKey, messages, offset, opacity]);

  // The card is as tall as its tallest message, so the list below never moves.
  const measure = (key: RankingInsightKey) => (event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setHeights((current) => (current[key] === height ? current : { ...current, [key]: height }));
  };
  const tallest = Math.max(0, ...messages.map((message) => heights[message.key] ?? 0));

  const stage = (
    <View testID="ranking-slot-stage" style={[styles.stage, tallest > 0 && { minHeight: tallest }]}>
      <Animated.View testID="ranking-slot-message" style={{
        opacity,
        transform: reduced ? [] : [{ translateY: offset }],
      }}>
        <MessageRow message={shown} mode={mode} financialPreference={financialPreference} />
      </Animated.View>
      <View pointerEvents="none" style={styles.measureLayer} {...HIDDEN}>
        {messages.map((message) => (
          <View key={message.key} testID={`ranking-slot-measure-${message.key}`} style={styles.measureItem}
            onLayout={measure(message.key)}>
            <MessageRow message={message} mode={mode} financialPreference={financialPreference} />
          </View>
        ))}
      </View>
    </View>
  );

  return (
    <View testID="ranking-slot" accessible accessibilityLabel={describeRankingInsights(messages)}
      style={[styles.card, rotating && styles.cardWithDots]}>
      {rotating ? (
        <>
          <ActionPressable testID="ranking-slot-next" style={styles.touch} {...HIDDEN}
            onPress={() => begin(nextKey(messages, shown.key))}>
            {stage}
          </ActionPressable>
          <View style={styles.dots} {...HIDDEN}>
            {messages.map((message, index) => (
              <ActionPressable key={message.key} testID={`ranking-slot-dot-${message.key}`} style={styles.dot}
                hitSlop={index === 0 ? FIRST_DOT_SLOP : DOT_SLOP} onPress={() => begin(message.key)}>
                <View style={[styles.dotMark, message.key === shown.key && styles.dotMarkActive]} />
              </ActionPressable>
            ))}
          </View>
        </>
      ) : (
        <View style={styles.touch} {...HIDDEN}>{stage}</View>
      )}
    </View>
  );
}

function MessageRow({ message, mode, financialPreference }: {
  message: RankingInsight;
  mode: AppearanceMode;
  financialPreference?: FinancialColorPreference;
}) {
  const tier = message.key === 'tier' ? getHomeTier(message.tier, mode) : null;
  const direction = message.direction
    ? getFinancialColors(mode, financialPreference)[message.direction === 'up' ? 'rise' : 'fall'] : null;
  return (
    <View style={styles.row}>
      <View style={[styles.glyph, tier && { backgroundColor: tier.palette.backgroundColor }]} {...HIDDEN}>
        <Text maxFontSizeMultiplier={1.2}
          style={[styles.glyphText, tier && { color: tier.palette.color }, direction && { color: direction }]}>
          {message.glyph}
        </Text>
      </View>
      <View style={styles.copy}>
        <Text style={styles.label}>{message.label}</Text>
        <Text style={styles.value}>
          {message.value}
          <Text style={styles.suffix}>{message.suffix}</Text>
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The ranking cards' surface (RankingScreen styles.card); never a tier color.
  card: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    backgroundColor: semantic.surface,
    marginBottom: 12,
  },
  cardWithDots: { paddingRight: 44 },
  touch: { flex: 1, minWidth: 0, justifyContent: 'center', borderRadius: 10 },
  stage: { justifyContent: 'center' },
  measureLayer: { position: 'absolute', top: 0, left: 0, right: 0, opacity: 0 },
  measureItem: { position: 'absolute', top: 0, left: 0, right: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  glyph: {
    width: 32,
    height: 32,
    borderRadius: 16,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: semantic.raised,
  },
  glyphText: { fontSize: 13, lineHeight: 18, fontWeight: '800', color: semantic.text },
  copy: { flex: 1, minWidth: 0 },
  label: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  value: { fontSize: 20, lineHeight: 28, fontWeight: '800', fontVariant: ['tabular-nums'], color: semantic.text },
  suffix: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  // Spans the card's full height (padding included), so it never makes the card taller.
  dots: { position: 'absolute', top: 0, bottom: 0, right: 10, width: 24, justifyContent: 'center' },
  dot: { width: 24, height: 12, alignItems: 'center', justifyContent: 'center' },
  dotMark: { width: 6, height: 6, borderRadius: 3, backgroundColor: semantic.border },
  dotMarkActive: { backgroundColor: semantic.text },
});
