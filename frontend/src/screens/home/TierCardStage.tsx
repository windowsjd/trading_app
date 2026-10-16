import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Svg, { Circle, Defs, Ellipse, LinearGradient, Polygon, RadialGradient, Stop } from 'react-native-svg';
import { Animated, Platform, View, type LayoutChangeEvent } from '../../theme/native';
import type { AppearanceMode } from '../../theme/appearance';
import { useReducedMotion, useReducedMotionSettled } from '../../theme/useReducedMotion';
import { tierEmblemVisibleBox, tierEmblemWidth } from './TierEmblem';
import type { HomeTier } from './tierPresentation';
import {
  EASE_OUT, LINEAR, PARTICLES, PARTICLE_OPACITY, STAGE_TIMING, STILL_FLOOR_OPACITY, SWAY_CURVE,
  beamPoints, beamStops, dropEasing, emblemSlot, entranceDecision, flashTint, floorAlpha, loopPosition, rememberPresented, rgba, stageAnchor,
  stageGeometry, stageMotion, stageLook, swing, type Curve, type Size, type StageCard, type StageGeometry, type StageLook,
} from './tierStage';

/** 내 순위 turns the spotlight on for its card. */
export type TierSpotlight = {
  /**
   * The data selection the tier was read under. A tier change within one
   * selection replays the entrance; a new selection only remembers its tier.
   */
  context: string;
  /** Off screen (the tab lost focus): the loops stop and an owed entrance waits. */
  paused: boolean;
};

type Values = {
  ring: Animated.Value; flash: Animated.Value;
  sway: Animated.Value; pulse: Animated.Value; bob: Animated.Value;
  particles: Animated.Value[];
};

type EmblemTransform =
  | { translateY: Animated.AnimatedInterpolation<number> }
  | { scale: Animated.AnimatedInterpolation<number> }
  | { rotate: Animated.AnimatedInterpolation<string> };

export type TierStage = {
  look: StageLook;
  /** Loops and the entrance may run: the OS setting is known and allows motion. */
  motion: boolean;
  /** The entrance is running: its flash and ring are drawn. */
  entering: boolean;
  /** Null until the card and the emblem column have been measured. */
  geometry: StageGeometry | null;
  values: Values;
  /** The emblem's own motion: the drop and, for the top tiers, the float. */
  emblemStyle: { opacity: Animated.AnimatedInterpolation<number>; transform: EmblemTransform[] };
  /** The card's size, from the stage's own root (the card's box, without its padding in the way). */
  onCardLayout: (event: LayoutChangeEvent) => void;
  /** The emblem column's size (its place follows from the card's layout). */
  onColumnLayout: (event: LayoutChangeEvent) => void;
};

const HIDDEN = {
  accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', 'aria-hidden': true,
} as const;

const degrees = ({ inputRange, outputRange }: Curve) => ({ inputRange, outputRange: outputRange.map((value) => `${value}deg`) });

/**
 * Runs `value` from 0 to 1 every `period` ms, picking up `elapsed` ms into the
 * loops (a first delay is waited only once), so a pause resumes where it stopped.
 */
function runLoop(value: Animated.Value, period: number, delay: number, elapsed: number, native: boolean) {
  const { wait, phase } = loopPosition(elapsed, period, delay);
  const config = { toValue: 1, easing: LINEAR, useNativeDriver: native, isInteraction: false };
  let stopped = false;
  value.setValue(phase);
  let animation = Animated.timing(value, { ...config, duration: (1 - phase) * period, delay: wait });
  animation.start(({ finished }) => {
    if (!finished || stopped) return;
    // A native loop starts from the current value.
    value.setValue(0);
    animation = Animated.loop(Animated.timing(value, { ...config, duration: period }));
    animation.start();
  });
  return () => { stopped = true; animation.stop(); };
}

/** A size from onLayout, kept only when it changed. */
function useSize() {
  const [size, setSize] = useState<Size | null>(null);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) => (previous?.width === width && previous.height === height ? previous : { width, height }));
  }, []);
  return [size, onLayout] as const;
}

