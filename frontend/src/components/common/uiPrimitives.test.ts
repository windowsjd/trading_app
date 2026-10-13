import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const appearance = { useAppearance: () => ({ mode: 'light', colors: { screen: '#fcfcfd' } }) };

function loader(platform = 'android') {
  const h = interactionHarness(platform);
  const module = h.load('src/components/states/WhaleLoader.tsx', { '../../theme/appearance': appearance });
  return { h, WhaleLoader: module.default, module };
}

describe('WhaleLoader', () => {
  for (const platform of ['android', 'web']) {
    it(`${platform}: unknown progress circles the ring on one native loop and claims no value`, (t) => {
      const { h, WhaleLoader, module } = loader(platform);
      const renderer = h.render(React.createElement(WhaleLoader, { size: 56 }));
      t.after(() => act(() => renderer.unmount()));
      const root = renderer.root.findAll((n: any) => n.props.accessibilityRole === 'progressbar')[0];
      assert.equal(root.props.accessibilityValue, undefined, 'no invented percentage');
      assert.equal(root.props.accessibilityState.busy, true);
      assert.equal(h.loops.length, 1);
      assert.equal(h.loops[0].options.duration, module.WHALE_LOADER_LAP_MS);
      assert.equal(h.loops[0].options.useNativeDriver, platform !== 'web');
      const spinner = renderer.root.findAllByType('AnimatedView')[0];
      assert.deepEqual(flatten(spinner.props.style).transform[0].rotate.outputRange, ['0deg', '360deg']);
      // The whale glyph is drawn inside the ring.
      assert.ok(renderer.root.findAllByType('Path').some((n: any) => n.props.d === module.WHALE_PATH));
    });
  }

  it('known progress fills clockwise and never shows 100% before the caller finishes', (t) => {
    const { h, WhaleLoader, module } = loader();
    const renderer = h.render(React.createElement(WhaleLoader, { progress: 0.5 }));
    t.after(() => act(() => renderer.unmount()));
    const value = () => renderer.root.findAll((n: any) => n.props.accessibilityRole === 'progressbar')[0].props.accessibilityValue;
    assert.deepEqual(value(), { min: 0, max: 100, now: 50 });
    assert.equal(h.loops.length, 0, 'a determinate ring does not spin');
    act(() => renderer.update(React.createElement(WhaleLoader, { progress: 1 })));
    assert.equal(value().now, 99);
    for (const unknown of [Number.NaN, null, undefined]) assert.equal(module.displayedProgress(unknown), null);
    assert.equal(module.displayedProgress(-1), 0);
  });

  it('Reduced Motion: a still ring and whale, no rotating or partial arc', (t) => {
    const { h, WhaleLoader, module } = loader();
    h.reduced = true;
    const renderer = h.render(React.createElement(WhaleLoader, { size: 56 }));
    t.after(() => act(() => renderer.unmount()));
    assert.equal(h.loops.length, 0);
    assert.equal(renderer.root.findAllByType('AnimatedView').length, 0);
    assert.equal(renderer.root.findAllByType('Path').filter((n: any) => n.props.strokeDasharray).length, 0);
    assert.ok(renderer.root.findAllByType('Path').some((n: any) => n.props.d === module.WHALE_PATH));
  });

  it('on a filled action it is white so a busy button never turns dark', (t) => {
    const { h, WhaleLoader, module } = loader();
    const renderer = h.render(React.createElement(WhaleLoader, { size: 21, tone: 'onAction' }));
    t.after(() => act(() => renderer.unmount()));
    const whale = renderer.root.findAllByType('Path').find((n: any) => n.props.d === module.WHALE_PATH);
    assert.equal(whale.props.fill, '#FFFFFF');
  });
});

function segmented(platform = 'android') {
  const h = interactionHarness(platform);
  const module = h.load('src/components/common/SegmentedControl.tsx', {
    '../../theme/appearance': appearance,
    './ActionPressable': { default: h.ActionPressable, __esModule: true },
  });
  return { h, Segmented: module.default, module };
}

