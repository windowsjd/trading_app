import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');

test('logout presentation guards rapid activation, exposes loading and safely unmounts during teardown', async () => {
  const h = interactionHarness();
  const Button = h.load('src/components/common/LogoutButton.tsx', { './CTAButton': { default: 'CTAButton', __esModule: true } }).default;
  let finish!: () => void;
  let calls = 0;
  const renderer = h.render(React.createElement(Button, { testID: 'logout', onPress: () => {
    calls++; return new Promise<void>(resolve => { finish = resolve; });
  } }));
  const button = () => renderer.root.findByType('CTAButton');
  assert.equal(button().props.variant, 'logout'); assert.equal(button().props.label, '로그아웃');
  act(() => { button().props.onPress(); button().props.onPress(); });
  assert.equal(calls, 1); assert.equal(button().props.state, 'loading');
  await act(async () => finish());
  assert.equal(button().props.state, 'enabled');
  act(() => button().props.onPress()); assert.equal(calls, 2);
  act(() => renderer.unmount());
  await act(async () => finish());
});

test('MY and Settings pass their existing logout callback to the same presentation', () => {
  for (const name of ['MyScreen', 'SettingsScreen']) {
    const source = readFileSync(resolve(`src/screens/my/${name}.tsx`), 'utf8');
    assert.match(source, /const onLogout = useLogout\(\)/);
    assert.match(source, /<LogoutButton testID=\{TEST_IDS\.(my\.logoutMenu|settings\.logout)\} onPress=\{onLogout\}/);
  }
});
