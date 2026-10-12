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
  it('keeps the pill and the selected label in sync with the caller, sliding on the shared motion', (t) => {
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
    act(() => renderer.root.findAll((n: any) => n.props.testID === 'seg' && typeof n.type === 'string')[0].props.onLayout({ nativeEvent: { layout: { width: 306 } } }));
    const pill = () => renderer.root.findAll((n: any) => n.props.testID === 'seg-indicator')[0];
    assert.equal(flatten(pill().props.style).width, 100);
    assert.equal(h.animations.length, 0, 'mount does not animate');
    act(() => renderer.update(render('c')));
    act(() => renderer.update(render('b')));
    const [first, second] = h.animations;
    assert.deepEqual([first.options.toValue, second.options.toValue], [2, 1]);
    assert.equal(first.options.duration, module.selectionMotion.duration);
    assert.equal(first.value.animation === first, false, 'a rapid second change continues from the current point');
    assert.deepEqual(flatten(pill().props.style).transform[0].translateX.outputRange, [0, 300]);
    h.finish();
    assert.equal(second.value.value, 1);
    assert.equal(node('seg-b').props.accessibilityState.selected, true);
    assert.equal(module.selectionEasing(0.22) > 0.5 && module.selectionEasing(0.67) > 0.95, true, 'reference: ~50% then ~96%');
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
