import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';
const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
const { load } = require('../../test/ledgerTestHarness.cjs');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function harness(os: 'android' | 'ios', keyboard: { visible?: boolean; height?: number } = {}) {
  const h: any = { listeners: new Map(), latest: null };
  const { useKeyboardCover } = load(resolve('src/hooks/useKeyboardCover.tsx'), {
    'react-native': {
      Platform: { OS: os },
      Keyboard: {
        addListener: (event: string, callback: (e: unknown) => void) => {
          h.listeners.set(event, callback);
          return { remove: () => h.listeners.delete(event) };
        },
        isVisible: () => !!keyboard.visible,
        metrics: () => keyboard.visible ? { screenY: 500, height: keyboard.height ?? 0, screenX: 0, width: 390 } : undefined,
      },
    },
  });
  function Probe({ enabled, inset }: { enabled: boolean; inset: number }) {
    h.latest = useKeyboardCover(enabled, inset);
    return null;
  }
  h.render = (enabled = true, inset = 48) => act(() => {
    const element = React.createElement(Probe, { enabled, inset });
    if (h.renderer) h.renderer.update(element); else h.renderer = create(element);
  });
  h.emit = (event: string, payload?: unknown) => act(() => h.listeners.get(event)?.(payload));
  return h;
}

it('android: the keyboard covers its reported height plus the navigation bar area', () => {
  const h = harness('android');
  h.render();
  assert.deepEqual([...h.listeners.keys()].sort(), ['keyboardDidHide', 'keyboardDidShow']);
  assert.equal(h.latest, 0);
  // `height` leaves out the 48pt navigation bar the keyboard also covers (edge to edge).
  h.emit('keyboardDidShow', { endCoordinates: { screenY: 420, height: 312 } });
  assert.equal(h.latest, 360);
  // The hide event's screenY is the visible area's height, never used here.
  h.emit('keyboardDidHide', { endCoordinates: { screenY: 724, height: 0 } });
  assert.equal(h.latest, 0);
  act(() => h.renderer.unmount());
  assert.equal(h.listeners.size, 0);
});

it('ios: listens before the keyboard moves, its height already counts the home indicator; disabled targets do not listen', () => {
  const h = harness('ios');
  h.render(false, 34);
  assert.equal(h.listeners.size, 0);
  h.render(true, 34);
  assert.deepEqual([...h.listeners.keys()].sort(), ['keyboardWillHide', 'keyboardWillShow']);
  h.emit('keyboardWillShow', { endCoordinates: { screenY: 508, height: 336 } });
  assert.equal(h.latest, 336);
  h.render(false, 34);
  assert.equal(h.latest, 0, 'closing the target forgets the keyboard');
  assert.equal(h.listeners.size, 0);
  act(() => h.renderer.unmount());
});

it('opened while the keyboard is already up, the cover is known at once', () => {
  const h = harness('android', { visible: true, height: 300 });
  h.render(true, 24);
  assert.equal(h.latest, 324);
  act(() => h.renderer.unmount());
});
