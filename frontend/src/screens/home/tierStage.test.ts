import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { beforeEach, describe, it, type TestContext } from 'node:test';
import {
  DROP_KEYS, EASE_IN_OUT, EASE_OUT, PARTICLES, PARTICLE_OPACITY, STAGE_EMBLEM, STAGE_TIMING, STILL_FLOOR_OPACITY, SWAY_CURVE,
  beamStops, cubicBezier, dropEasing, entranceDecision, keyframeCurve, loopPosition, rememberPresented, resetPresentedTier,
  stageGeometry, stageLook, stageMotion, swing, type Curve,
} from './tierStage.ts';
import { getHomeTier, type HomeTier } from './tierPresentation.ts';
import { availableRankings } from '../../features/ranking/fixtures.ts';
import type { RankingItemDto } from '../../features/ranking/api.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const preparation = require('../../assets/home-tiers/preparation.json');
const query = require('@tanstack/react-query');

const TIERS: HomeTier[] = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'whale'];
const close = (actual: number, expected: number, digits = 6) => Math.abs(actual - expected) < 10 ** -digits;
/** A curve's value at `phase`, as the linear interpolation the native driver runs. */
const at = ({ inputRange, outputRange }: Curve, phase: number) => {
  const index = inputRange.findIndex((input) => input >= phase);
  if (index <= 0) return outputRange[Math.max(index, 0)];
  const [a, b] = [inputRange[index - 1], inputRange[index]];
  return outputRange[index - 1] + (outputRange[index] - outputRange[index - 1]) * (phase - a) / (b - a);
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
/** A short excerpt where two signatures part, for a readable failure. */
const firstDifference = (a: string, b: string) => {
  let index = 0;
  while (index < a.length && a[index] === b[index]) index++;
  return `at ${index}: …${a.slice(Math.max(0, index - 40), index + 60)}… vs …${b.slice(Math.max(0, index - 40), index + 60)}…`;
};

beforeEach(() => resetPresentedTier());

describe('스포트라이트: 티어별 빛', () => {
  const TINT: Record<HomeTier, [number, number, number]> = {
    bronze: [255, 214, 170], silver: [236, 246, 255], gold: [255, 232, 150],
    platinum: [190, 255, 240], diamond: [196, 226, 255], whale: [255, 232, 160],
  };
  it('six tiers × Light/Dark: the tint, a heavy floor in Dark (and Whale), and the float only for the top three', () => {
    for (const tier of TIERS) for (const mode of ['light', 'dark'] as const) {
      const look = stageLook(tier, mode)!;
      assert.deepEqual(look.tint, TINT[tier], `${tier} ${mode}`);
      assert.equal(look.heavy, mode === 'dark' || tier === 'whale', `${tier} ${mode}`);
      assert.equal(look.bobPeriod, { platinum: 4600, diamond: 4600, whale: 5500 }[tier as string] ?? null, tier);
    }
  });

  it("takes Home's tier id (master is already whale); anything else has no spotlight", () => {
    for (const id of ['master', 'grandmaster', '', null, undefined, 'constructor', '__proto__', 'Gold']) {
      assert.equal(stageLook(id, 'light') === null, true, String(id));
    }
    assert.equal(stageLook(getHomeTier('master', 'dark')?.id, 'dark')?.tier, 'whale');
  });
});

describe('스포트라이트: 빛줄기 그라디언트', () => {
  it('.78 → .3 at 52 % → 0 on dark surfaces (Dark, Whale); light surfaces start at .88 (+.1, plain alpha instead of screen)', () => {
    for (const tier of TIERS) for (const mode of ['light', 'dark'] as const) {
      const heavy = mode === 'dark' || tier === 'whale';
      assert.deepEqual(beamStops(stageLook(tier, mode)!), [[0, heavy ? 0.78 : 0.88], [0.52, 0.3], [1, 0]], `${tier} ${mode}`);
    }
  });
});

describe('스포트라이트: 시안 기하 (카드 폭 358, 엠블럼 132)', () => {
  const frame = { cx: 268, cy: 87, bottom: 150 };

  it('E = 132: beam 260 wide on the emblem from the card top, floor 180×26 centered 8 above the visible bottom', () => {
    const g = stageGeometry(STAGE_EMBLEM, frame, false);
    assert.equal(g.k, 1);
    assert.deepEqual(g.beam, { left: 268 - 130, width: 260, height: null }, 'side by side: the whole card height');
    assert.deepEqual(g.floor, { left: 268 - 90, top: 150 - 8 - 13, width: 180, height: 26 });
    assert.equal(g.floor.top + g.floor.height / 2, frame.bottom - 8);
    assert.equal(g.floor.left + g.floor.width / 2, frame.cx);
    assert.equal(g.ringStroke, 2);
    // Large text puts the emblem above the information: the beam stops 0.6 emblem under it.
    assert.equal(stageGeometry(STAGE_EMBLEM, frame, true).beam.height, 150 + 0.6 * 132);
  });

  it('E = 132: nine particles at their offsets from the emblem center, rising 120 with their drift, cycle and first delay', () => {
    const expected = [[-30, 64, 3, 10, 6500, 0], [10, 74, 2, -12, 7500, 1300], [40, 54, 3, 8, 6000, 2400], [-10, 84, 2, -6, 8000, 3100],
      [60, 79, 2, -14, 7000, 4200], [-50, 74, 2, 14, 7200, 5000], [20, 44, 3, 6, 6800, 700], [75, 59, 2, -8, 8200, 2900], [-70, 64, 2, 10, 7800, 4700]];
    const g = stageGeometry(STAGE_EMBLEM, frame, false);
    assert.equal(g.particles.length, 9);
    for (const [index, [x, y, size, dx, period, delay]] of expected.entries()) {
      const particle = g.particles[index];
      assert.deepEqual([particle.left + particle.size / 2 - frame.cx, particle.top + particle.size / 2 - frame.cy], [x, y], `particle ${index + 1}`);
      assert.deepEqual([particle.dot, particle.dx, particle.rise, particle.period, particle.delay], [size, dx, 120, period, delay], `particle ${index + 1}`);
      assert.equal(particle.size > particle.dot, true, 'room for the halo');
    }
  });

  it('E = 132: the float (6, 1.2°) and the drop (−96 at 1.25×, +6 at .97×, −5 at 1.01×, rest)', () => {
    const { bob, drop } = stageMotion(STAGE_EMBLEM);
    assert.deepEqual(bob, { lift: 6, tilt: 1.2 });
    assert.deepEqual(drop, { y: [-96, 6, -5, 0], scale: [1.25, 0.97, 1.01, 1], opacity: [0, 1, 1, 1] });
    assert.deepEqual(DROP_KEYS, [0, 0.52, 0.72, 1]);
    assert.deepEqual(STAGE_TIMING, { sway: 7000, pulse: 4500, drop: 850, ringDelay: 380, ring: 900, flash: 900 });
  });

  it('E = 124 and 104: every length scales by k = E / 132; times and angles do not', () => {
    const base = stageGeometry(STAGE_EMBLEM, frame, true);
    for (const size of [124, 104]) {
      const k = size / 132;
      const g = stageGeometry(size, frame, true);
      assert.equal(g.k, k);
      assert.equal(close(g.beam.width, 260 * k) && close(g.beam.left, frame.cx - 130 * k), true, `${size} beam`);
      assert.equal(close(g.beam.height!, frame.bottom + 0.6 * size), true, `${size} stacked beam`);
      assert.deepEqual([g.floor.width, g.floor.height, g.ringStroke].map((value) => +value.toFixed(9)), [180 * k, 26 * k, 2 * k].map((value) => +value.toFixed(9)));
      assert.equal(close(g.floor.top + g.floor.height / 2, frame.bottom - 8 * k), true, `${size} floor center`);
      for (const [index, particle] of g.particles.entries()) {
        const source = base.particles[index];
        assert.equal(close(particle.left + particle.size / 2 - frame.cx, PARTICLES[index].x * k)
          && close(particle.top + particle.size / 2 - frame.cy, PARTICLES[index].y * k)
          && close(particle.rise, 120 * k) && close(particle.dx, source.dx * k) && close(particle.dot, source.dot * k), true, `${size} particle ${index}`);
        assert.deepEqual([particle.period, particle.delay], [source.period, source.delay]);
      }
      assert.deepEqual([+g.bob.lift.toFixed(9), g.bob.tilt], [+(6 * k).toFixed(9), 1.2]);
      assert.deepEqual(g.drop.y.map((value) => +value.toFixed(9)), [-96 * k, 6 * k, -5 * k, 0].map((value) => +value.toFixed(9)));
      assert.deepEqual(g.drop.scale, [1.25, 0.97, 1.01, 1]);
    }
  });

  it("the floor's baseline is the emblem's visible bottom (alpha bounds), not its slot's", () => {
    const harness = interactionHarness();
    const { tierEmblemVisibleBottom, EMBLEM_OPTICAL_SCALE } = harness.load('src/screens/home/TierEmblem.tsx');
    for (const tier of TIERS) for (const size of [132, 124, 104]) {
      const asset = preparation[tier];
      const scale = size / 160 * EMBLEM_OPTICAL_SCALE[tier];
      const canvas = asset.imageAt160 ?? { ...asset.displayAt160, top: 0 };
      const expected = (canvas.top + asset.outputMetrics.bounds[3] * canvas.height / asset.outputSize[1]) * scale;
      const bottom = tierEmblemVisibleBottom(tier, size);
      assert.equal(close(bottom, expected, 9), true, `${tier} ${size}`);
      // Inside the slot, close to (not at) its bottom.
      const slot = asset.displayAt160.height * scale;
      assert.equal(bottom < slot && bottom > slot * 0.95, true, `${tier} ${size}: ${bottom} of ${slot}`);
    }
  });
});

describe('스포트라이트: 움직임 곡선', () => {
  it('CSS cubic-bezier: ease-in-out is symmetric, ease-out starts fast, the drop curve overshoots nothing', () => {
    assert.equal(close(EASE_IN_OUT(0.5), 0.5) && close(EASE_IN_OUT(0.25) + EASE_IN_OUT(0.75), 1), true);
    assert.equal(EASE_OUT(0.25) > 0.25 && EASE_OUT(0) === 0 && EASE_OUT(1) === 1, true);
    for (const ease of [EASE_IN_OUT, EASE_OUT, cubicBezier(0.3, 0.9, 0.4, 1)]) {
      for (let step = 1; step <= 200; step++) assert.equal(ease(step / 200) >= ease((step - 1) / 200), true, 'monotonic');
    }
    // A known point of cubic-bezier(.3, .9, .4, 1): u = .5 → x = .3875, y = .8375.
    assert.equal(close(cubicBezier(0.3, 0.9, 0.4, 1)(0.3875), 0.8375, 5), true);
  });

  it("the drop matches the mock-up's Gold frames (200/330/420/520/700 ms: −5, +5, +6, −4, −1 px at 132)", () => {
    const { drop } = stageMotion(STAGE_EMBLEM);
    const y = (ms: number) => at({ inputRange: [0, 1, 2, 3], outputRange: drop.y }, 3 * dropEasing(ms / STAGE_TIMING.drop));
    for (const [ms, measured] of [[200, -5], [330, 5], [420, 6], [520, -4], [700, -1]]) {
      assert.equal(Math.abs(y(ms) - measured) <= 0.5, true, `${ms} ms: ${y(ms).toFixed(2)} vs ${measured}`);
    }
    // Each keyframe is crossed at its time; the timing ends at rest.
    for (const [index, key] of DROP_KEYS.entries()) assert.equal(close(3 * dropEasing(key), index), true, `key ${index}`);
    assert.equal(dropEasing(0), 0);
  });

  it('loops: the beam swings −3.5° ↔ +3.5° (7 s a way), the floor and the float go there and back; particles are linear', () => {
    assert.deepEqual([at(SWAY_CURVE, 0), at(SWAY_CURVE, 0.5), at(SWAY_CURVE, 1)], [-3.5, 3.5, -3.5]);
    assert.equal(close(at(SWAY_CURVE, 0.25), 0, 3), true, 'ease-in-out: level halfway each way');
    const pulse = swing(0.75, 1);
    assert.deepEqual([at(pulse, 0), at(pulse, 0.5), at(pulse, 1)], [0.75, 1, 0.75]);
    assert.equal(STILL_FLOOR_OPACITY > 0.75 && STILL_FLOOR_OPACITY < 1, true);
    assert.deepEqual([0, 0.15, 0.8, 1].map((phase) => at(PARTICLE_OPACITY, phase)), [0, 0.95, 0.5, 0]);
    assert.deepEqual(PARTICLE_OPACITY.inputRange, [0, 0.15, 0.8, 1], 'particles are linear: exact keyframes');
    // Sampled curves keep every input increasing.
    for (const curve of [SWAY_CURVE, pulse, keyframeCurve([[0, 0], [0.5, 1], [1, 1]], EASE_IN_OUT, 4)]) {
      assert.equal(curve.inputRange.every((input, index) => index === 0 || input > curve.inputRange[index - 1]), true);
    }
  });

  it('a paused loop resumes where it was; only the first cycle waits its delay', () => {
    assert.deepEqual(loopPosition(0, 7500, 1300), { wait: 1300, phase: 0 });
    assert.deepEqual(loopPosition(1000, 7500, 1300), { wait: 300, phase: 0 });
    assert.equal(close(loopPosition(3000, 7500, 1300).phase, 1700 / 7500), true);
    assert.equal(close(loopPosition(1300 + 7500 * 2 + 750, 7500, 1300).phase, 0.1), true, 'later cycles do not wait');
    assert.deepEqual(loopPosition(0, 4500), { wait: 0, phase: 0 });
  });
});

describe('스포트라이트: 입장 재생 판정', () => {
  it('first presentation plays; the same tier again does not; a tier change in the same selection plays', () => {
    assert.equal(entranceDecision('gold', 'season-1|daily|sp-1'), 'play', 'first time in this process');
    rememberPresented('gold', 'season-1|daily|sp-1');
    assert.equal(entranceDecision('gold', 'season-1|daily|sp-1'), 'none', 'refocus, remount, Light/Dark, font size, new figures');
    assert.equal(entranceDecision('platinum', 'season-1|daily|sp-1'), 'play', 'promotion');
    assert.equal(entranceDecision('silver', 'season-1|daily|sp-1'), 'play', 'demotion: the same entrance');
  });

  it('another selection (season, daily → final, account) only remembers its tier, silently', () => {
    rememberPresented('gold', 'season-1|daily|sp-1');
    for (const context of ['season-2|daily|sp-9', 'season-1|final|sp-1', 'season-1|daily|sp-7']) {
      assert.equal(entranceDecision('diamond', context), 'silent', context);
      assert.equal(entranceDecision('gold', context), 'silent', context);
    }
    rememberPresented('diamond', 'season-1|final|sp-1');
    assert.equal(entranceDecision('diamond', 'season-1|final|sp-1'), 'none');
    resetPresentedTier();
    assert.equal(entranceDecision('diamond', 'season-1|final|sp-1'), 'play', 'a fresh process');
  });
});

describe('스포트라이트: OS 저모션 설정 확정 여부', () => {
  const { load } = require('../../../test/ledgerTestHarness.cjs');
  const { resolve } = require('node:path');
  /** Both hooks over one fresh copy of the shared store, with the given platform answers. */
  function probe(native: Record<string, unknown>) {
    const { useReducedMotion, useReducedMotionSettled } = load(resolve('src/theme/useReducedMotion.ts'), { 'react-native': native });
    const seen: Array<[boolean, boolean]> = [];
    function Probe() { seen.push([useReducedMotion(), useReducedMotionSettled()]); return null; }
    return { seen, Probe };
  }

  it('native: unsettled (and reduced) until the read answers; a failed read settles on reduced; a live change settles too', async () => {
    let answer!: (value: boolean) => void;
    const pending = probe({ Platform: { OS: 'android' }, AccessibilityInfo: {
      isReduceMotionEnabled: () => new Promise<boolean>((done) => { answer = done; }), addEventListener: () => ({ remove() {} }) } });
    let renderer: any;
    act(() => { renderer = require('react-test-renderer').create(React.createElement(pending.Probe)); });
    assert.deepEqual(pending.seen.at(-1), [true, false], 'unknown: reduced by default, not settled');
    await act(async () => answer(false));
    assert.deepEqual(pending.seen.at(-1), [false, true]);
    act(() => renderer.unmount());

    const failing = probe({ Platform: { OS: 'ios' }, AccessibilityInfo: {
      isReduceMotionEnabled: async () => { throw Error('unavailable'); }, addEventListener: () => ({ remove() {} }) } });
    await act(async () => { renderer = require('react-test-renderer').create(React.createElement(failing.Probe)); });
    assert.deepEqual(failing.seen.at(-1), [true, true], 'a failed read keeps reduced and stops waiting');
    act(() => renderer.unmount());

    let change!: (value: boolean) => void;
    const live = probe({ Platform: { OS: 'android' }, AccessibilityInfo: {
      isReduceMotionEnabled: () => new Promise<boolean>(() => {}), addEventListener: (_: string, callback: typeof change) => { change = callback; return { remove() {} }; } } });
    act(() => { renderer = require('react-test-renderer').create(React.createElement(live.Probe)); });
    act(() => change(true));
    assert.deepEqual(live.seen.at(-1), [true, true], 'reduced, now known');
    act(() => renderer.unmount());
  });

  it('web: settled at once, with or without the media query', () => {
    const previous = (globalThis as any).window;
    try {
      (globalThis as any).window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
      const withQuery = probe({ Platform: { OS: 'web' } });
      let renderer: any;
      act(() => { renderer = require('react-test-renderer').create(React.createElement(withQuery.Probe)); });
      assert.deepEqual(withQuery.seen[0], [false, true], 'first render');
      act(() => renderer.unmount());
      (globalThis as any).window = {};
      const without = probe({ Platform: { OS: 'web' } });
      act(() => { renderer = require('react-test-renderer').create(React.createElement(without.Probe)); });
      assert.deepEqual(without.seen[0], [true, true], 'no media query: reduced, final');
      act(() => renderer.unmount());
    } finally {
      if (previous === undefined) delete (globalThis as any).window; else (globalThis as any).window = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// TierCard with the spotlight, over the shared interaction harness. The
// harness records every Animated.timing start (`animations`) and loop (`loops`)
// without running them; `finish()` completes the recorded timings.

const SVG = { __esModule: true, default: 'Svg', Defs: 'Defs', LinearGradient: 'LinearGradient', RadialGradient: 'RadialGradient',
  Stop: 'Stop', Polygon: 'Polygon', Ellipse: 'Ellipse', Circle: 'Circle', Rect: 'Rect', Path: 'Path', Image: 'SvgImage' };
const HIDDEN_PROPS = ['accessible', 'accessibilityElementsHidden', 'importantForAccessibility', 'aria-hidden', 'pointerEvents'];
const hiddenAndInert = (node: any) => node.props.accessible === false && node.props.accessibilityElementsHidden === true
  && node.props.importantForAccessibility === 'no-hide-descendants' && node.props['aria-hidden'] === true && node.props.pointerEvents === 'none';
const hostParent = (node: any) => {
  let parent = node.parent;
  while (parent && typeof parent.type !== 'string') parent = parent.parent;
  return parent;
};
/** The nearest host nodes under `node`, through components. */
const hostChildren = (node: any): any[] => node.children.flatMap((child: any) =>
  typeof child === 'string' ? [] : typeof child.type === 'string' ? [child] : hostChildren(child));
const number = (value: unknown) => (typeof value === 'number' ? value : parseFloat(String(value)));
/** The current value of a static style value or of the harness's interpolation object. */
const evaluate = (value: any): number => {
  if (!value || typeof value !== 'object' || !value.inputRange) return number(value);
  const curve = { inputRange: value.inputRange, outputRange: value.outputRange.map(number) };
  const phase = value.value.value;
  if (phase <= curve.inputRange[0]) return curve.outputRange[0];
  if (phase >= curve.inputRange.at(-1)) return curve.outputRange.at(-1);
  return at(curve, phase);
};
const sortedJson = (value: any): string => JSON.stringify(value, (_, inner) => inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]])) : inner);
/** Host subtree as text: type, id, flattened style, other props (functions by name) and text. */
const signature = (node: any): string => {
  if (typeof node === 'string') return JSON.stringify(node);
  if (typeof node.type !== 'string') return node.children.map(signature).join('');
  const { children: _children, style, testID, ...rest } = node.props;
  const props = Object.keys(rest).sort().map((key) => `${key}=${typeof rest[key] === 'function' ? 'fn' : sortedJson(rest[key])}`);
  return `<${node.type}#${testID ?? ''} ${sortedJson(flatten(style))} ${props.join(' ')}>${node.children.map(signature).join('')}</>`;
};
/** Hosts from `node` up to the card, with their styles: a wrapper or an opacity on the way shows here. */
const ancestry = (node: any, card: any) => {
  const chain: string[] = [];
  for (let parent = hostParent(node); parent; parent = hostParent(parent)) {
    chain.push(`${parent.type}#${parent.props.testID ?? ''}${sortedJson(flatten(parent.props.style))}`);
    if (parent === card) break;
  }
  return chain.join(' < ');
};

type StageOptions = { tier?: HomeTier; mode?: 'light' | 'dark'; reduced?: boolean; settled?: boolean; paused?: boolean;
  context?: string; emblemSize?: number; fontScale?: number; spotlight?: boolean };

function stageHarness(t: TestContext, initial: StageOptions = {}) {
  const ui = interactionHarness();
  const state = { tier: 'gold' as HomeTier, mode: 'light' as 'light' | 'dark', reduced: false, settled: true, paused: false,
    context: 'season-1|daily|sp-1', emblemSize: 124, fontScale: 1, spotlight: true, ...initial };
  ui.dimensions = { width: 390, height: 844, fontScale: state.fontScale };
  // Every value the stage creates, with what it was set to: the drop's first frame must already be its start.
  const values: Array<{ value: any; history: number[] }> = [];
  class Value extends ui.native.Animated.Value {
    constructor(value: number) { super(value); values.push({ value: this, history: [value] }); }
    setValue(value: number) { values.find((entry) => entry.value === this)?.history.push(value); super.setValue(value); }
  }
  const mocks = {
    'react-native': { ...ui.native, Animated: { ...ui.native.Animated, Value } },
    'react-native-svg': SVG,
    '../../theme/useReducedMotion': { useReducedMotion: () => state.reduced, useReducedMotionSettled: () => state.settled },
  };
  const TierCard = ui.load('src/screens/home/TierCard.tsx', mocks).default;
  const element = () => {
    const tier = getHomeTier(state.tier === 'whale' ? 'master' : state.tier, state.mode)!;
    return React.createElement(TierCard, {
      tier, mode: state.mode, emblemSize: state.emblemSize, testID: 'ranking-my-card',
      caption: React.createElement('Text', { testID: 'ranking-my-tier', style: { fontSize: 15, fontWeight: '800' } }, tier.name),
      spotlight: state.spotlight ? { context: state.context, paused: state.paused } : undefined,
    }, React.createElement('View', { testID: 'info-probe', style: { gap: 12 } },
      React.createElement('Text', { testID: 'ranking-my-rank', style: { fontSize: 32 } }, '#3')));
  };
  const h: any = { ui, state, values };
  h.renderer = ui.render(element());
  h.update = (patch: StageOptions = {}) => {
    Object.assign(state, patch);
    ui.dimensions = { ...ui.dimensions, fontScale: state.fontScale };
    act(() => h.renderer.update(element()));
  };
  h.remount = () => { act(() => h.renderer.unmount()); h.renderer = ui.render(element()); };
  t.after(() => act(() => h.renderer.unmount()));
  h.hosts = (id: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id);
  h.has = (id: string) => h.hosts(id).length > 0;
  h.node = (id: string) => h.hosts(id)[0];
  h.emblem = () => h.node(`home-emblem-${state.tier}`);
  /** The emblem column at (221, 29) in the card, the emblem slot at its top; as onLayout reports them. */
  h.layout = (column = { x: 221, y: 29, width: 133, height: 152 }) => act(() => {
    const emblem = h.emblem();
    hostParent(emblem).props.onLayout?.({ nativeEvent: { layout: column } });
    const slot = flatten((h.node('tier-card-emblem') ?? emblem).props.style);
    emblem.props.onLayout?.({ nativeEvent: { layout: { x: (column.width - slot.width) / 2, y: 0, width: slot.width, height: slot.height } } });
  });
  /** Started drops: the emblem's entrance (a timing to keyframe 3). */
  h.drops = () => ui.animations.filter((animation: any) => animation.options.toValue === 3).length;
  h.running = () => ui.animations.filter((animation: any) => animation.value.animation === animation);
  h.emblemPose = () => {
    const style = flatten(h.emblem().props.style);
    return { opacity: evaluate(style.opacity), y: evaluate(style.transform[0].translateY), scale: evaluate(style.transform[1].scale) };
  };
  return h;
}

describe('스포트라이트: TierCard', () => {
  it('off: the card renders as before (no stage, no motion box, no handlers on the emblem column)', (t) => {
    const h = stageHarness(t, { spotlight: false });
    h.layout();
    const emblem = h.emblem(), column = hostParent(emblem);
    assert.equal(h.renderer.root.findAll((node: any) => node.type === 'AnimatedView').length, 0);
    assert.equal(h.renderer.root.findAll((node: any) => typeof node.type === 'string'
      && /^(tier-stage|tier-emblem-glint|tier-card-emblem)/.test(String(node.props.testID ?? ''))).length, 0);
    assert.deepEqual(Object.keys(column.props).sort(), ['children', 'style'], 'the emblem column as before');
    assert.deepEqual(hostChildren(column).map((child: any) => child.props.testID), ['home-emblem-gold', 'ranking-my-tier']);
    assert.equal(h.hosts('home-tier-image').length, 1);
    assert.equal(ui(h).animations.length + ui(h).loops.length, 0, 'nothing moves');
  });

  it('keeps every id: the card, the tier name, one home-emblem box and one home-tier-image, the background', (t) => {
    const h = stageHarness(t);
    h.layout();
    assert.deepEqual(['ranking-my-card', 'ranking-my-tier', 'home-emblem-gold', 'home-tier-image', 'home-tier-background-gold-light']
      .map((id) => h.hosts(id).length), [1, 1, 1, 1, 1]);
    assert.equal(h.renderer.root.findAll((node: any) => typeof node.type === 'string' && String(node.props.testID ?? '').startsWith('home-emblem-')).length, 1);
    // The emblem box stays in the column with the tier name.
    assert.equal(hostParent(h.emblem()) === hostParent(h.node('ranking-my-tier')), true);
  });

  it('every effect layer and the moving emblem box take no touches and are hidden from screen readers', (t) => {
    const h = stageHarness(t);
    h.layout();
    const stage = h.node('tier-stage');
    assert.equal(hiddenAndInert(stage), true, HIDDEN_PROPS.map((key) => `${key}=${stage.props[key]}`).join(' '));
    assert.equal(hiddenAndInert(h.emblem()), true, 'the emblem box');
    for (const id of ['tier-stage-beam', 'tier-stage-floor', 'tier-stage-flash', 'tier-stage-ring', 'tier-stage-particle']) {
      assert.equal(h.hosts(id).length > 0 && h.hosts(id).every((node: any) => stage.findAll((child: any) => child === node).length === 1), true, id);
    }
    // Layer order, bottom to top: background, stage, then the information and the emblem column.
    const card = h.node('ranking-my-card');
    const order = card.children.filter((child: any) => typeof child.type === 'string' || child.props.stage)
      .map((child: any) => child.props.stage ? 'stage' : child.props.testID ?? (child.findAll((node: any) => node.props.testID === 'info-probe').length ? 'info' : 'emblem'));
    assert.deepEqual(order, ['stage', 'info', 'emblem']);
  });

  it('places the layers on the measured emblem (E = 124): beam, floor 8k above the visible bottom, particles', (t) => {
    const h = stageHarness(t);
    h.layout();
    const harness = interactionHarness();
    const { tierEmblemVisibleBottom } = harness.load('src/screens/home/TierEmblem.tsx');
    const slot = flatten(h.node('tier-card-emblem').props.style);
    const left = 221 + (133 - slot.width) / 2;
    const geometry = stageGeometry(124, { cx: left + slot.width / 2, cy: 29 + slot.height / 2, bottom: 29 + tierEmblemVisibleBottom('gold', 124) }, false);
    const beam = flatten(h.node('tier-stage-beam').props.style);
    assert.deepEqual([beam.left, beam.width, beam.top, beam.bottom, beam.transformOrigin], [geometry.beam.left, geometry.beam.width, 0, 0, 'top']);
    const floor = flatten(h.node('tier-stage-floor').props.style);
    assert.deepEqual([floor.left, floor.top, floor.width, floor.height], [geometry.floor.left, geometry.floor.top, geometry.floor.width, geometry.floor.height]);
    const particles = h.hosts('tier-stage-particle').map((node: any) => flatten(node.props.style));
    assert.deepEqual(particles.map((style: any) => [style.left, style.top, style.width]),
      geometry.particles.map((particle) => [particle.left, particle.top, particle.size]));
    // Large text: the emblem above the information, the beam stops 0.6 E under the emblem.
    h.update({ fontScale: 2 });
    h.layout({ x: 12, y: 14, width: 334, height: 152 });
    const stacked = flatten(h.node('tier-stage-beam').props.style);
    assert.equal(close(stacked.height, 14 + tierEmblemVisibleBottom('gold', 124) + 0.6 * 124), true, String(stacked.height));
    assert.equal(stacked.bottom === undefined, true);
  });

  it('reduced motion: a still beam (0°) and floor glow only — no loops, particles, ring, flash, float, glint or entrance', (t) => {
    for (const tier of TIERS) {
      const h = stageHarness(t, { tier, reduced: true });
      h.layout();
      assert.equal(ui(h).loops.length + ui(h).animations.length, 0, tier);
      // Plain values only (an animated one would be an object): compare them as text.
      const still = (value: unknown) => (typeof value === 'object' && value !== null ? 'animated' : String(value));
      const beam = flatten(h.node('tier-stage-beam').props.style).transform;
      assert.deepEqual([beam.length, still(beam[0].rotate)], [1, '0deg'], tier);
      const floor = flatten(h.node('tier-stage-floor').props.style);
      assert.deepEqual([still(floor.opacity), floor.transform.length, still(floor.transform[0].scaleX)], [String(STILL_FLOOR_OPACITY), 1, '1'], tier);
      for (const id of ['tier-stage-particle', 'tier-stage-ring', 'tier-stage-flash', 'tier-emblem-glint']) assert.equal(h.has(id), false, `${tier} ${id}`);
      assert.deepEqual(h.emblemPose(), { opacity: 1, y: 0, scale: 1 }, `${tier}: shown at rest`);
      assert.equal(flatten(h.emblem().props.style).transform.length, 2, `${tier}: no float`);
      assert.equal(entranceDecision(tier, 'season-1|daily|sp-1'), 'play', 'not consumed: no entrance started');
      act(() => h.renderer.unmount());
      h.renderer = ui(h).render(React.createElement('View'));
    }
  });

  it('before the OS answers, an owed entrance waits hidden; reduced then shows the emblem at rest, otherwise it drops from its start', (t) => {
    const reduced = stageHarness(t, { settled: false });
    reduced.layout();
    assert.deepEqual([reduced.emblemPose().opacity, reduced.drops(), ui(reduced).loops.length], [0, 0, 0], 'hidden, nothing started');
    reduced.update({ settled: true, reduced: true });
    assert.deepEqual([reduced.emblemPose(), reduced.drops(), ui(reduced).animations.length], [{ opacity: 1, y: 0, scale: 1 }, 0, 0]);

    resetPresentedTier();
    const moving = stageHarness(t, { settled: false });
    moving.layout();
    moving.update({ settled: true });
    assert.equal(moving.drops(), 1);
    // The drop's value never showed the rest pose before the entrance: it was created at its start.
    const drop = ui(moving).animations.find((animation: any) => animation.options.toValue === 3).value;
    assert.deepEqual(moving.values.find((entry: any) => entry.value === drop).history.every((value: number) => value === 0), true);
  });

  it('the entrance: one drop (0.85 s, keyframes), the flash (0.9 s) and the ring after 0.38 s (0.9 s); then at rest with no ring', (t) => {
    const h = stageHarness(t);
    h.layout();
    const entrance = ui(h).animations.filter((animation: any) => [STAGE_TIMING.drop, STAGE_TIMING.flash].includes(animation.options.duration)
      || animation.options.delay === STAGE_TIMING.ringDelay);
    assert.deepEqual(entrance.map((animation: any) => [animation.options.toValue, animation.options.duration, animation.options.delay ?? 0]),
      [[3, 850, 0], [1, 900, 0], [1, 900, 380]]);
    assert.equal(entrance[0].options.easing === dropEasing && entrance[1].options.easing === EASE_OUT && entrance[2].options.easing === EASE_OUT, true);
    assert.equal(entrance.every((animation: any) => animation.options.isInteraction === false), true);
    assert.deepEqual([h.emblemPose().opacity, h.emblemPose().y, h.emblemPose().scale], [0, -96 * 124 / 132, 1.25]);
    assert.deepEqual([h.has('tier-stage-ring'), h.has('tier-stage-flash')], [true, true]);
    assert.deepEqual([evaluate(flatten(h.node('tier-stage-ring').props.style).opacity), evaluate(flatten(h.node('tier-stage-flash').props.style).opacity)], [0.95, 0.55]);
    assert.equal(entranceDecision('gold', 'season-1|daily|sp-1'), 'none', 'consumed as it started');
    ui(h).finish();
    assert.deepEqual(h.emblemPose(), { opacity: 1, y: 0, scale: 1 });
    assert.deepEqual([h.has('tier-stage-ring'), h.has('tier-stage-flash')], [false, false], 'the ring is gone after it');
  });

  it('plays once per process: refocus, remount, Light/Dark, font size and new figures never replay it', (t) => {
    const h = stageHarness(t);
    h.layout();
    assert.equal(h.drops(), 1);
    const drop = flatten(h.emblem().props.style).opacity.value;
    h.update({ paused: true });
    h.update({ paused: false });
    h.update({ mode: 'dark' });
    assert.equal(flatten(h.emblem().props.style).opacity.value === drop, true, 'Light/Dark keeps the same motion');
    assert.equal(h.has('home-tier-background-gold-dark'), true);
    h.update({ fontScale: 2 });
    h.update({ fontScale: 1, mode: 'light' });
    h.remount();
    h.layout();
    assert.equal(h.drops(), 1, 'never again');
    assert.deepEqual(h.emblemPose(), { opacity: 1, y: 0, scale: 1 }, 'a remount shows the rest pose at once');
  });

  it('a tier change in the same selection plays (demotion too); another selection only re-anchors the tier', (t) => {
    const h = stageHarness(t);
    h.layout();
    ui(h).finish();
    h.update({ tier: 'platinum' });
    h.layout();
    assert.deepEqual([h.drops(), h.emblemPose().opacity], [2, 0], 'promotion: the new emblem starts hidden at the drop');
    ui(h).finish();
    h.update({ tier: 'silver' });
    assert.equal(h.drops(), 3, 'demotion: the same entrance');
    ui(h).finish();
    h.update({ tier: 'diamond', context: 'season-2|daily|sp-9' });
    h.layout();
    assert.deepEqual([h.drops(), h.emblemPose().opacity], [3, 1], 'new season: no entrance, shown at rest');
    assert.equal(entranceDecision('diamond', 'season-2|daily|sp-9'), 'none', 'the new selection is remembered');
    h.update({ tier: 'whale', context: 'season-2|final|sp-9' });
    assert.equal(h.drops(), 3, 'daily → final: no entrance');
  });

  it('an owed entrance waits while the tab is unfocused; leaving mid-entrance settles it and never replays it', (t) => {
    const h = stageHarness(t, { paused: true });
    h.layout();
    assert.deepEqual([h.drops(), h.emblemPose().opacity, ui(h).loops.length + ui(h).animations.length], [0, 0, 0]);
    h.update({ paused: false });
    assert.equal(h.drops(), 1);
    h.update({ paused: true });
    assert.deepEqual(h.emblemPose(), { opacity: 1, y: 0, scale: 1 }, 'settled at rest');
    assert.equal(h.running().length, 0, 'every animation stopped');
    h.update({ paused: false });
    assert.equal(h.drops(), 1);
  });

  it('loops stop when the tab loses focus and resume from where they were; unmounting stops them', (t) => {
    let now = 1000;
    t.mock.method(performance, 'now', () => now);
    const h = stageHarness(t, { tier: 'diamond' });
    h.layout();
    // Beam, floor, float and nine particles: each starts its first cycle.
    const firsts = ui(h).animations.filter((animation: any) => animation.options.easing?.(0.5) === 0.5);
    assert.equal(firsts.length, 12);
    assert.equal(firsts.every((animation: any) => animation.options.isInteraction === false && animation.options.useNativeDriver === true), true);
    now += 3000;
    h.update({ paused: true });
    assert.equal(h.running().length, 0);
    const before = ui(h).animations.length;
    h.update({ paused: false });
    const resumed = ui(h).animations.slice(before);
    // Particle 2 (1.3 s delay, 7.5 s cycle) resumes 1.7 s into its cycle; particle 6 still waits 2 s.
    const second = resumed.find((animation: any) => close(animation.options.duration, 7500 * (1 - 1700 / 7500), 3));
    assert.equal(!!second && close(second.value.value, 1700 / 7500) && (second.options.delay ?? 0) === 0, true, 'particle 2');
    const sixth = resumed.find((animation: any) => animation.options.delay === 2000);
    assert.equal(!!sixth && sixth.options.duration === 7200 && sixth.value.value === 0, true, 'particle 6');
    assert.equal(h.running().length, 12, 'running again');
    // A finished first cycle continues as an endless loop from the start.
    ui(h).finish();
    assert.equal(ui(h).loops.length, 12);
  });

  it('unmounting stops the loops and the entrance', (t) => {
    const h = stageHarness(t, { tier: 'whale' });
    h.layout();
    assert.equal(h.running().length, 12 + 3, 'beam, floor, float, nine particles; drop, flash, ring');
    act(() => h.renderer.unmount());
    assert.equal(h.running().length, 0);
    h.renderer = ui(h).render(React.createElement('View'));
  });

  it('the float is only for platinum, diamond and whale (6k up, 1.2°); there is no glint (its white copy washed the emblem out)', (t) => {
    for (const tier of TIERS) {
      const h = stageHarness(t, { tier });
      h.layout();
      const transform = flatten(h.emblem().props.style).transform;
      const floats = ['platinum', 'diamond', 'whale'].includes(tier);
      assert.equal(transform.length, floats ? 4 : 2, tier);
      if (floats) {
        assert.deepEqual([transform[2].translateY.outputRange.at(0), Math.min(...transform[2].translateY.outputRange), transform[3].rotate.outputRange[transform[3].rotate.outputRange.length >> 1]],
          [0, -6 * 124 / 132, '1.2deg'], tier);
        const period = ui(h).animations.find((animation: any) => animation.value === transform[2].translateY.value).options.duration;
        assert.equal(period, tier === 'whale' ? 5500 : 4600, tier);
      }
      assert.equal(h.has('tier-emblem-glint') || h.hosts('home-tier-image').length !== 1, false, `${tier}: one emblem image, no white copy`);
      act(() => h.renderer.unmount());
      h.renderer = ui(h).render(React.createElement('View'));
    }
  });
});

/** The harness behind a stage harness. */
function ui(h: any) { return h.ui; }

// ---------------------------------------------------------------------------
// 내 순위 on the real RankingScreen: the information and the tier name render
// the same with and without the spotlight.

function person(index: number, tier: string): RankingItemDto {
  return { ...availableRankings.rankings[0], rank: index + 1, seasonParticipantId: `sp-${index}`, userId: `user-${index}`,
    nickname: `trader-${index}`, profileImageUrl: null, provisionalTier: tier, finalTier: null, returnRate: '4.5', totalAssetKrw: '10450000.00000000' };
}

async function rankingScreen(t: TestContext, { tier, mode, fontScale, spotlight }: { tier: string; mode: 'light' | 'dark'; fontScale: number; spotlight: boolean }) {
  const harness = interactionHarness();
  harness.dimensions = { width: 390, height: 844, fontScale };
  harness.native.AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const rows = [person(0, 'master'), person(1, 'gold'), person(2, tier)];
  const answer = (params: URLSearchParams) => ({
    ...structuredClone(availableRankings), rankType: 'daily', rankings: rows.slice(0, Number(params.get('limit'))),
    pagination: { limit: Number(params.get('limit')), offset: 0, total: rows.length, returned: rows.length, nextOffset: null },
    myRanking: { ...availableRankings.myRanking, seasonParticipantId: 'sp-2', rank: 3, returnRate: '4.5', totalAssetKrw: '10450000.00000000',
      provisionalTier: tier, finalTier: null },
  });
  const transport = { apiClient: { get: async (path: string) => {
    const url = new URL(path, 'https://fixture.invalid');
    if (url.pathname !== '/ranking') throw new Error(`Unexpected read ${path}`);
    return { data: { success: true, data: answer(url.searchParams) } };
  } } };
  const mocks: Record<string, unknown> = {
    'react-native': { ...harness.native, SafeAreaView: 'SafeAreaView',
      FlatList: ({ ListHeaderComponent }: any) => React.createElement('List', null, ListHeaderComponent) },
    'react-native-svg': SVG,
    '@tanstack/react-query': query,
    '../../features/ranking/api': harness.load('src/features/ranking/api.ts', { '../../services/api/client': transport }),
    '../../features/season/api': { getCurrentSeason: async () => ({ ...availableRankings.season, status: 'active', joined: true, initialCapitalKrw: '1000000' }) },
    '../../features/me/api': { getMe: async () => ({ nickname: 'me', profileImageUrl: null }) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate() {} }) },
    '@react-navigation/native': { useIsFocused: () => true },
    '../../theme/appearance': { useAppearance: () => ({ mode, financialPreference: 'red_blue', colors: {} }) },
  };
  if (!spotlight) {
    // The same card with the spotlight left off.
    const real = harness.load('src/screens/home/TierCard.tsx', mocks);
    mocks['../home/TierCard'] = { __esModule: true, tierForeground: real.tierForeground,
      default: (props: any) => React.createElement(real.default, { ...props, spotlight: undefined }) };
  }
  const Screen = harness.load('src/screens/ranking/RankingScreen.tsx', mocks).default;
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const renderer = harness.render(React.createElement(query.QueryClientProvider, { client },
    React.createElement(Screen, { navigation: { navigate() {} } })));
  t.after(() => { act(() => renderer.unmount()); client.clear(); });
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  const node = (id: string) => renderer.root.findAll((child: any) => typeof child.type === 'string' && child.props.testID === id)[0];
  const card = node('ranking-my-card');
  // Measure the emblem so every layer renders around the information.
  const emblem = renderer.root.findAll((child: any) => typeof child.type === 'string' && String(child.props.testID ?? '').startsWith('home-emblem-'))[0];
  if (spotlight && emblem) {
    act(() => {
      hostParent(emblem).props.onLayout({ nativeEvent: { layout: { x: 221, y: 29, width: 133, height: 152 } } });
      emblem.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 133, height: 130 } } });
    });
  }
  const info = hostParent(hostParent(node('ranking-my-figures')));
  const caption = node('ranking-my-tier');
  return { card, info, caption, has: (id: string) => !!node(id), harness };
}

