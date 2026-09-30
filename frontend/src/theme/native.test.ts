import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { load } = require('../../test/ledgerTestHarness.cjs');
const { inlineTradingHarness } = require('../../test/inlineTradingHarness.cjs');
const React = require('react');
const PALETTES = {
  light: { text: '#202a35', input: '#ffffff', placeholder: '#7c8793', cursor: '#202a35' },
  dark: { text: '#f2f5f7', input: '#1b2530', placeholder: '#aebbc8', cursor: '#f2f5f7',
    secondary: '#c5d0da', border: '#435364', screen: '#10151c', surface: '#1b2530' },
};
const flatten = (style: any): any => Array.isArray(style)
  ? Object.assign({}, ...style.map(flatten)) : (style || {});
const native = {
  View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView',
  FlatList: 'FlatList', Pressable: 'Pressable', SafeAreaView: 'SafeAreaView',
  KeyboardAvoidingView: 'KeyboardAvoidingView', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { flatten },
};
function themed(mode: 'light' | 'dark') {
  const appearance = { PALETTES, useAppearance: () => ({ mode, colors: PALETTES[mode] }) };
  const colorStyles = load(resolve('src/theme/colorStyles.ts'), {
    'react-native': native, './appearance': appearance,
  });
  return load(resolve('src/theme/native.tsx'), {
    react: React, 'react-native': native, './appearance': appearance,
    './colorStyles': colorStyles,
  });
}

test('shared native TextInput keeps value, placeholder, caret and selection visible in both modes', () => {
  for (const mode of ['light', 'dark'] as const) {
    const Input = themed(mode).TextInput;
    for (const editable of [true, false]) {
      const node = Input.render({ value: '123456.78', placeholder: '수량 입력', editable,
        style: { color: '#202a35', backgroundColor: '#fff', minHeight: 54, lineHeight: 24 } }, null);
      const style = flatten(node.props.style);
      assert.equal(node.props.value, '123456.78'); assert.equal(node.props.editable, editable);
      assert.equal(style.color, PALETTES[mode].text);
      assert.equal(style.backgroundColor, mode === 'dark' ? PALETTES.dark.input : '#fff');
      assert.equal(node.props.placeholderTextColor, PALETTES[mode].placeholder);
      assert.equal(node.props.selectionColor, PALETTES[mode].cursor);
      assert.equal(node.props.cursorColor, PALETTES[mode].cursor);
      assert.equal(node.props.underlineColorAndroid, 'transparent');
      assert.equal(node.props.textAlignVertical, 'center');
      assert.equal(style.minHeight, 54); assert.equal(style.lineHeight, 24);
      assert.equal(style.opacity, editable ? undefined : 0.7);
    }
  }
  const darkText = themed('dark').Text.render({ children: 'visible' }, null);
  assert.equal(flatten(darkText.props.style).color, PALETTES.dark.text);
});

test('320px Order keeps native inputs full width and preserves full raw values', async (t) => {
  const h = inlineTradingHarness(); h.dimensions = { width: 320, height: 700, fontScale: 2 };
  await h.mount(); t.after(h.close);
  assert.ok(h.node('asset-trading-columns').props.style.some((style: any) => style.flexDirection === 'column'));
  for (const id of ['order-quantity-input', 'order-limit-price-input']) {
    if (id === 'order-limit-price-input') await h.press('order-type-toggle-limit');
    const input = h.node(id);
    assert.ok(input, id);
    const inputStyle = flatten(input.props.style);
    assert.equal(inputStyle.width, '100%');
    assert.ok(inputStyle.minHeight >= 80);
    assert.ok(inputStyle.lineHeight >= 24);
    await h.input(id, '123456789.123456789');
    assert.equal(h.node(id).props.value, '123456789.123456789');
  }
});

test('shared surfaces, borders and direction colors remain legible in dark mode', () => {
  const UI = themed('dark');
  const card = UI.View.render({ style: { backgroundColor: '#fafafa', borderColor: '#ddd' } }, null);
  assert.equal(flatten(card.props.style).backgroundColor, PALETTES.dark.surface);
  assert.equal(flatten(card.props.style).borderColor, PALETTES.dark.border);
  const up = UI.Text.render({ style: { color: '#a13e3b' }, children: '전일대비 상승' }, null);
  const down = UI.Text.render({ style: { color: '#315f9b' }, children: '전일대비 하락' }, null);
  assert.equal(flatten(up.props.style).color, '#ff8b86');
  assert.equal(flatten(down.props.style).color, '#8cbaff');
  const buy = UI.View.render({ style: { backgroundColor: '#16a34a' } }, null);
  const sell = UI.View.render({ style: { backgroundColor: '#dc2626' } }, null);
  assert.equal(flatten(buy.props.style).backgroundColor, '#16a34a');
  assert.equal(flatten(sell.props.style).backgroundColor, '#dc2626');
});

test('wide Order keeps the existing trading and quote columns', async (t) => {
  const h = inlineTradingHarness(); h.dimensions = { width: 800, height: 900, fontScale: 1 };
  await h.mount(); t.after(h.close);
  const styles = h.node('asset-trading-columns').props.style;
  assert.ok(!styles.some((style: any) => style?.flexDirection === 'column'));
  assert.equal(styles[0].flexDirection, 'row');
});