describe('SegmentedControl', () => {
  const options = [{ key: 'a', label: '국내주식', testID: 'seg-a' }, { key: 'b', label: '미국주식', testID: 'seg-b' }, { key: 'c', label: '암호화폐', testID: 'seg-c' }];
  const track = (renderer: any, width: number) => act(() => renderer.root.findAll((n: any) => n.props.testID === 'seg' && typeof n.type === 'string')[0]
    .props.onLayout({ nativeEvent: { layout: { width } } }));
  it('keeps the pill and the selected label in sync with the caller, sliding on one native spring', (t) => {
    let now = 1000;
    t.mock.method(performance, 'now', () => now);
    const { h, Segmented, module } = segmented();
    const changes: string[] = [];
    const render = (value: string) => React.createElement(Segmented, { testID: 'seg', value, options, onChange: (key: string) => changes.push(key) });
    const renderer = h.render(render('a'));
    t.after(() => act(() => renderer.unmount()));
    const node = (id: string) => renderer.root.findAll((n: any) => n.props.testID === id && n.type === 'Pressable')[0];
    assert.equal(renderer.root.findAll((n: any) => n.props.testID === 'seg' && typeof n.type === 'string')[0].props.accessibilityRole, 'tablist');
    // Before measurement the selected segment paints the pill itself.
    assert.ok(flatten(node('seg-a').props.style).backgroundColor);
    assert.equal(flatten(node('seg-b').props.style).backgroundColor, undefined);
    act(() => node('seg-a').props.onPress());
    assert.deepEqual(changes, [], 'the selected segment reports nothing');
    act(() => node('seg-b').props.onPress());
    assert.deepEqual(changes, ['b']);
    assert.equal(node('seg-a').props.accessibilityState.selected, true, 'the caller owns the value');
    track(renderer, 306);
    const pill = () => renderer.root.findAll((n: any) => n.props.testID === 'seg-indicator')[0];
    const translate = () => flatten(pill().props.style).transform[0].translateX;
    assert.equal(flatten(pill().props.style).width, 100);
    assert.equal(h.animations.length, 0, 'mount does not animate');
    const measured = translate();
    act(() => renderer.update(render('b')));
    now += 40;
    act(() => renderer.update(render('c')));
    const [first, second] = h.animations;
    assert.deepEqual([first.type, second.type], ['spring', 'spring']);
    assert.deepEqual([first.options.toValue, second.options.toValue], [1, 2]);
    const { stiffness, damping, mass, push } = module.selectionMotion;
    assert.equal(damping, 2 * Math.sqrt(stiffness * mass), 'critically damped: no bounce');
    assert.deepEqual([first.options.stiffness, first.options.damping, first.options.mass], [stiffness, damping, mass]);
    assert.equal(first.options.overshootClamping, true);
    assert.equal(first.options.useNativeDriver, true); assert.equal(first.options.isInteraction, false);
    assert.equal(first.options.velocity, push, 'a light push toward the next segment');
    assert.equal(first.value.animation === first, false, 'a rapid second change stops the first run');
    // The second run leaves from the first run's point with its momentum: no stall.
    const run = module.selectionState({ from: 0, to: 1, velocity: push, at: 0 }, 0.04);
    assert.equal(second.options.velocity, module.selectionLaunchVelocity(run.position, run.velocity, 2));
    assert.equal(second.options.velocity > push * (2 - run.position), true, 'faster than a fresh start');
    assert.equal(translate() === measured, true, 're-renders keep one native interpolation node');
    assert.deepEqual(translate().outputRange, [0, 300]);
    h.finish();
    assert.equal(second.value.value, 2);
    assert.equal(node('seg-c').props.accessibilityState.selected, true);
  });

  it('reverses mid-slide from its momentum without passing the new target', (t) => {
    let now = 1000;
    t.mock.method(performance, 'now', () => now);
    const { h, Segmented, module } = segmented();
    const render = (value: string) => React.createElement(Segmented, { testID: 'seg', value, options, onChange() {} });
    const renderer = h.render(render('a'));
    t.after(() => act(() => renderer.unmount()));
    act(() => renderer.update(render('c')));
    now += 40;
    act(() => renderer.update(render('a')));
    const [, back] = h.animations;
    assert.equal(back.options.toValue, 0);
    const from = module.selectionState({ from: 0, to: 2, velocity: module.selectionMotion.push * 2, at: 0 }, 0.04);
    const reversal = { from: from.position, to: 0, velocity: back.options.velocity, at: 0 };
    let farthest = from.position, nearest = Infinity;
    for (let ms = 0; ms <= 400; ms += 4) {
      const { position } = module.selectionState(reversal, ms / 1000);
      farthest = Math.max(farthest, position); nearest = Math.min(nearest, position);
    }
    assert.equal(farthest - from.position < 0.05, true, `momentum carries it on only briefly (${farthest - from.position})`);
    assert.equal(nearest >= 0, true, 'never past the new target');
    assert.equal(module.selectionState(reversal, 0.25).position < 0.05 * from.position, true, 'arrives within 250ms');
  });

  it('starts at once, settles in about 170ms and never overshoots for any momentum', () => {
    const { module } = segmented();
    const at = (ms: number) => module.selectionState({ from: 0, to: 1, velocity: module.selectionMotion.push, at: 0 }, ms / 1000).position;
    assert.equal(at(1000 / 60) > 0.1 && at(1000 / 60) < 0.3, true, 'the first 60Hz frame moves, without the old one-frame jump');
    assert.equal(at(167) >= 0.94 && at(250) >= 0.99, true);
    for (let ms = 4; ms <= 500; ms += 4) assert.equal(at(ms) >= at(ms - 4) && at(ms) <= 1, true, `monotonic at ${ms}ms`);
    let worst = 0;
    for (let position = -2; position <= 2; position += 0.25) {
      for (let velocity = -80; velocity <= 80; velocity += 5) {
        for (const to of [0, 1, 2]) {
          if (position === to) continue;
          const run = { from: position, to, velocity: module.selectionLaunchVelocity(position, velocity, to), at: 0 };
          for (let ms = 0; ms <= 600; ms += 3) worst = Math.max(worst, (module.selectionState(run, ms / 1000).position - to) * Math.sign(to - position));
        }
      }
    }
    assert.equal(worst <= 1e-9, true, `overshoot ${worst}`);
  });

  it('a refused choice never moves the pill; unmounting mid-slide stops it and a remount lands on the value', (t) => {
    const { h, Segmented } = segmented();
    // A guarded caller (learning lock) ignores the request.
    const render = (value: string) => React.createElement(Segmented, { testID: 'seg', value, options, onChange() {} });
    let renderer = h.render(render('a'));
    const node = (id: string) => renderer.root.findAll((n: any) => n.props.testID === id && n.type === 'Pressable')[0];
    act(() => node('seg-b').props.onPress());
    assert.equal(h.animations.length, 0);
    assert.equal(node('seg-a').props.accessibilityState.selected, true);
    act(() => renderer.update(render('b')));
    const [slide] = h.animations;
    act(() => renderer.unmount());
    assert.equal(slide.value.animation === null, true, 'no run outlives its control');
    renderer = h.render(render('c'));
    t.after(() => act(() => renderer.unmount()));
    track(renderer, 306);
    assert.equal(h.animations.length, 1, 'a remount lands without a slide');
    const pill = renderer.root.findAll((n: any) => n.props.testID === 'seg-indicator')[0];
    assert.equal(flatten(pill.props.style).transform[0].translateX.value.value, 2);
  });

  it('Reduced Motion jumps; disabled options refuse input; compact keeps a 44dp target', (t) => {
    const { h, Segmented } = segmented();
    h.reduced = true;
    const opts = options.map(o => ({ ...o, disabled: o.key === 'c' }));
    const render = (value: string) => React.createElement(Segmented, { value, options: opts, onChange() {}, compact: true });
    const renderer = h.render(render('a'));
    t.after(() => act(() => renderer.unmount()));
    act(() => renderer.update(render('b')));
    assert.equal(h.animations.length, 0);
    const c = renderer.root.findAll((n: any) => n.props.testID === 'seg-c' && n.type === 'Pressable')[0];
    assert.equal(c.props.disabled, true);
    assert.equal(c.props.onPress, undefined);
    const style = flatten(c.props.style);
    assert.ok(style.minHeight + c.props.hitSlop.top + c.props.hitSlop.bottom >= 44);
  });
});

