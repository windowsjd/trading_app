import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const Renderer = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
const bridge = require('./questGuideBridge.ts');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SCREEN = { x: 0, y: 0, width: 390, height: 844 };
const VIEWPORT = { x: 0, y: 100, width: 390, height: 660 };

function harness(reducedMotion = false) {
  const h: any = { loops: [], timings: [], reveals: [], actions: [], rects: { root: SCREEN, viewport: VIEWPORT, target: { x: 24, y: 300, width: 120, height: 80 },
    quote: { x: 24, y: 420, width: 300, height: 60 } } };
  class Value {
    value: number;
    constructor(value: number) { this.value = value; }
    setValue(value: number) { this.value = value; }
    interpolate(config: unknown) { return { interpolate: config }; }
  }
  const animation = (value?: Value, toValue?: number) => ({ start() { if (value && toValue !== undefined) value.setValue(toValue); }, stop() {} });
  const native = {
    View: 'View', Text: 'Text', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }, absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } },
    Platform: { OS: 'ios' },
    Easing: { out: () => () => 0, in: () => () => 0, quad: () => 0, cubic: () => 0 },
    AccessibilityInfo: { announceForAccessibility: (text: string) => { h.announced = text; } },
    Keyboard: { addListener: (event: string, listener: (event: unknown) => void) => { (h.keyboard ??= {})[event] = listener; return { remove() {} }; } },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
    Animated: {
      View: 'Animated.View', Value,
      timing: (value: Value, config: { toValue: number }) => { h.timings.push(config); return animation(value, config.toValue); },
      spring: (value: Value, config: { toValue: number }) => animation(value, config.toValue),
      sequence: () => animation(),
      parallel: () => animation(),
      loop: (_animation: unknown, config: unknown) => { h.loops.push(config); return animation(); },
    },
  };
  const Overlay = load(resolve('src/features/quest/QuestGuideOverlay.tsx'), {
    'react-native': native,
    'react-native-svg': { default: 'Svg', Path: 'Path', Circle: 'Circle', Defs: 'Defs', LinearGradient: 'LinearGradient', Rect: 'Rect', Stop: 'Stop', __esModule: true },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) },
    './questGuideBridge': bridge,
  }).default;
  const measurable = (key: string) => ({ measureInWindow: (callback: (...args: number[]) => void) => {
    const rect = h.rects[key];
    callback(rect.x, rect.y, rect.width, rect.height);
  } });
  h.cleanups = [
    bridge.questGuideTarget('fx-viewport')(measurable('viewport')),
    bridge.questGuideTarget('fx-amount')(measurable('target')),
    bridge.questGuideTarget('fx-quote-title')(measurable('quote')),
  ];
  bridge.registerQuestGuideReveal('fx', (node: unknown) => h.reveals.push(node));
  const createNodeMock = (element: any) => element.props.testID === 'quest-guide-overlay' ? measurable('root') : null;
  h.render = async (view: unknown) => {
    h.currentView = view;
    const element = React.createElement(Overlay, { view, quest: 'exchange', reducedMotion, onAction: (...args: unknown[]) => h.actions.push(args) });
    await Renderer.act(async () => {
      if (h.renderer) h.renderer.update(element);
      else h.renderer = Renderer.create(element, { createNodeMock });
    });
  };
  h.find = (id: string) => h.renderer.root.findAll((node: any) => node.props.testID === id && typeof node.type === 'string')[0];
  h.has = (id: string) => h.find(id) !== undefined;
  h.close = async () => {
    await Renderer.act(async () => h.renderer.unmount());
    for (const cleanup of h.cleanups) cleanup?.();
    bridge.registerQuestGuideReveal('fx', null);
  };
  return h;
}

const card = { title: '환전 금액', body: '바꿀 원화 금액을 입력해 주세요.', hint: null, tone: 'info', stepLabel: '3/6', next: 'enabled', busy: false, actions: ['exit'] };
const spotlight = (key = '1:fx:2:ok', overrides: Record<string, unknown> = {}) =>
  ({ kind: 'spotlight', key, anchor: '1:fx:2:fx-amount', screen: 'fx', step: 2, targets: ['fx-amount'], placement: 'auto', card, ...overrides });