/**
 * The spotlight's motion and measurements for TierCard. Null input turns it
 * off (the card renders as before). The drop's first frame is decided before
 * paint: an owed entrance starts hidden, never from the rest pose. `padding`
 * is what TierCard renders.
 */
export function useTierStage(input: {
  tier: HomeTier; mode: AppearanceMode; emblemSize: number; stacked: boolean; spotlight: TierSpotlight; padding: StageCard['padding'];
} | null): TierStage | null {
  const reduced = useReducedMotion();
  const settled = useReducedMotionSettled();
  const look = input ? stageLook(input.tier, input.mode) : null;
  const tier = look?.tier ?? null;
  const context = input?.spotlight.context ?? '';
  const paused = input?.spotlight.paused ?? true;
  const emblemSize = input?.emblemSize ?? 0;
  const stacked = input?.stacked ?? false;
  const bobPeriod = look?.bobPeriod ?? null;
  const motion = settled && !reduced;
  const native = Platform.OS !== 'web';

  // Until the OS says reduced motion, a tier that owes its entrance is hidden at the drop's start.
  const owes = () => tier !== null && entranceDecision(tier, context) === 'play' && !(settled && reduced);
  const [emblem, setEmblem] = useState(() => ({ tier, drop: new Animated.Value(owes() ? 0 : 3) }));
  if (emblem.tier !== tier) setEmblem({ tier, drop: new Animated.Value(owes() ? 0 : 3) });
  const drop = emblem.drop;
  const [values] = useState<Values>(() => ({
    ring: new Animated.Value(1), flash: new Animated.Value(1),
    sway: new Animated.Value(0), pulse: new Animated.Value(0), bob: new Animated.Value(0),
    particles: PARTICLES.map(() => new Animated.Value(0)),
  }));

  // The tier whose entrance runs (set as its memory is consumed).
  const [entrance, setEntrance] = useState<HomeTier | null>(null);
  useEffect(() => {
    if (!tier) return;
    const decision = entranceDecision(tier, context);
    if (decision === 'silent') { rememberPresented(tier, context); return; }
    if (decision !== 'play' || !settled) return;
    if (reduced) { drop.setValue(3); return; }
    if (paused) return;
    rememberPresented(tier, context);
    setEntrance(tier);
  }, [context, drop, paused, reduced, settled, tier]);

  const entering = entrance !== null && entrance === tier && motion && !paused;
  useEffect(() => {
    if (!entering) return;
    const timing = (value: Animated.Value, config: Omit<Animated.TimingAnimationConfig, 'useNativeDriver'>) =>
      Animated.timing(value, { ...config, useNativeDriver: native, isInteraction: false });
    drop.setValue(0); values.ring.setValue(0); values.flash.setValue(0);
    const ring = timing(values.ring, { toValue: 1, duration: STAGE_TIMING.ring, delay: STAGE_TIMING.ringDelay, easing: EASE_OUT });
    const animations = [
      timing(drop, { toValue: 3, duration: STAGE_TIMING.drop, easing: dropEasing }),
      timing(values.flash, { toValue: 1, duration: STAGE_TIMING.flash, easing: EASE_OUT }),
      ring,
    ];
    animations.forEach((animation) => animation.start(animation === ring
      ? ({ finished }) => { if (finished) setEntrance(null); } : undefined));
    // Interrupted (paused, reduced, another tier): settle at once; it is not replayed.
    return () => {
      animations.forEach((animation) => animation.stop());
      drop.setValue(3); values.ring.setValue(1); values.flash.setValue(1);
      setEntrance(null);
    };
  }, [drop, entering, native, values]);

  // Loop time survives pauses; another tier starts its loops from the beginning.
  const clock = useRef<{ tier: HomeTier | null; elapsed: number }>({ tier: null, elapsed: 0 });
  useEffect(() => {
    if (!tier || !motion || paused) return;
    if (clock.current.tier !== tier) clock.current = { tier, elapsed: 0 };
    const run = clock.current;
    const started = performance.now();
    const stops = [
      runLoop(values.sway, STAGE_TIMING.sway * 2, 0, run.elapsed, native),
      runLoop(values.pulse, STAGE_TIMING.pulse, 0, run.elapsed, native),
      ...(bobPeriod ? [runLoop(values.bob, bobPeriod, 0, run.elapsed, native)] : []),
      ...PARTICLES.map((particle, index) => runLoop(values.particles[index], particle.period, particle.delay, run.elapsed, native)),
    ];
    return () => {
      stops.forEach((stop) => stop());
      run.elapsed += performance.now() - started;
    };
  }, [bobPeriod, motion, native, paused, tier, values]);

  // Sizes only: RN-Web reports a view when its content box resizes (ResizeObserver), so its x/y can
  // be an old place, and the card itself is not reported when only its padding grows. The stage's
  // root covers the card with no padding of its own: every card size reaches it.
  const [card, onCardLayout] = useSize();
  const [column, onColumnLayout] = useSize();
  const { horizontal = 0, top = 0, bottom = 0 } = input?.padding ?? {};
  const geometry = useMemo(() => {
    if (!tier || !card || !column) return null;
    // One anchor, the emblem as it is seen: the slot's place from the card's layout,
    // then the silhouette inside the slot from TierEmblem's own geometry.
    const slot = emblemSlot({ ...card, padding: { horizontal, top, bottom } }, column, tierEmblemWidth(tier, emblemSize), stacked);
    return stageGeometry(emblemSize, stageAnchor(slot, tierEmblemVisibleBox(tier, emblemSize)), stacked, card.height);
  }, [bottom, card, column, emblemSize, horizontal, stacked, tier, top]);

  const emblemStyle = useMemo(() => {
    const { drop: keys, bob } = stageMotion(emblemSize);
    const at = (outputRange: readonly number[]) => drop.interpolate({ inputRange: [0, 1, 2, 3], outputRange: [...outputRange] });
    const transform: EmblemTransform[] = [{ translateY: at(keys.y) }, { scale: at(keys.scale) }];
    if (motion && bobPeriod) {
      transform.push({ translateY: values.bob.interpolate(swing(0, -bob.lift)) }, { rotate: values.bob.interpolate(degrees(swing(0, bob.tilt))) });
    }
    return { opacity: at(keys.opacity), transform };
  }, [bobPeriod, drop, emblemSize, motion, values.bob]);

  if (!look) return null;
  return { look, motion, entering, geometry, values, onCardLayout, onColumnLayout, emblemStyle };
}

