import type { AppearanceMode } from '../../theme/appearance';
import type { HomeTier } from './tierPresentation';

/*
 * The spotlight on 내 순위's tier emblem (TierCardStage) as plain numbers:
 * each tier's light, where every layer sits around the emblem as it is seen,
 * the motion curves, and when the entrance plays. Lengths are the mock-up's
 * px (a 358-wide card around a 132 emblem); the card scales them by
 * k = emblem size / 132.
 */

/** The mock-up's emblem side, in its px. */
export const STAGE_EMBLEM = 132;

type Rgb = readonly [number, number, number];

const TINTS: Record<HomeTier, Rgb> = {
  bronze: [255, 214, 170], silver: [236, 246, 255], gold: [255, 232, 150],
  platinum: [190, 255, 240], diamond: [196, 226, 255], whale: [255, 232, 160],
};

// Only the top three tiers float; one cycle each, in ms.
const BOB_PERIOD: Partial<Record<HomeTier, number>> = { platinum: 4600, diamond: 4600, whale: 5500 };

export type StageLook = {
  tier: HomeTier;
  /** The light's color. */
  tint: Rgb;
  /** Dark surfaces (Dark, and Whale's navy art in both modes): a slightly weaker floor glow. */
  heavy: boolean;
  /** One float cycle in ms, or null when the emblem stays still. */
  bobPeriod: number | null;
};

/** A Home tier id (master is already whale); anything else has no spotlight. */
export function stageLook(tier: string | null | undefined, mode: AppearanceMode): StageLook | null {
  if (!tier || !Object.hasOwn(TINTS, tier)) return null;
  const id = tier as HomeTier;
  return { tier: id, tint: TINTS[id], heavy: mode === 'dark' || id === 'whale', bobPeriod: BOB_PERIOD[id] ?? null };
}