const flat = (style: unknown): Record<string, unknown> => Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : (style as Record<string, unknown>) ?? {};
// The card's natural heights, as the native layout reports them.
const layout = (height: number) => ({ nativeEvent: { layout: { height } } });
const measureCard = (h: any, text: number, actions = 44, head = 50) => Renderer.act(async () => {
  h.find('quest-guide-head')?.props.onLayout(layout(head));
  h.find('quest-guide-instruction').props.onLayout(layout(text));
  h.find('quest-guide-actions').props.onLayout(layout(actions));
});
// One measurement: a moving or settling target is re-measured sooner (48ms),
// one that holds still every 160ms; advancing 160ms covers either.
const tick = (t: any) => Renderer.act(async () => {
  t.mock.timers.tick(160);
  await new Promise(resolve => setImmediate(resolve));
});
const fades = (h: any) => h.timings.filter((config: any) => config.toValue === 1).length;

describe('QuestGuideOverlay', () => {
  it('spotlights the measured target only once it holds still, without taking its touches', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    await h.render(spotlight());
    t.after(h.close);
    assert.equal(h.has('quest-guide-ring'), false, 'first measurement only arms the spotlight');
    await tick(t);
    assert.equal(h.has('quest-guide-ring'), true);
    const ring = flat(h.find('quest-guide-ring').props.style);
    // 6px around the target, in overlay coordinates.
    assert.deepEqual([ring.left, ring.top, ring.width, ring.height], [18, 294, 132, 92]);
    assert.equal(h.find('quest-guide-ring').props.pointerEvents, 'none');
    assert.equal(h.find('quest-guide-spotlight').props.pointerEvents, 'none');
    assert.equal(h.find('quest-guide-overlay').props.pointerEvents, 'box-none');
    assert.equal(h.find('quest-guide-card').props.pointerEvents === undefined, true, 'only the card is touchable');
    // A steady ring: no pulse loop, no scale, and one ~220ms fade-in for the step.
    assert.equal(h.loops.length, 0, 'no repeating pulse');
    assert.equal(ring.transform === undefined, true, 'never scales');
    assert.equal(ring.borderWidth, 3);

    // The card is placed after it is measured, beside (not on) the target.
    assert.equal(flat(h.find('quest-guide-card').props.style).opacity, 0);
    await measureCard(h, 90);
    assert.deepEqual(h.timings.map((config: any) => [config.toValue, config.duration]), [[1, 220], [1, 220]], 'dim, then ring and card: once');
    const placed = flat(h.find('quest-guide-card').props.style);
    assert.equal(placed.opacity === 0, false);
    assert.equal(placed.maxHeight, undefined, 'room enough: no scrolling');
    assert.equal(h.has('quest-guide-head'), true, 'full card with the quest label and title');
    const top = placed.top as number;
    assert.equal(top + 230 <= 294 || top >= 386, true, 'card does not cover the highlighted control');
    assert.equal(top >= VIEWPORT.y && top + 230 <= VIEWPORT.y + VIEWPORT.height, true, 'inside the visible screen area');
    await Renderer.act(async () => h.find('quest-guide-next').props.onPress());
    await Renderer.act(async () => h.find('quest-guide-exit').props.onPress());
    assert.deepEqual(h.actions, [['next', 2], ['exit', 2]]);
    assert.match(h.announced, /환전 금액/);
  });

  it('updates the card in place when the same step changes state (no blink)', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    await h.render(spotlight('1:fx:2:empty', { card: { ...card, next: 'disabled', hint: '금액을 입력하면 다음으로 넘어갈 수 있어요.' } }));
    t.after(h.close);
    await tick(t);
    await measureCard(h, 110);
    const before = h.find('quest-guide-card');
    assert.equal(flat(before.props.style).opacity === 0, false);
    await h.render(spotlight('1:fx:2:ok'));
    const after = h.find('quest-guide-card');
    assert.equal(after === before, true, 'same mounted card, new content');
    assert.equal(flat(after.props.style).opacity === 0, false, 'never hidden between states');
    assert.equal(h.find('quest-guide-next').props.accessibilityState.disabled, false);
  });

  it('asks for room first, then compacts and scrolls its own text instead of covering the control', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    // Large text beside a mid-screen target: too tall for either side.
    h.rects.viewport = { x: 0, y: 100, width: 320, height: 440 };
    h.rects.target = { x: 24, y: 250, width: 272, height: 60 };
    await h.render(spotlight('1:fx:2:ok', { anchor: '1:fx:2:tall' }));
    t.after(h.close);
    await tick(t);
    await measureCard(h, 180);
    assert.equal(h.reveals.length, 1, 'the screen is asked to make room first');
    assert.equal(flat(h.find('quest-guide-card').props.style).opacity, 0, 'never shown on top of the control');
    await Renderer.act(async () => { t.mock.timers.tick(600); });
    const style = flat(h.find('quest-guide-card').props.style);
    assert.equal(style.opacity === 0, false);
    assert.equal(style.maxHeight, 200, 'the roomier side, below the control');
    assert.equal((style.top as number) >= 244 + 72, true, 'below the 6px ring');
    assert.equal(h.find('quest-guide-text').props.scrollEnabled, true);
    // The instruction comes first; the quest label and title give way.
    assert.equal(h.has('quest-guide-body'), true);
    assert.equal(h.has('quest-guide-head'), false);
    assert.equal(h.has('quest-guide-step'), false, 'the step counter gives way too: one row of actions');
    assert.doesNotMatch(JSON.stringify(h.renderer.toJSON()), /QUEST 01/);
    assert.equal(h.has('quest-guide-exit'), true, 'actions stay outside the scrolling text');
  });

  it('drops only the quest label and title when that is enough room', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    h.rects.viewport = { x: 0, y: 100, width: 320, height: 520 };
    h.rects.target = { x: 24, y: 250, width: 272, height: 60 };
    await h.render(spotlight('1:fx:2:ok', { anchor: '1:fx:2:medium' }));
    t.after(h.close);
    await tick(t);
    await measureCard(h, 180);
    await Renderer.act(async () => { t.mock.timers.tick(600); });
    const style = flat(h.find('quest-guide-card').props.style);
    assert.equal(style.opacity === 0, false);
    assert.equal(style.maxHeight, undefined, 'no scrolling needed once compact');
    assert.equal(h.find('quest-guide-text').props.scrollEnabled, false);
    assert.equal(h.has('quest-guide-head'), false);
    assert.equal(h.has('quest-guide-body'), true);
  });

  it('follows a moving target at once without hiding, re-fading or ignoring the move', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    await h.render(spotlight());
    t.after(h.close);
    await tick(t);
    await measureCard(h, 90);
    const dim = h.find('quest-guide-spotlight');
    const card = h.find('quest-guide-card');
    const shown = fades(h);
    // Sub-pixel measurement noise (live data, rounding) is not a move.
    h.rects.target = { x: 24.4, y: 300.6, width: 120.3, height: 80 };
    await tick(t);
    assert.equal(flat(h.find('quest-guide-ring').props.style).top, 294);
    // A real move (scroll): the ring follows on the next measurement.
    h.rects.target = { x: 24, y: 200, width: 120, height: 80 };
    await tick(t);
    assert.equal(h.has('quest-guide-ring'), true, 'never hidden while moving');
    assert.equal(flat(h.find('quest-guide-ring').props.style).top, 194);
    h.rects.target = { x: 24, y: 120, width: 120, height: 80 };
    await tick(t);
    assert.equal(flat(h.find('quest-guide-ring').props.style).top, 114);
    assert.equal(h.find('quest-guide-spotlight') === dim, true, 'the same dim layer, never removed');
    assert.equal(h.find('quest-guide-card') === card, true, 'the same card, never remounted');
    assert.equal(flat(h.find('quest-guide-card').props.style).opacity === 0, false);
    assert.equal(fades(h), shown, 'no new fade-in for the same step');
    assert.equal(h.loops.length, 0);
  });

  it('follows the keyboard without hiding the step', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    await h.render(spotlight());
    t.after(h.close);
    await tick(t);
    await measureCard(h, 90);
    const card = h.find('quest-guide-card');
    const shown = fades(h);
    await Renderer.act(async () => h.keyboard.keyboardDidShow({ endCoordinates: { screenY: 480 } }));
    assert.equal(h.has('quest-guide-ring'), true, 'still shown while the keyboard opens');
    await tick(t);
    const style = flat(h.find('quest-guide-card').props.style);
    assert.equal(h.find('quest-guide-card') === card, true);
    assert.equal((style.top as number) + 230 <= 480, true, 'the card moves above the keyboard');
    await Renderer.act(async () => h.keyboard.keyboardDidHide());
    await tick(t);
    assert.equal(h.has('quest-guide-ring'), true);
    assert.equal(fades(h), shown);
  });

  it('keeps the dim between steps of one screen and fades in only the new step', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    await h.render(spotlight());
    t.after(h.close);
    await tick(t);
    await measureCard(h, 90);
    const dim = h.find('quest-guide-spotlight');
    const shown = fades(h);
    await h.render(spotlight('1:fx:3:quote', { anchor: '1:fx:3:fx-quote-title', step: 3, targets: ['fx-quote-title'] }));
    // The old step's ring and card are gone at once; the dim stays, closed.
    assert.equal(h.has('quest-guide-ring'), false, 'no stale ring on the old target');
    assert.equal(h.has('quest-guide-card'), false);
    assert.equal(h.find('quest-guide-spotlight') === dim, true, 'the dim does not blink off');
    assert.doesNotMatch(h.find('quest-guide-spotlight').findByType('Path').props.d, / M/, 'no hole until the new target is measured');
    await tick(t);
    await measureCard(h, 90);
    assert.equal(flat(h.find('quest-guide-ring').props.style).top, 414, 'the new target');
    assert.equal(h.find('quest-guide-spotlight') === dim, true);
    assert.equal(fades(h), shown + 1, 'only the new step fades in');
  });

  it('removes the highlight when the target goes away and shows the same step again without a new fade', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    await h.render(spotlight());
    t.after(h.close);
    await tick(t);
    await measureCard(h, 90);
    const shown = fades(h);
    // The target unmounts (another screen covers it, or it is removed).
    await Renderer.act(async () => { h.cleanups[1](); });
    await tick(t);
    assert.equal(h.has('quest-guide-ring'), false, 'no stale ring');
    assert.equal(h.has('quest-guide-spotlight'), false, 'no stale dim');
    assert.equal(h.has('quest-guide-card'), false);
    await Renderer.act(async () => { h.cleanups[1] = bridge.questGuideTarget('fx-amount')({ measureInWindow: (callback: (...args: number[]) => void) => {
      const rect = h.rects.target; callback(rect.x, rect.y, rect.width, rect.height);
    } }); });
    await tick(t);
    await tick(t);
    await measureCard(h, 90);
    assert.equal(flat(h.find('quest-guide-ring').props.style).top, 294);
    assert.equal(fades(h), shown, 'the same step does not fade in again');
    assert.equal(flat(h.find('quest-guide-card').props.style).opacity === 0, false);
  });

  it('never carries a dim to another screen', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    await h.render(spotlight());
    t.after(h.close);
    await tick(t);
    assert.equal(h.has('quest-guide-spotlight'), true);
    await h.render(spotlight('1:wallet:0:entry', { anchor: '1:wallet:0:wallet-exchange', screen: 'wallet', step: 0, targets: ['wallet-exchange'] }));
    assert.equal(h.has('quest-guide-spotlight'), false);
    assert.equal(h.has('quest-guide-ring'), false);
  });

  it('asks the screen to reveal an off-screen target once, then clips to the visible area', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    h.rects.target = { x: 24, y: 720, width: 340, height: 80 };
    await h.render(spotlight());
    t.after(h.close);
    await tick(t);
    assert.equal(h.reveals.length, 1);
    assert.equal(h.has('quest-guide-ring'), false);
    await tick(t);
    await tick(t);
    assert.equal(h.reveals.length, 1, 'reveal is requested once per step');
    const ring = flat(h.find('quest-guide-ring').props.style);
    assert.equal((ring.top as number) + (ring.height as number) <= VIEWPORT.y + VIEWPORT.height, true);
  });

  it('draws nothing for a missing target and nothing at all without a session', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    await h.render({ ...spotlight(), targets: ['fx-submit'] });
    t.after(h.close);
    await tick(t);
    await tick(t);
    assert.equal(h.has('quest-guide-ring'), false);
    assert.equal(h.has('quest-guide-card'), false);
    await h.render({ kind: 'none' });
    assert.equal(h.renderer.toJSON() === null, true);
  });

  it('respects Reduced Motion: steady ring at once, no fade, no pulse, no confetti', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness(true);
    await h.render(spotlight());
    t.after(h.close);
    await tick(t);
    await measureCard(h, 90);
    assert.equal(h.has('quest-guide-ring'), true);
    assert.equal(h.loops.length, 0);
    assert.deepEqual(h.timings, [], 'no fade-in at all');
    const opacity = (id: string) => (flat(h.find(id).props.style).opacity as { value: number }).value;
    assert.equal(opacity('quest-guide-ring'), 1);
    assert.equal(opacity('quest-guide-spotlight'), 1);
    await h.render({ kind: 'celebration', key: '1:celebration', quest: 'exchange', title: '환전하기 퀘스트 완료!', summary: '받은 금액 USD 73.82', leaving: false });
    assert.equal(h.find('quest-guide-celebration-title').props.children, '환전하기 퀘스트 완료!');
    const pieces = h.renderer.root.findAll((node: any) => node.type === 'Animated.View' && flat(node.props.style).borderRadius === 2);
    assert.equal(pieces.length, 0, 'no confetti under Reduced Motion');
    assert.equal(h.find('quest-guide-celebration').props.pointerEvents === undefined, true, 'blocks touches during the return');
  });

  it('shows a short confetti burst with the completion copy', async t => {
    const h = harness();
    await h.render({ kind: 'celebration', key: '1:celebration', quest: 'transfer', title: '이체하기 퀘스트 완료!', summary: '보낸 금액 USD 10', leaving: false });
    t.after(h.close);
    assert.equal(h.find('quest-guide-celebration-title').props.children, '이체하기 퀘스트 완료!');
    const pieces = h.renderer.root.findAll((node: any) => node.type === 'Animated.View' && flat(node.props.style).borderRadius === 2);
    assert.equal(pieces.length, 26);
    assert.equal(h.find('quest-guide-celebration').props.accessibilityLiveRegion, 'assertive');
    // Every particle has a strong upward flight before falling; horizontal
    // spreading accelerates after launch, leaving the central badge readable.
    for (const piece of pieces) {
      const transforms = flat(piece.props.style).transform as any[];
      const up = transforms[1].translateY.interpolate;
      assert.equal(up.outputRange[0], 0);
      assert.equal(Math.min(...up.outputRange) < -170, true);
      assert.equal(up.outputRange.at(-1) > 0, true);
      assert.equal(up.outputRange[1] < -50, true, 'fast initial lift');
      const x = transforms[0].translateX.interpolate.outputRange;
      assert.equal(Math.abs(x[2]) < Math.abs(x.at(-1)) * 0.03, true, 'narrow initial launch');
      assert.equal(Math.abs(x[4]) > Math.abs(x.at(-1)) * 0.3, true, 'opens at the apex');
    }
  });

  it('uses a steady success badge and no confetti for a completed quest replay', async t => {
    const h = harness();
    await h.render({ kind: 'celebration', key: '2:celebration', quest: 'exchange', title: '실습을 완료했어요.', summary: '받은 금액 USD 10', leaving: false, replay: true });
    t.after(h.close);
    assert.equal(h.find('quest-guide-celebration-title').props.children, '실습을 완료했어요.');
    assert.equal(h.renderer.root.findAll((n: any) => n.props.testID === 'quest-confetti-piece').length, 0);
  });
});