function sheet(platform = 'android') {
  const h = interactionHarness(platform);
  const back: Array<() => boolean> = [];
  h.native.BackHandler = { addEventListener: (_event: string, handler: () => boolean) => { back.push(handler); return { remove: () => back.splice(back.indexOf(handler), 1) }; } };
  h.native.Keyboard = { addListener: () => ({ remove() {} }), dismiss() {} };
  const Sheet = h.load('src/components/common/InlineBottomSheet.tsx', {
    '../../theme/safeArea': { useSafeAreaInsets: () => ({ bottom: 34, top: 0 }) },
    './ActionPressable': { default: h.ActionPressable, __esModule: true },
  }).default;
  return { h, Sheet, back };
}

describe('InlineBottomSheet', () => {
  it('rises from the bottom, closes by backdrop/close/back, and keeps the content mounted while closing', (t) => {
    const { h, Sheet, back } = sheet();
    let closes = 0;
    const render = (visible: boolean, dismissible = true) => React.createElement(Sheet, { visible, dismissible, title: '이체하기', testID: 'sheet', onClose: () => closes++ },
      React.createElement('Text', null, 'content'));
    const renderer = h.render(render(false));
    t.after(() => act(() => renderer.unmount()));
    assert.equal(renderer.root.findAll((n: any) => n.props.testID === 'sheet' && typeof n.type === 'string').length, 0, 'closed sheets mount nothing');
    act(() => renderer.update(render(true)));
    const open = h.animations.at(-1);
    assert.equal(open.options.toValue, 1);
    const frame = renderer.root.findAllByType('AnimatedView').find((n: any) => flatten(n.props.style).transform);
    assert.deepEqual(flatten(frame.props.style).transform[0].translateY.outputRange, [h.dimensions.height, 0]);
    act(() => renderer.root.findAll((n: any) => n.props.testID === 'sheet-backdrop')[0].props.onPress());
    act(() => renderer.root.findAll((n: any) => n.props.testID === 'sheet-close' && n.type === 'Pressable')[0].props.onPress());
    assert.equal(back[0](), true); assert.equal(closes, 3);
    act(() => renderer.update(render(false)));
    assert.equal(h.animations.at(-1).options.toValue, 0);
    assert.ok(renderer.root.findAll((n: any) => n.props.testID === 'sheet' && typeof n.type === 'string').length > 0, 'the closing motion keeps the content');
    h.finish();
    assert.equal(renderer.root.findAll((n: any) => n.props.testID === 'sheet' && typeof n.type === 'string').length, 0);
  });

  it('a command in flight makes every close path inert (never a cancel)', (t) => {
    const { h, Sheet, back } = sheet();
    let closes = 0;
    const renderer = h.render(React.createElement(Sheet, { visible: true, dismissible: false, title: '이체하기', testID: 'sheet', onClose: () => closes++ }, null));
    t.after(() => act(() => renderer.unmount()));
    act(() => renderer.root.findAll((n: any) => n.props.testID === 'sheet-backdrop')[0].props.onPress());
    const close = renderer.root.findAll((n: any) => n.props.testID === 'sheet-close' && n.type === 'Pressable')[0];
    assert.equal(close.props.disabled, true);
    assert.equal(back[0](), true, 'Android back is consumed, not passed to navigation');
    assert.equal(closes, 0);
  });
});
