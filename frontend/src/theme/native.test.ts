import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { semantic, resolveSemanticColor, resolveSemanticStyle } from './tokens.ts';
import { financial, FINANCIAL_COLORS } from './financialColors.ts';

const require = createRequire(import.meta.url);
const { load } = require('../../test/ledgerTestHarness.cjs');
const { inlineTradingHarness } = require('../../test/inlineTradingHarness.cjs');
const React = require('react');
const { PALETTES } = load(resolve('src/theme/appearance.tsx'), {
  react: React,
  'react-native': { Appearance: {}, Platform: { OS: 'web' }, StatusBar: 'StatusBar', useColorScheme: () => 'light', View: 'View' },
  '@react-native-async-storage/async-storage': {},
});
const flatten = (style: any): any => Array.isArray(style)
  ? Object.assign({}, ...style.map(flatten)) : (style || {});
const native = {
  View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView',
  FlatList: 'FlatList', Pressable: 'Pressable', SafeAreaView: 'SafeAreaView',
  KeyboardAvoidingView: 'KeyboardAvoidingView', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { flatten },
};
function themed(mode: 'light' | 'dark') {
  const appearance = { useAppearance: () => ({ mode, colors: PALETTES[mode] }) };
  return load(resolve('src/theme/native.tsx'), {
    react: React, 'react-native': native, './appearance': appearance,
    './tokens': require('./tokens.ts'),
  });
}

test('explicit semantic tokens resolve in both modes; arbitrary hex is never inferred', () => {
  for (const mode of ['light', 'dark'] as const) {
    const UI = themed(mode);
    const card = UI.View.render({ style: { backgroundColor: semantic.surface, borderColor: semantic.border } }, null);
    assert.equal(flatten(card.props.style).backgroundColor, PALETTES[mode].surface);
    assert.equal(flatten(card.props.style).borderColor, PALETTES[mode].border);
    const up = UI.Text.render({ style: { color: financial.rise }, children: '상승' }, null);
    const down = UI.Text.render({ style: { color: financial.buy }, children: '매수' }, null);
    assert.equal(flatten(up.props.style).color, FINANCIAL_COLORS.rise[mode]);
    assert.equal(flatten(down.props.style).color, FINANCIAL_COLORS.buy[mode]);
  }
  assert.equal(flatten(resolveSemanticStyle({ backgroundColor: '#fafafa' }, PALETTES.dark, 'dark')).backgroundColor, '#fafafa');
  assert.equal(resolveSemanticColor('#a13e3b', PALETTES.dark, 'dark'), '#a13e3b');
});

test('shared native TextInput keeps value, placeholder, caret and selection visible in both modes', () => {
  for (const mode of ['light', 'dark'] as const) {
    const Input = themed(mode).TextInput;
    for (const editable of [true, false]) {
      const node = Input.render({ value: '123456789.123456789', placeholder: '수량 입력', editable,
        style: { color: semantic.text, backgroundColor: semantic.input, minHeight: 54, lineHeight: 24 } }, null);
      const style = flatten(node.props.style);
      assert.equal(node.props.value, '123456789.123456789'); assert.equal(node.props.editable, editable);
      assert.equal(style.color, PALETTES[mode].text);
      assert.equal(style.backgroundColor, PALETTES[mode].input);
      assert.equal(node.props.placeholderTextColor, PALETTES[mode].placeholder);
      assert.equal(node.props.selectionColor, PALETTES[mode].cursor);
      assert.equal(node.props.cursorColor, PALETTES[mode].cursor);
      assert.equal(node.props.underlineColorAndroid, 'transparent');
      assert.equal(node.props.textAlignVertical, 'center');
      assert.equal(style.minHeight, 54); assert.equal(style.lineHeight, 24);
      assert.equal(style.opacity, editable ? undefined : 0.7);
    }
  }
});