/**
 * The light around the emblem, under the emblem and the card's text: a beam
 * from the card's top swaying about the emblem's center (with the landing
 * flash), the floor glow the emblem stands on, the landing ring and rising
 * particles, all placed from one anchor (the emblem as it is seen). Decoration
 * only: no touches, hidden from screen readers. Reduced motion keeps a still
 * beam and floor glow.
 */
export default function TierCardStage({ stage }: { stage: TierStage }) {
  const id = `tier-stage-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { look, motion, entering, geometry, values } = stage;
  const animated = useMemo(() => geometry && ({
    sway: values.sway.interpolate(degrees(SWAY_CURVE)),
    flash: values.flash.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
    floorOpacity: values.pulse.interpolate(swing(0.75, 1)),
    floorScale: values.pulse.interpolate(swing(1, 1.08)),
    ringScale: values.ring.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1.7] }),
    ringOpacity: values.ring.interpolate({ inputRange: [0, 1], outputRange: [0.95, 0] }),
    particles: geometry.particles.map((particle, index) => ({
      opacity: values.particles[index].interpolate(PARTICLE_OPACITY),
      translateX: values.particles[index].interpolate({ inputRange: [0, 1], outputRange: [0, particle.dx] }),
      translateY: values.particles[index].interpolate({ inputRange: [0, 1], outputRange: [0, -particle.rise] }),
    })),
  }), [geometry, values]);
  // The root covers the card and measures it; the layers wait for the card and the emblem column.
  const root = (layers?: React.ReactNode) => (
    <View testID="tier-stage" pointerEvents="none" {...HIDDEN} onLayout={stage.onCardLayout} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
      {layers}
    </View>
  );
  if (!geometry || !animated) return root();

  const { beam, floor, ringStroke } = geometry;
  const tint = rgba(look.tint, 1);
  // The box's 0–100 runs the beam's length in the card; the part above the card's top is negative.
  const extension = beam.over / beam.length * 100;
  const beamFill = (gradient: string, color: string) => (
    <Svg width="100%" height="100%" viewBox={`0 ${-extension} 100 ${100 + extension}`} preserveAspectRatio="none">
      <Defs>
        {/* In the card's span: the top's color continues above the card's top. */}
        <LinearGradient id={gradient} x1="0" y1="0" x2="0" y2="100" gradientUnits="userSpaceOnUse">
          {beamStops(look).map(([offset, alpha]) => <Stop key={offset} offset={offset} stopColor={color} stopOpacity={alpha} />)}
        </LinearGradient>
      </Defs>
      <Polygon points={beamPoints(extension)} fill={`url(#${gradient})`} />
    </Svg>
  );
  return root(
    <>
      <Animated.View testID="tier-stage-beam" style={{
        position: 'absolute', left: beam.left, top: -beam.over, width: beam.width, height: beam.over + beam.length,
        transformOrigin: [...beam.origin, 0], transform: [{ rotate: motion ? animated.sway : '0deg' }],
      }}>
        {beamFill(`${id}-beam`, tint)}
        {entering ? (
          <Animated.View testID="tier-stage-flash" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, opacity: animated.flash }}>
            {beamFill(`${id}-flash`, rgba(flashTint(look.tint), 1))}
          </Animated.View>
        ) : null}
      </Animated.View>
      <Animated.View testID="tier-stage-floor" style={{
        position: 'absolute', ...floor,
        opacity: motion ? animated.floorOpacity : STILL_FLOOR_OPACITY, transform: [{ scaleX: motion ? animated.floorScale : 1 }],
      }}>
        <Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
          <Defs>
            {/* CSS radial-gradient(ellipse, tint 0%, transparent 70%): the 100% radius reaches the box's corners. */}
            <RadialGradient id={`${id}-floor`} cx="0.5" cy="0.5" r={Math.SQRT1_2} fx="0.5" fy="0.5">
              <Stop offset="0" stopColor={tint} stopOpacity={floorAlpha(look)} />
              <Stop offset="0.7" stopColor={tint} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Ellipse cx="50" cy="50" rx="50" ry="50" fill={`url(#${id}-floor)`} />
        </Svg>
      </Animated.View>
      {entering ? (
        <Animated.View testID="tier-stage-ring" style={{
          position: 'absolute', ...floor, opacity: animated.ringOpacity, transform: [{ scale: animated.ringScale }],
        }}>
          <Svg width="100%" height="100%" viewBox={`0 0 ${floor.width} ${floor.height}`}>
            <Ellipse cx={floor.width / 2} cy={floor.height / 2} rx={(floor.width - ringStroke) / 2} ry={(floor.height - ringStroke) / 2}
              fill="none" stroke={tint} strokeOpacity={0.9} strokeWidth={ringStroke} />
          </Svg>
        </Animated.View>
      ) : null}
      {motion ? geometry.particles.map((particle, index) => (
        <Animated.View key={index} testID="tier-stage-particle" style={{
          position: 'absolute', left: particle.left, top: particle.top, width: particle.size, height: particle.size,
          opacity: animated.particles[index].opacity,
          transform: [{ translateX: animated.particles[index].translateX }, { translateY: animated.particles[index].translateY }],
        }}>
          <Svg width="100%" height="100%" viewBox="0 0 8 8">
            <Defs>
              <RadialGradient id={`${id}-particle-${index}`} cx="0.5" cy="0.5" r="0.5">
                <Stop offset="0" stopColor={tint} stopOpacity={0.55} />
                <Stop offset="1" stopColor={tint} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Circle cx="4" cy="4" r="4" fill={`url(#${id}-particle-${index})`} />
            <Circle cx="4" cy="4" r="1" fill="#ffffff" />
          </Svg>
        </Animated.View>
      )) : null}
    </>,
  );
}