describe('스포트라이트: 내 순위 글자는 그대로', () => {
  it('an unknown tier keeps the plain card: no spotlight at all', async (t) => {
    const plain = await rankingScreen(t, { tier: 'grandmaster', mode: 'light', fontScale: 1, spotlight: true });
    assert.deepEqual([plain.has('ranking-my-figures'), plain.has('tier-stage'), plain.has('ranking-my-tier')], [true, false, false]);
    assert.equal(plain.card === undefined || plain.card.findAll((node: any) => String(node.props.testID ?? '').startsWith('home-emblem-')).length === 0, true);
  });

  it('six tiers × Light/Dark (and 2× text): the information column and the tier name render the same, with nothing moving them', async (t) => {
    const cases = [...TIERS.flatMap((tier) => (['light', 'dark'] as const).map((mode) => ({ tier, mode, fontScale: 1 }))),
      { tier: 'gold' as HomeTier, mode: 'dark' as const, fontScale: 2 }];
    for (const { tier, mode, fontScale } of cases) {
      resetPresentedTier();
      const api = tier === 'whale' ? 'master' : tier;
      const off = await rankingScreen(t, { tier: api, mode, fontScale, spotlight: false });
      const on = await rankingScreen(t, { tier: api, mode, fontScale, spotlight: true });
      const label = `${tier} ${mode} ×${fontScale}`;
      assert.deepEqual([off.has('tier-stage'), on.has('tier-stage'), on.has('tier-stage-particle')], [false, true, true], label);
      for (const [name, a, b] of [['information', off.info, on.info], ['tier name', off.caption, on.caption]] as const) {
        const before = signature(a) + ancestry(a, off.card), after = signature(b) + ancestry(b, on.card);
        assert.equal(hash(after), hash(before), `${label} ${name}: ${firstDifference(before, after)}`);
        // Nothing between the text and the card moves or fades it.
        for (let parent = hostParent(b); parent && parent !== on.card; parent = hostParent(parent)) {
          const style = flatten(parent.props.style);
          assert.equal(parent.type !== 'AnimatedView' && style.opacity === undefined && style.transform === undefined, true, `${label} ${name}`);
        }
      }
      // The information keeps its place: still the card's own column, before the emblem column.
      assert.equal(hostParent(on.info) === on.card, true, label);
    }
  });
});
