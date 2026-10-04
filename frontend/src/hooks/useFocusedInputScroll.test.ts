import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';
const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
const { load } = require('../../test/ledgerTestHarness.cjs');

it('keeps focused input and submit visible when they fit, prioritizing input on a short viewport', () => {
  const { getFocusedInputScrollDelta: delta } = load(resolve('src/hooks/useFocusedInputScroll.ts'), { 'react-native': {} });
  const viewport = { top: 80, bottom: 480 };
  assert.equal(delta(viewport, { top: 180, bottom: 230 }, { top: 350, bottom: 400 }), 0);
  assert.equal(delta(viewport, { top: 300, bottom: 350 }, { top: 480, bottom: 530 }), 62);
  assert.equal(delta(viewport, { top: 60, bottom: 110 }), -32);
  assert.equal(delta(viewport, { top: 420, bottom: 470 }, { top: 900, bottom: 950 }), 2);
  assert.equal(delta(viewport, { top: 120, bottom: 600 }), 28, 'oversized input starts at the visible top');
});

it('re-measures on keyboard/resize events, preserves manual scrolling and ignores late measurements after blur/unmount', async t => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map(), listeners = new Map();
  let next = 0;
  const previousRaf = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = cb => { frames.set(++next, cb); return next; };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  t.after(() => { globalThis.requestAnimationFrame = previousRaf; globalThis.cancelAnimationFrame = previousCancel; });
  const { useFocusedInputScroll } = load(resolve('src/hooks/useFocusedInputScroll.ts'), {
    'react-native': { Platform: { OS: 'ios' }, Keyboard: { addListener: (event, callback) => {
      listeners.set(event, callback); return { remove: () => listeners.delete(event) };
    } } },
  });
  let hook, renderer;
  function Probe() { hook = useFocusedInputScroll(); return null; }
  await act(async () => { renderer = create(React.createElement(Probe)); });
  const flushFrames = () => { const tasks = [...frames.values()]; frames.clear(); tasks.forEach(cb => cb()); };
  const scrolls = [];
  let viewportHeight = 650, inputY = 520, lateMeasurement;
  const input = { measureInWindow: cb => cb(0, inputY, 160, 48) };
  hook.scrollRef.current = {
    getNativeScrollRef: () => ({ measureInWindow: cb => cb(0, 80, 390, viewportHeight) }),
    scrollTo: args => scrolls.push(args),
  };
  hook.submitRef.current = { measureInWindow: cb => cb(0, inputY + 72, 160, 50) };
  hook.onScroll({ nativeEvent: { contentOffset: { y: 100 } } });
  hook.onInputFocus(input); flushFrames(); assert.deepEqual(scrolls, []);
  listeners.get('keyboardDidShow')({ endCoordinates: { screenY: 480 } }); flushFrames();
  assert.deepEqual(scrolls.at(-1), { y: 274, animated: false });
  viewportHeight = 280;
  hook.revealFocusedInput(); flushFrames();
  assert.deepEqual(scrolls.at(-1), { y: 394, animated: false });
  const count = scrolls.length;
  hook.onScroll({ nativeEvent: { contentOffset: { y: 250 } } });
  assert.equal(scrolls.length, count, 'manual scrolling does not snap back to the input');
  inputY = 600;
  listeners.get('keyboardWillChangeFrame')({ endCoordinates: { screenY: 400 } }); flushFrames();
  assert.deepEqual(scrolls.at(-1), { y: 624, animated: false });
  input.measureInWindow = cb => { lateMeasurement = cb; };
  hook.revealFocusedInput(); flushFrames(); hook.onInputBlur();
  const beforeBlur = scrolls.length;
  lateMeasurement(0, 600, 160, 48); assert.equal(scrolls.length, beforeBlur);
  hook.onInputFocus(input); flushFrames();
  listeners.get('keyboardDidHide')(); lateMeasurement(0, 600, 160, 48);
  assert.equal(scrolls.length, beforeBlur);
  hook.onInputFocus(input);
  await act(async () => renderer.unmount()); flushFrames();
  assert.equal(listeners.size, 0); assert.equal(frames.size, 0);
  assert.equal(scrolls.length, beforeBlur);
});
