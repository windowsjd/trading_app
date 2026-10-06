import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
const { load } = require('../../test/ledgerTestHarness.cjs');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('unknown preference is motion-safe; a late initial read cannot override a live change', async () => {
  let resolveRead!: (value: boolean) => void;
  let change!: (value: boolean) => void;
  const { useReducedMotion } = load(resolve('src/theme/useReducedMotion.ts'), {
    'react-native': { Platform: { OS: 'android' }, AccessibilityInfo: {
      isReduceMotionEnabled: () => new Promise<boolean>(resolve => { resolveRead = resolve; }),
      addEventListener: (_: string, callback: typeof change) => { change = callback; return { remove() {} }; },
    } },
  });
  let current: boolean | undefined, renderer: any;
  function Probe() { current = useReducedMotion(); return null; }
  act(() => { renderer = create(React.createElement(Probe)); });
  assert.equal(current, true);
  act(() => change(true));
  await act(async () => resolveRead(false));
  assert.equal(current, true);
  act(() => renderer.unmount());
});

for (const platform of ['android', 'ios']) {
  test(`${platform}: resolves OS setting, updates live and removes its subscription`, async () => {
    let listener: (value: boolean) => void = () => {};
    let removed = 0;
    const { useReducedMotion } = load(resolve('src/theme/useReducedMotion.ts'), {
      'react-native': {
        Platform: { OS: platform },
        AccessibilityInfo: {
          isReduceMotionEnabled: async () => true,
          addEventListener: (name: string, callback: typeof listener) => {
            assert.equal(name, 'reduceMotionChanged'); listener = callback;
            return { remove: () => removed++ };
          },
        },
      },
    });
    function Probe() { return React.createElement('Value', { reduced: useReducedMotion() }); }
    let renderer: any;
    await act(async () => { renderer = create(React.createElement(Probe)); });
    assert.equal(renderer.root.findByType('Value').props.reduced, true);
    act(() => listener(false));
    assert.equal(renderer.root.findByType('Value').props.reduced, false);
    act(() => listener(true));
    assert.equal(renderer.root.findByType('Value').props.reduced, true);
    act(() => renderer.unmount());
    assert.equal(removed, 1);
  });
}

test('web follows prefers-reduced-motion and cleans up on unmount', async () => {
  const previous = (globalThis as any).window;
  let listener: (event: { matches: boolean }) => void = () => {};
  let removed = 0;
  (globalThis as any).window = { matchMedia: (query: string) => {
    assert.equal(query, '(prefers-reduced-motion: reduce)');
    return { matches: true, addEventListener: (_: string, callback: typeof listener) => { listener = callback; }, removeEventListener: () => removed++ };
  } };
  let renderer: any;
  try {
    const { useReducedMotion } = load(resolve('src/theme/useReducedMotion.ts'), { 'react-native': { Platform: { OS: 'web' } } });
    function Probe() { return React.createElement('Value', { reduced: useReducedMotion() }); }
    await act(async () => { renderer = create(React.createElement(Probe)); });
    assert.equal(renderer.root.findByType('Value').props.reduced, true);
    act(() => listener({ matches: false }));
    assert.equal(renderer.root.findByType('Value').props.reduced, false);
  } finally {
    act(() => renderer?.unmount());
    if (previous === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previous;
  }
  assert.equal(removed, 1);
});

test('failed native preference read retains static feedback policy', async () => {
  const { useReducedMotion } = load(resolve('src/theme/useReducedMotion.ts'), {
    'react-native': { Platform: { OS: 'ios' }, AccessibilityInfo: {
      isReduceMotionEnabled: async () => { throw Error('unavailable'); },
      addEventListener: () => ({ remove() {} }),
    } },
  });
  let current: boolean | undefined, renderer: any;
  function Probe() { current = useReducedMotion(); return null; }
  await act(async () => { renderer = create(React.createElement(Probe)); });
  assert.equal(current, true);
  act(() => renderer.unmount());
});