for (const width of [320, 360, 390]) {
  test(`${width}px Order keeps two columns and native quantity, amount and limit values`, async (t) => {
    const h = inlineTradingHarness(); h.dimensions = { width, height: 700, fontScale: 2 };
    await h.mount(); t.after(h.close);
    const row = h.node('asset-trading-columns');
    assert.equal(row.props.style[0].flexDirection, 'row');
    assert.ok(!row.props.style.some((style: any) => style?.flexDirection === 'column'));
    assert.ok(h.node('asset-order-column'));
    assert.ok(h.node('asset-price-column'));
    assert.ok(h.node('order-quantity-slider'));
    const amount = h.node('order-quantity-input');
    assert.match(amount.props.accessibilityLabel, /매수 금액/);
    assert.match(amount.props.placeholder, /매수 금액/);
    await h.input('order-quantity-input', '123456789.123456789');
    assert.equal(h.node('order-quantity-input').props.value, '123456789.123456789');
    await h.press('order-type-toggle-limit');
    const limit = h.node('order-limit-price-input');
    assert.ok(limit);
    const style = flatten(limit.props.style);
    assert.equal(style.width, '100%');
    assert.ok(style.minHeight >= 68);
    assert.ok(style.lineHeight >= 44);
    assert.ok(style.paddingHorizontal <= 4);
    await h.input('order-limit-price-input', '0.000000123456789');
    assert.equal(h.node('order-limit-price-input').props.value, '0.000000123456789');
  });
}

test('wide Order also keeps the trading and quote columns', async (t) => {
  const h = inlineTradingHarness(); h.dimensions = { width: 800, height: 900, fontScale: 1 };
  await h.mount(); t.after(h.close);
  assert.equal(h.node('asset-trading-columns').props.style[0].flexDirection, 'row');
});

test('financial roles stay distinct from neutral roles in the actual palettes', () => {
  const appearance = load(resolve('src/theme/appearance.tsx'), {
    react: React,
    'react-native': { Appearance: {}, Platform: { OS: 'web' }, StatusBar: 'StatusBar', useColorScheme: () => 'light', View: 'View' },
    '@react-native-async-storage/async-storage': {},
  });
  const { light, dark } = appearance.PALETTES;
  for (const mode of ['light', 'dark'] as const) {
    const colors = appearance.PALETTES[mode];
    assert.match(FINANCIAL_COLORS.buy[mode], /^#/);
    assert.match(FINANCIAL_COLORS.sell[mode], /^#/);
    assert.notEqual(FINANCIAL_COLORS.buy[mode], FINANCIAL_COLORS.sell[mode]);
    assert.notEqual(FINANCIAL_COLORS.rise[mode], FINANCIAL_COLORS.fall[mode]);
    for (const role of Object.keys(financial) as (keyof typeof financial)[]) {
      assert.equal(role in colors, false, `${role} must not live in PALETTES`);
      assert.equal(role in semantic, false, `${role} must not be a neutral token`);
      assert.equal(resolveSemanticColor(financial[role], colors, mode), FINANCIAL_COLORS[role][mode]);
    }
  }
  assert.notEqual(light.navigation, dark.navigation);
  assert.equal(dark.navigation, '#080a0d');
});


test('surface hierarchy matches white cards on a near-white canvas with inset controls', () => {
  assert.equal(PALETTES.light.screen, '#f9fafb');
  assert.equal(PALETTES.light.surface, '#ffffff');
  assert.equal(PALETTES.light.raised, '#f7f8fa');
  assert.equal(PALETTES.light.navigation, '#ffffff');
  for (const mode of ['light', 'dark'] as const) {
    const colors = PALETTES[mode];
    assert.equal(colors.input, colors.raised);
    assert.equal(new Set([colors.screen, colors.surface, colors.raised]).size, 3);
    assert.equal(new Set([colors.text, colors.secondary, colors.muted]).size, 3);
    const UI = themed(mode);
    for (const role of ['screen', 'surface', 'raised'] as const) {
      assert.equal(flatten(UI.View.render({ style: { backgroundColor: semantic[role] } }, null).props.style).backgroundColor, colors[role]);
    }
  }
});
