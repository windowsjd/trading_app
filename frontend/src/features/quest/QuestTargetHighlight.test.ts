import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const Renderer = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const flatten = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : (style as Record<string, unknown>) ?? {};

test('the highlight is a steady glow outside the control: nothing paints over it, nothing moves', async t => {
  const animations: string[] = [];
  const Highlight = load(resolve('src/features/quest/QuestTargetHighlight.tsx'), {
    'react-native': { View: 'View', Platform: { OS: 'android' },
      StyleSheet: { create: (x: unknown) => x, absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } },
      // Any motion would go through these; the highlight must not start one.
      Animated: { View: 'Animated.View', Value: class {}, timing: () => { animations.push('timing'); return { start() {} }; },
        loop: () => { animations.push('loop'); return { start() {}, stop() {} }; } } },
  }).default;
  let renderer: any;
  const render = async (active: boolean, radius = 12) => Renderer.act(async () => {
    const element = React.createElement(Highlight, { active, radius });
    if (renderer) renderer.update(element); else renderer = Renderer.create(element);
  });
  const hosts = () => renderer.root.findAll((n: any) => typeof n.type === 'string');
  await render(true); t.after(async () => { await Renderer.act(async () => renderer.unmount()); });

  const host = hosts().find((n: any) => n.props.testID === 'quest-target-highlight');
  assert.equal(host.props.pointerEvents, 'none', 'the control keeps every press');
  assert.equal(host.props.importantForAccessibility, 'no-hide-descendants');
  assert.deepEqual(hosts().map((n: any) => n.props.testID), ['quest-target-highlight', 'quest-target-glow'],
    'no fill, inner border or shine layer over the control');
  assert.equal(hosts().some((n: any) => n.type === 'Animated.View' || n.type === 'Svg'), false);
  assert.deepEqual(animations, []);

  const glow = flatten(hosts().find((n: any) => n.props.testID === 'quest-target-glow').props.style);
  const width = glow.borderWidth as number;
  assert.ok(width > 0);
  // The band spans [-width, 0] around the control: entirely outside its edge.
  assert.deepEqual([glow.top, glow.right, glow.bottom, glow.left], [-width, -width, -width, -width]);
  assert.equal(glow.backgroundColor, undefined, 'no tint over the control');
  assert.equal(glow.shadowRadius ?? glow.shadowOpacity ?? glow.elevation, undefined, 'no blurred shadow bleeding inward');
  assert.equal(glow.borderRadius, 12 + width, 'the inner corners follow the control radius');

  await render(false);
  assert.equal(renderer.toJSON() === null, true);
});
