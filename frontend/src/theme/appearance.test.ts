import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { create, act } = require('react-test-renderer');
const { load } = require('../../test/ledgerTestHarness.cjs');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function harness(saved: string | null = null, holdRead = false) {
  let scheme: 'light' | 'dark' = 'dark';
  let stored = saved;
  let failRead = false;
  let failWrite = false;
  const applied: Array<string | null> = [];
  let releaseRead = () => {};
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const storage = {
    getItem: async () => { if (holdRead) await readGate; if (failRead) throw Error('storage read failed'); return stored; },
    setItem: async (_key: string, value: string) => { if (failWrite) throw Error('storage write failed'); stored = value; },
  };
  const module = load(resolve('src/theme/appearance.tsx'), {
    react: React,
    'react-native': {
      Appearance: { setColorScheme: (value: string | null) => applied.push(value) },
      Platform: { OS: 'android' }, StatusBar: 'StatusBar', View: 'View',
      useColorScheme: () => scheme,
    },
    '@react-native-async-storage/async-storage': storage,
  });
  let current: any;
  function Probe() { current = module.useAppearance(); return React.createElement('Text', null, current.mode); }
  const element = () => React.createElement(module.AppearanceProvider, null, React.createElement(Probe));
  let renderer: any;
  return {
    module, applied, releaseRead,
    get current() { return current; }, get stored() { return stored; },
    setScheme: (next: 'light' | 'dark') => { scheme = next; },
    failRead: () => { failRead = true; }, failWrite: () => { failWrite = true; },
    mount: async () => { await act(async () => { renderer = create(element()); await Promise.resolve(); }); },
    rerender: async () => { await act(async () => renderer.update(element())); },
    choose: async (value: string) => { await act(async () => { current.setPreference(value); await Promise.resolve(); }); },
    close: async () => { if (renderer) await act(async () => renderer.unmount()); },
  };
}

test('system follows OS changes; explicit light/dark override and persist on this device', async (t) => {
  const h = harness(); t.after(h.close);
  await h.mount();
  assert.equal(h.current.preference, 'system'); assert.equal(h.current.mode, 'dark');
  assert.equal(h.applied.at(-1), null);
  h.setScheme('light'); await h.rerender(); assert.equal(h.current.mode, 'light');
  await h.choose('dark'); assert.equal(h.current.mode, 'dark'); assert.equal(h.stored, 'dark');
  assert.equal(h.applied.at(-1), 'dark');
  h.setScheme('dark'); await h.rerender();
  await h.choose('light'); assert.equal(h.current.mode, 'light'); assert.equal(h.applied.at(-1), 'light');
  await h.close(); await h.mount();
  assert.equal(h.current.preference, 'light'); assert.equal(h.current.mode, 'light');
  await h.choose('system'); assert.equal(h.current.mode, 'dark'); assert.equal(h.applied.at(-1), null);
});

test('invalid or failed device preference safely uses system', async (t) => {
  const invalid = harness('unexpected'); t.after(invalid.close);
  await invalid.mount(); assert.equal(invalid.current.preference, 'system');
  const failed = harness(); t.after(failed.close);
  failed.failRead(); await failed.mount(); assert.equal(failed.current.mode, 'dark');
  failed.failWrite(); await failed.choose('light');
  assert.equal(failed.current.preference, 'system'); assert.equal(failed.current.mode, 'dark');
});


test('stored dark choice is read before navigation children mount', async (t) => {
  const h = harness('dark', true); t.after(h.close);
  await h.mount();
  assert.equal(h.current, undefined, 'the child cannot paint with a temporary system theme');
  await act(async () => { h.releaseRead(); await Promise.resolve(); });
  assert.equal(h.current.preference, 'dark'); assert.equal(h.current.mode, 'dark');
});
