import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

it('renders beta from server metadata and keeps the season name intact', t => {
  const ui = interactionHarness('android');
  const Title = ui.load('src/components/tradingAccount/SeasonTitle.tsx').default;
  const renderer = ui.render(React.createElement(Title, { name: 'season0', displayBadge: 'beta', testID: 'title', heading: true }));
  t.after(() => act(() => renderer.unmount()));
  const label = () => renderer.root.findAllByType('Text').map((n: any) => n.props.children);
  assert.deepEqual(label(), ['season0', 'beta']);
  const badge = renderer.root.findAll((n: any) => n.type === 'View' && n.props.testID === 'title-beta');
  assert.equal(badge.length, 1);
  const style = flatten(badge[0].props.style);
  assert.equal(style.backgroundColor, '#565B63');
  assert.equal(style.minHeight, 20);
  assert.equal(style.height === undefined, true, 'badge may grow with font scaling');
  const group = renderer.root.findAll((n: any) => n.type === 'View' && n.props.accessible === true)[0];
  assert.equal(group.props.accessibilityLabel, 'season0, beta');
  assert.equal(group.props.accessibilityRole, 'header');
  assert.equal(flatten(group.props.style).flexWrap, 'wrap');
  act(() => renderer.update(React.createElement(Title, { name: 'season0', testID: 'title' })));
  assert.deepEqual(label(), ['season0'], 'reusable name alone never enables beta');
  act(() => renderer.update(React.createElement(Title, { name: 'Season 1', testID: 'title' })));
  assert.deepEqual(label(), ['Season 1']);
});