export function rgba([r, g, b]: Rgb, alpha: number) {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The tint taken most of the way to white: the landing flash. */
export function flashTint([r, g, b]: Rgb): Rgb {
  const toWhite = (value: number) => Math.round(value + (255 - value) * 0.75);
  return [toWhite(r), toWhite(g), toWhite(b)];
}

/**
 * The beam's vertical gradient, [offset, alpha] from its top. The mock-up
 * screens the light onto the art; plain alpha brightens a light surface less,
 * so light surfaces start 0.1 higher (measured against the mock-up).
 */
export function beamStops(look: StageLook) {
  return [[0, look.heavy ? 0.78 : 0.88], [0.52, 0.3], [1, 0]] as const;
}
/**
 * The beam's trapezoid in a 0–100 box: narrow at the card's top (38–62%), full
 * width at its end. `extension` (in % of its length) continues the sides
 * above the card's top, where the card clips them.
 */
export function beamPoints(extension = 0) {
  const top = 38 + 0.38 * extension;
  return `${top},${-extension} ${100 - top},${-extension} 100,100 0,100`;
}
/** The floor glow's center alpha; it is transparent from 70% of the CSS farthest-corner radius. */
export const floorAlpha = (look: StageLook) => (look.heavy ? 0.7 : 0.85);
/** Floor glow opacity while still (reduced motion): the middle of its pulse. */
export const STILL_FLOOR_OPACITY = 0.875;

/** Offsets from the emblem center to each particle's center, its dot, drift, cycle and first delay. */
export const PARTICLES = [
  { x: -30, y: 64, size: 3, dx: 10, period: 6500, delay: 0 },
  { x: 10, y: 74, size: 2, dx: -12, period: 7500, delay: 1300 },
  { x: 40, y: 54, size: 3, dx: 8, period: 6000, delay: 2400 },
  { x: -10, y: 84, size: 2, dx: -6, period: 8000, delay: 3100 },
  { x: 60, y: 79, size: 2, dx: -14, period: 7000, delay: 4200 },
  { x: -50, y: 74, size: 2, dx: 14, period: 7200, delay: 5000 },
  { x: 20, y: 44, size: 3, dx: 6, period: 6800, delay: 700 },
  { x: 75, y: 59, size: 2, dx: -8, period: 8200, delay: 2900 },
  { x: -70, y: 64, size: 2, dx: 10, period: 7800, delay: 4700 },
] as const;

export const STAGE_TIMING = {
  /** The beam swings one way in this long, then back. */
  sway: 7000,
  pulse: 4500,
  drop: 850,
  ringDelay: 380,
  ring: 900,
  flash: 900,
} as const;

/** The beam swings this far each way (in degrees), about the emblem's center. */
export const SWAY_DEGREES = 3.5;

/** A size, as onLayout reports it. */
export type Size = { width: number; height: number };

/** The card as TierCard lays it out: its size and the paddings it renders. */
export type StageCard = Size & { padding: { horizontal: number; top: number; bottom: number } };

/**
 * Where TierCard's flex layout puts the emblem slot, from the card's top-left:
 * at the top of the emblem column, centered across it. Side by side the column
 * ends at the right padding and is centered between the top and bottom
 * paddings; stacked (large text) it is the first row, at the top padding.
 *
 * Only sizes go in, and every platform reports a size whenever it changes. A
 * view's onLayout x/y is not used: RN-Web measures a view only when its size
 * changes (ResizeObserver), so a column the card moved without resizing it
 * kept an old place, and the light stood beside the emblem.
 */
export function emblemSlot(card: StageCard, column: Size, slotWidth: number, stacked: boolean) {
  const { horizontal, top, bottom } = card.padding;
  const left = stacked ? horizontal : card.width - horizontal - column.width;
  return {
    left: left + (column.width - slotWidth) / 2,
    top: stacked ? top : top + (card.height - top - bottom - column.height) / 2,
  };
}

/** The emblem as it is seen, in the card's coordinates: every layer is placed from this one anchor. */
export type StageAnchor = {
  /** The center of the visible silhouette (its alpha bounds), not of the slot or of the image's canvas. */
  cx: number;
  cy: number;
  /** Where the silhouette ends. */
  bottom: number;
};

/** The anchor from the slot's place in the card and the silhouette's edges in the slot (TierEmblem's geometry). */
export function stageAnchor(slot: { left: number; top: number }, visible: { left: number; top: number; right: number; bottom: number }): StageAnchor {
  return { cx: slot.left + (visible.left + visible.right) / 2, cy: slot.top + (visible.top + visible.bottom) / 2, bottom: slot.top + visible.bottom };
}

type Box = { left: number; top: number; width: number; height: number };

type Keys = [number, number, number, number];

/** The emblem's own motion at `emblemSize`: the float, and the drop's keyframes (y from rest, scale, opacity). */
export function stageMotion(emblemSize: number) {
  const k = emblemSize / STAGE_EMBLEM;
  return {
    k,
    bob: { lift: 6 * k, tilt: 1.2 },
    drop: { y: [-96 * k, 6 * k, -5 * k, 0] as Keys, scale: [1.25, 0.97, 1.01, 1] as Keys, opacity: [0, 1, 1, 1] as Keys },
  };
}

export type StageGeometry = ReturnType<typeof stageMotion> & {
  /**
   * Its box starts `over` above the card's top and runs `length` into the card
   * (the trapezoid and the gradient span that length). It swings about
   * `origin` (from the box's top-left), the emblem's center.
   */
  beam: { left: number; width: number; over: number; length: number; origin: [number, number] };
  /** The floor glow, and the landing ring on the same ellipse. */
  floor: Box;
  ringStroke: number;
  /** Each particle's square (its soft halo) around the dot, and its rise. */
  particles: Array<{ left: number; top: number; size: number; dot: number; dx: number; rise: number; period: number; delay: number }>;
};

/** A particle's square: room for its soft halo around the dot. */
const HALO = 4;

/**
 * Every layer in the card's coordinates, from the anchor. Side by side the
 * beam runs the card's whole height (`cardHeight`); with the emblem above the
 * information (large text) it stops 0.6 emblem below the emblem's visible
 * bottom. Swinging about the emblem's center turns the beam's top edge, so the
 * box starts far enough above the card that the edge's low corner still
 * reaches the card's top; the card clips the rest.
 */
export function stageGeometry(emblemSize: number, anchor: StageAnchor, stacked: boolean, cardHeight: number): StageGeometry {
  const motion = stageMotion(emblemSize), k = motion.k;
  const width = 260 * k, angle = SWAY_DEGREES * Math.PI / 180;
  // The top edge's half width at the card's top is 12% of the beam (38–62%).
  const over = Math.ceil((anchor.cy * (1 - Math.cos(angle)) + 0.12 * width * Math.sin(angle)) / Math.cos(angle)) + 1;
  const floorY = anchor.bottom - 8 * k;
  return {
    ...motion,
    beam: {
      left: anchor.cx - width / 2, width, over,
      length: stacked ? anchor.bottom + 0.6 * emblemSize : cardHeight,
      origin: [width / 2, over + anchor.cy],
    },
    floor: { left: anchor.cx - 90 * k, top: floorY - 13 * k, width: 180 * k, height: 26 * k },
    ringStroke: 2 * k,
    particles: PARTICLES.map((particle) => {
      const size = particle.size * HALO * k;
      return {
        left: anchor.cx + particle.x * k - size / 2, top: anchor.cy + particle.y * k - size / 2, size,
        dot: particle.size * k, dx: particle.dx * k, rise: 120 * k, period: particle.period, delay: particle.delay,
      };
    }),
  };
}

/** CSS cubic-bezier(x1, y1, x2, y2) as an easing function. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const x = (u: number) => ((ax * u + bx) * u + cx) * u;
  const y = (u: number) => ((ay * u + by) * u + cy) * u;
  const slope = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 8; i++) {
      const error = x(u) - t;
      if (Math.abs(error) < 1e-7) return y(u);
      const d = slope(u);
      if (Math.abs(d) < 1e-6) break;
      u -= error / d;
    }
    // Newton stalls where the curve is flat: bisect instead.
    let low = 0, high = 1;
    u = t;
    while (high - low > 1e-7) {
      if (x(u) < t) low = u; else high = u;
      u = (low + high) / 2;
    }
    return y(u);
  };
}

export const LINEAR = (t: number) => t;
/** CSS `ease-in-out` and `ease-out`, and the drop's curve. */
export const EASE_IN_OUT = cubicBezier(0.42, 0, 0.58, 1);
export const EASE_OUT = cubicBezier(0, 0, 0.58, 1);
export const DROP_EASE = cubicBezier(0.3, 0.9, 0.4, 1);

/** The drop's keyframe times (0.85 s): it overshoots below rest, rebounds, settles. */
export const DROP_KEYS = [0, 0.52, 0.72, 1] as const;

/**
 * The drop's timing curve over keyframe indexes 0–3, as a fraction of 3: CSS
 * eases each keyframe segment on its own, so one timing to 3 eased by this
 * crosses each index at its keyframe time.
 */
export function dropEasing(t: number) {
  if (t >= 1) return 1;
  const segment = Math.max(0, DROP_KEYS.findIndex((key, index) => index > 0 && t < key) - 1);
  const start = DROP_KEYS[segment], end = DROP_KEYS[segment + 1];
  return (segment + DROP_EASE((Math.max(0, t) - start) / (end - start))) / 3;
}

export type Curve = { inputRange: number[]; outputRange: number[] };

/**
 * CSS keyframes over a 0–1 phase, eased segment by segment, as points a linear
 * interpolation (which the native driver runs) passes through. Flat segments
 * need no samples.
 */
export function keyframeCurve(stops: ReadonlyArray<readonly [number, number]>, ease: (t: number) => number, samples = 16): Curve {
  const inputRange = [stops[0][0]], outputRange = [stops[0][1]];
  for (let index = 1; index < stops.length; index++) {
    const [start, from] = stops[index - 1], [end, to] = stops[index];
    const steps = from === to || ease === LINEAR ? 1 : samples;
    for (let step = 1; step <= steps; step++) {
      inputRange.push(start + (end - start) * step / steps);
      outputRange.push(from + (to - from) * ease(step / steps));
    }
  }
  return { inputRange, outputRange };
}

/** A there-and-back cycle: rest → `peak` at half time → rest, ease-in-out each way. */
export const swing = (rest: number, peak: number) => keyframeCurve([[0, rest], [0.5, peak], [1, rest]], EASE_IN_OUT);

export const SWAY_CURVE = swing(-SWAY_DEGREES, SWAY_DEGREES);
export const PARTICLE_OPACITY = keyframeCurve([[0, 0], [0.15, 0.95], [0.8, 0.5], [1, 0]], LINEAR);

/**
 * Where a looping layer is `elapsed` ms after the loops began: still in its
 * first delay (only the first cycle waits), or partway through a cycle.
 */
export function loopPosition(elapsed: number, period: number, delay = 0) {
  if (elapsed < delay) return { wait: delay - elapsed, phase: 0 };
  return { wait: 0, phase: ((elapsed - delay) % period) / period };
}

/*
 * When the entrance plays. The memory lives for the app process: remounts,
 * refocus, Light/Dark and font changes find the tier already presented.
 */
type Presented = { tier: HomeTier; context: string };
let presented: Presented | null = null;

/**
 * `play`: the first presentation in this process, or the tier changed within
 * the same data selection. `silent`: the selection changed (another season,
 * daily → final, another participant), so only remember the new tier.
 * `none`: this tier is already presented.
 */
export function entranceDecision(tier: HomeTier, context: string): 'play' | 'silent' | 'none' {
  if (!presented) return 'play';
  if (presented.context !== context) return 'silent';
  return presented.tier === tier ? 'none' : 'play';
}

/** Record the presented tier: when its entrance actually starts, or silently. */
export function rememberPresented(tier: HomeTier, context: string) {
  presented = { tier, context };
}

/** Tests only: a fresh app process. */
export function resetPresentedTier() {
  presented = null;
}
