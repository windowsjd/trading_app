import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it, type TestContext } from 'node:test';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const id = 'execution-gap-protection';

function setup(t: TestContext, params?: { noticeId?: string }) {
  const h = interactionHarness();
  h.scrolls = [];
  h.native.ScrollView = ({ ref, ...props }: any) => {
    React.useImperativeHandle(ref, () => ({ scrollTo: (options: any) => h.scrolls.push(options) }), []);
    return React.createElement('ScrollView', props);
  };
  const Screen = h.load('src/screens/my/NoticesScreen.tsx', {
    '../../components/states/EmptyState': { __esModule: true, default: 'EmptyState' },
  }).default;
  const element = (next = params) => React.createElement(Screen, { route: { params: next }, navigation: {} });
  h.renderer = h.render(element());
  h.update = (next?: { noticeId?: string }) => act(() => h.renderer.update(element(next)));
  h.find = (testID: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === testID)[0];
  t.after(() => act(() => h.renderer.unmount()));
  return h;
}

it('lists the execution gap notice collapsed, and its header toggles the content', (t) => {
  const h = setup(t);
  const toggle = h.find(`notice-${id}-toggle`);
  assert.equal(toggle.props.accessibilityRole, 'button');
  assert.equal(toggle.props.accessibilityState.expanded, false);
  assert.equal(toggle.props.accessibilityLabel, '체결괴리 방지시스템 안내, 2026.10.12');
  assert.equal(h.find(`notice-${id}-body`) === undefined, true);
  act(() => toggle.props.onPress());
  assert.equal(h.find(`notice-${id}-toggle`).props.accessibilityState.expanded, true);
  assert.equal(h.find(`notice-${id}-body`) !== undefined, true);
  act(() => h.find(`notice-${id}-toggle`).props.onPress());
  assert.equal(h.find(`notice-${id}-body`) === undefined, true);
  assert.equal(h.renderer.root.findAllByType('EmptyState').length, 0);
});

it('a link with noticeId opens that notice and scrolls to it, also when the screen is already open', (t) => {
  const h = setup(t, { noticeId: id });
  assert.equal(h.find(`notice-${id}-body`) !== undefined, true);
  act(() => h.find(`notice-${id}`).props.onLayout({ nativeEvent: { layout: { y: 240 } } }));
  assert.deepEqual(h.scrolls, [{ y: 240, animated: false }]);
  const reopened = setup(t);
  assert.equal(reopened.find(`notice-${id}-body`) === undefined, true);
  reopened.update({ noticeId: id });
  assert.equal(reopened.find(`notice-${id}-body`) !== undefined, true);
});
