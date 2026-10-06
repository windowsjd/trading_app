import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { Appearance } from 'react-native';
import { logoutGradient } from './tokens.ts';

type NativeColorScheme = Parameters<typeof Appearance.setColorScheme>[0];

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
function contrast(foreground: string, background: string) {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const require = createRequire(import.meta.url);
const React = require('react');
const { create, act } = require('react-test-renderer');
const { load } = require('../../test/ledgerTestHarness.cjs');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function harness(saved: string | null = null, holdRead = false) {
  let scheme: 'light' | 'dark' = 'dark';
  const values = new Map<string, string | null>([['trading-app:appearance', saved]]);
  let failRead = false;
  let failWrite = false;
  const applied: NativeColorScheme[] = [];
  let releaseRead = () => {};
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const storage = {
    getItem: async (key: string) => { if (holdRead) await readGate; if (failRead) throw Error('storage read failed'); return values.get(key) ?? null; },
    setItem: async (key: string, value: string) => { if (failWrite) throw Error('storage write failed'); values.set(key, value); },
  };
  const module = load(resolve('src/theme/appearance.tsx'), {
    react: React,
    'react-native': {
      Appearance: { setColorScheme: (value: NativeColorScheme): void => {
        assert.ok(value === 'light' || value === 'dark' || value === 'unspecified', 'native setColorScheme requires light, dark or unspecified; null is invalid');
        applied.push(value);
      } },
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
    module, applied, releaseRead, values,
    get rendered() { return renderer.toJSON(); },
    get current() { return current; }, get stored() { return values.get('trading-app:appearance'); },
    setScheme: (next: 'light' | 'dark') => { scheme = next; },
    failRead: () => { failRead = true; }, failWrite: () => { failWrite = true; },
    mount: async () => { await act(async () => { renderer = create(element()); await Promise.resolve(); }); },
    rerender: async () => { await act(async () => renderer.update(element())); },
    choose: async (value: string) => { await act(async () => { current.setPreference(value); await Promise.resolve(); }); },
    chooseFinancial: async (value: string) => { await act(async () => { current.setFinancialPreference(value); await Promise.resolve(); }); },
    close: async () => { if (renderer) await act(async () => renderer.unmount()); },
  };
}

test('dark neutral surfaces preserve hierarchy and improve text and secondary accent contrast', () => {
  const { dark } = harness().module.PALETTES;
  assert.ok(luminance(dark.screen) < luminance(dark.surface));
  assert.ok(luminance(dark.surface) < luminance(dark.raised));
  for (const [background, previous] of [[dark.surface, '#1b2530'], [dark.input, '#273543']]) {
    for (const role of ['text', 'secondary', 'muted', 'placeholder'] as const) {
      assert.ok(contrast(dark[role], background) >= 4.5, `${role} on ${background}`);
      assert.ok(contrast(dark[role], background) >= contrast(dark[role], previous));
    }
  }
  assert.ok(contrast(dark.secondaryActionForeground, dark.secondaryActionSurface) >= 4.5);
  assert.ok(contrast(dark.secondaryActionSurface, dark.surface) > contrast(dark.secondaryActionSurface, '#1b2530'));
});

test('action colors retain small-label contrast without borrowing financial or error tokens', () => {
  const { dark, light } = harness().module.PALETTES;
  assert.ok(contrast(dark.secondaryActionForeground, dark.secondaryActionSurface) >= 5);
  assert.ok(luminance(dark.secondaryActionSurface) > luminance('#1C3042'));
  assert.equal(light.secondaryActionSurface, '#EAF4FC');
  assert.equal(light.secondaryActionForeground, '#285B85');
  for (const color of logoutGradient.colors) assert.ok(contrast('#FFFFFF', color) >= 4.5);
  assert.equal(light.error, '#b32d2d'); assert.equal(dark.error, '#ff8585');
});

test('system follows OS changes; explicit light/dark override and persist on this device', async (t) => {
  const h = harness('system'); t.after(h.close);
  await h.mount();
  assert.equal(h.current.preference, 'system'); assert.equal(h.current.mode, 'dark');
  assert.equal(h.applied.at(-1), 'unspecified');
  h.setScheme('light'); await h.rerender(); assert.equal(h.current.mode, 'light');
  await h.choose('dark'); assert.equal(h.current.mode, 'dark'); assert.equal(h.stored, 'dark');
  assert.equal(h.applied.at(-1), 'dark');
  h.setScheme('dark'); await h.rerender();
  await h.choose('light'); assert.equal(h.current.mode, 'light'); assert.equal(h.applied.at(-1), 'light');
  await h.close(); await h.mount();
  assert.equal(h.current.preference, 'light'); assert.equal(h.current.mode, 'light');
  await h.choose('system'); assert.equal(h.current.mode, 'dark'); assert.equal(h.applied.at(-1), 'unspecified');
});

test('system → light → dark → system uses non-null native overrides and resumes OS appearance', async (t) => {
  const h = harness('system'); t.after(h.close);
  await h.mount(); assert.equal(h.current.mode, 'dark');
  await h.choose('light'); assert.equal(h.current.mode, 'light'); assert.equal(h.stored, 'light');
  await h.choose('dark'); assert.equal(h.current.mode, 'dark'); assert.equal(h.stored, 'dark');
  await h.choose('system'); assert.equal(h.current.mode, 'dark'); assert.equal(h.stored, 'system');
  assert.deepEqual(h.applied, ['unspecified', 'light', 'dark', 'unspecified']);
  h.setScheme('light'); await h.rerender();
  assert.equal(h.current.mode, 'light'); assert.equal(h.applied.at(-1), 'unspecified');
});

for (const preference of ['system', 'light', 'dark'] as const) {
  test(`restores stored ${preference} before mounting children or applying native appearance`, async (t) => {
    const h = harness(preference, true); t.after(h.close);
    h.setScheme(preference === 'dark' ? 'light' : 'dark');
    await h.mount(); assert.equal(h.current, undefined); assert.deepEqual(h.applied, []);
    assert.equal(h.rendered.props.style.backgroundColor, '#fcfcfd');
    await act(async () => { h.releaseRead(); await Promise.resolve(); });
    assert.equal(h.current.preference, preference);
    assert.equal(h.current.mode, preference === 'system' ? 'dark' : preference);
    assert.equal(h.rendered[0].type, 'StatusBar');
    assert.equal(h.rendered[0].props.backgroundColor, preference === 'light' ? '#fcfcfd' : '#15171c');
    assert.deepEqual(h.applied, [preference === 'system' ? 'unspecified' : preference]);
    assert.equal(h.stored, preference);
  });
}

for (const saved of [null, '', 'unexpected']) {
  test(`unset/invalid preference ${saved} and read failure fall back to light without writes`, async (t) => {
    const h = harness(saved); t.after(h.close); await h.mount();
    assert.equal(h.current.preference, 'light'); assert.equal(h.current.mode, 'light');
    assert.equal(h.stored, saved);
    h.setScheme('light'); await h.rerender(); h.setScheme('dark'); await h.rerender();
    assert.equal(h.current.mode, 'light');
    const failed = harness(); t.after(failed.close); failed.failRead(); await failed.mount();
    assert.equal(failed.current.preference, 'light'); assert.equal(failed.current.mode, 'light');
  });
}

test('write failure preserves the explicit in-session choice and existing disk choice', async (t) => {
  const h = harness('system'); t.after(h.close); await h.mount(); h.failWrite();
  await h.choose('light'); assert.equal(h.current.preference, 'light'); assert.equal(h.stored, 'system');
  await h.choose('dark'); assert.equal(h.current.mode, 'dark'); assert.equal(h.stored, 'system');
});

test('stored dark choice is read before navigation children mount', async (t) => {
  const h = harness('dark', true); t.after(h.close);
  await h.mount();
  assert.equal(h.current, undefined, 'the child cannot paint with a temporary system theme');
  await act(async () => { h.releaseRead(); await Promise.resolve(); });
  assert.equal(h.current.preference, 'dark'); assert.equal(h.current.mode, 'dark');
});


test('financial preference defaults to Red/Blue, applies instantly, survives remount and OS changes', async (t) => {
  const h = harness('system'); t.after(h.close);
  await h.mount();
  assert.equal(h.current.financialPreference, 'red_blue');
  assert.equal(h.current.financialColors.buy, '#ff8b86');
  await h.chooseFinancial('green_red');
  assert.equal(h.current.financialColors.buy, '#79d68b');
  assert.equal(h.values.get('trading-app:financial-colors'), 'green_red');
  assert.equal(h.values.get('trading-app:appearance'), 'system');
  await h.close(); await h.mount();
  assert.equal(h.current.financialPreference, 'green_red');
  h.setScheme('light'); await h.rerender();
  assert.equal(h.current.financialColors.buy, '#16803a');
  assert.equal(h.current.financialColors.sell, '#a13e3b');
  await h.chooseFinancial('red_blue');
  assert.equal(h.current.financialColors.buy, '#a13e3b');
  assert.equal(h.current.financialColors.sell, '#315f9b');
});

test('financial restore gates children; invalid/read/write failure uses the default', async (t) => {
  const h = harness(null, true); t.after(h.close);
  h.values.set('trading-app:financial-colors', 'green_red');
  await h.mount(); assert.equal(h.current, undefined);
  await act(async () => { h.releaseRead(); await Promise.resolve(); });
  assert.equal(h.current.financialPreference, 'green_red');
  h.failWrite(); await h.chooseFinancial('green_red');
  assert.equal(h.current.financialPreference, 'red_blue');
  const invalid = harness(); t.after(invalid.close);
  invalid.values.set('trading-app:financial-colors', 'invalid');
  await invalid.mount(); assert.equal(invalid.current.financialPreference, 'red_blue');
  const failed = harness(); t.after(failed.close); failed.failRead();
  await failed.mount(); assert.equal(failed.current.financialPreference, 'red_blue');
});

test('rapid financial choices persist the final choice independently of appearance', async (t) => {
  const h = harness('dark'); t.after(h.close); await h.mount();
  await act(async () => {
    h.current.setFinancialPreference('green_red');
    h.current.setFinancialPreference('red_blue');
    h.current.setFinancialPreference('green_red');
  });
  assert.equal(h.values.get('trading-app:financial-colors'), 'green_red');
  assert.equal(h.stored, 'dark');
  assert.equal(h.current.financialPreference, 'green_red');
});


test('real logout and login leave device financial preference intact', async () => {
  const { createSessionHarness } = require('../../test/sessionTestHarness.cjs');
  const h = createSessionHarness();
  h.disk.set('trading-app:financial-colors', 'green_red');
  await h.install('A');
  await h.logout();
  assert.equal(h.disk.get('trading-app:financial-colors'), 'green_red');
  await h.install('B');
  assert.equal(h.disk.get('trading-app:financial-colors'), 'green_red');
  h.queryClient.clear();
});
