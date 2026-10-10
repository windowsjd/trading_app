import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const Renderer = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('highlight measures the surface, sweeps every 2.5s and stops on reduced motion, exit and unmount', async t => {
  let reduced = false; let starts = 0; let stops = 0;
  const timings: any[] = [], delays: number[] = [];
  class Value { setValue() {} interpolate(config: unknown) { return config; } }
  const Highlight = load(resolve('src/features/quest/QuestTargetHighlight.tsx'), {
    'react-native': { View: 'View', Platform: { OS: 'ios' }, StyleSheet: { create: (x: unknown) => x, absoluteFill: {}, absoluteFillObject: {} },
      Easing: { linear: () => 0 }, Animated: { View: 'Animated.View', Value,
        timing: (_value: unknown, config: unknown) => { timings.push(config); return {}; },
        delay: (ms: number) => { delays.push(ms); return {}; }, sequence: () => ({}),
        loop: () => ({ start: () => { starts++; }, stop: () => { stops++; } }),
      } },
    '../../theme/useReducedMotion': { useReducedMotion: () => reduced },
    'react-native-svg': { default: 'Svg', Defs: 'Defs', LinearGradient: 'LinearGradient', Rect: 'Rect', Stop: 'Stop', __esModule: true },
  }).default;
  let renderer: any;
  const render = async (active = true) => Renderer.act(async () => {
    const element = React.createElement(Highlight, { active, radius: 12 });
    if (renderer) renderer.update(element); else renderer = Renderer.create(element);
  });
  const nodes = (id: string) => renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id);
  await render(); t.after(async () => { await Renderer.act(async () => renderer.unmount()); });
  assert.equal(nodes('quest-target-shimmer').length, 0, 'no motion until laid out');
  const host = nodes('quest-target-highlight')[0]; assert.equal(host.props.pointerEvents, 'none');
  assert.equal(host.props.importantForAccessibility, 'no-hide-descendants');
  await Renderer.act(async () => host.props.onLayout({ nativeEvent: { layout: { width: 52, height: 52 } } }));
  assert.equal(starts, 1); assert.equal(nodes('quest-target-glow').length, 1);
  assert.equal(nodes('quest-target-shimmer').length, 1);
  assert.equal(timings[0].duration, 720); assert.equal(timings[0].useNativeDriver, true);
  assert.equal(timings[0].duration + delays[0], 2500);
  const sweep = nodes('quest-target-shimmer')[0].props.style.transform[0].translateX;
  assert.equal(sweep.outputRange[0] < 0 && sweep.outputRange[1] > 52, true, 'left to right');
  reduced = true; await render(); assert.equal(stops, 1);
  assert.equal(nodes('quest-target-shimmer').length, 0); assert.equal(nodes('quest-target-glow').length, 1);
  reduced = false; await render(); assert.equal(starts, 2);
  await render(false); assert.equal(stops, 2); assert.equal(renderer.toJSON() === null, true);
  await render(); assert.equal(starts, 3);
  await Renderer.act(async () => renderer.unmount()); assert.equal(stops, 3);
});
