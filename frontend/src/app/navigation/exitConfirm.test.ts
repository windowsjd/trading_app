import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { EXIT_CONFIRM_MESSAGE, EXIT_CONFIRM_WINDOW_MS, createExitConfirm } from './exitConfirm.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');

function confirm(canGoBack = () => false) {
  let clock = 1000;
  const notices: string[] = [];
  const press = createExitConfirm({ canGoBack, notify: (message) => notices.push(message), now: () => clock });
  return { press, notices, wait: (ms: number) => { clock += ms; } };
}

describe('Android exit confirmation (the Back that would leave the app)', () => {
  it('a Back the navigators handle passes through untouched and asks nothing', () => {
    const c = confirm(() => true);
    for (let i = 0; i < 3; i++) assert.equal(c.press(), false);
    assert.deepEqual(c.notices, []);
  });

  it('first Back asks and keeps the app; a second within the window lets the system leave', () => {
    const c = confirm();
    assert.equal(c.press(), true);
    assert.deepEqual(c.notices, [EXIT_CONFIRM_MESSAGE]);
    c.wait(EXIT_CONFIRM_WINDOW_MS - 1);
    assert.equal(c.press(), false, 'the system default: task to the background');
    assert.equal(c.notices.length, 1);
  });

  it('a second Back after the window asks again; leaving needs two presses each time', () => {
    const c = confirm();
    assert.equal(c.press(), true);
    c.wait(EXIT_CONFIRM_WINDOW_MS);
    assert.equal(c.press(), true);
    assert.equal(c.notices.length, 2);
    assert.equal(c.press(), false);
    // Back in the app later: the next leave asks first again.
    c.wait(10);
    assert.equal(c.press(), true);
  });

  it('only Android listens, after navigation, and removes its listener on unmount', () => {
    for (const platform of ['android', 'ios', 'web']) {
      const h = interactionHarness(platform);
      const listeners: Array<() => boolean> = [];
      const toasts: unknown[][] = [];
      let canGoBack = false;
      h.native.BackHandler = { addEventListener: (event: string, listener: () => boolean) => {
        assert.equal(event, 'hardwareBackPress');
        listeners.push(listener);
        return { remove: () => listeners.splice(listeners.indexOf(listener), 1) };
      } };
      h.native.ToastAndroid = { SHORT: 'short', show: (...args: unknown[]) => toasts.push(args) };
      const AndroidExitConfirm = h.load('src/app/navigation/AndroidExitConfirm.tsx', {
        './navigationRef': { rootNavigationRef: { isReady: () => true, canGoBack: () => canGoBack } },
      }).default;
      const renderer = h.render(React.createElement(AndroidExitConfirm));
      assert.equal(renderer.toJSON(), null, 'draws nothing');
      if (platform !== 'android') {
        assert.equal(listeners.length, 0, platform);
        continue;
      }
      assert.equal(listeners.length, 1);
      canGoBack = true;
      assert.equal(listeners[0](), false, 'navigation goes back itself');
      canGoBack = false;
      assert.equal(listeners[0](), true);
      assert.deepEqual(toasts, [[EXIT_CONFIRM_MESSAGE, 'short']]);
      act(() => renderer.unmount());
      assert.equal(listeners.length, 0);
    }
  });

  it('is mounted once inside navigation', () => {
    const root = readFileSync(resolve('src/app/navigation/RootNavigator.tsx'), 'utf8');
    assert.equal(root.match(/<AndroidExitConfirm \/>/g)?.length, 1);
    assert.ok(root.indexOf('<AndroidExitConfirm />') < root.indexOf('</NavigationContainer>'));
  });
});
