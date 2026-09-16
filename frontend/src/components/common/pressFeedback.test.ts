import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { withPressedFeedback } from './pressFeedback.ts';

const require = createRequire(import.meta.url);
const { load, elements } = require('../../../test/ledgerTestHarness.cjs');
const native = {
  Pressable: 'Pressable', Text: 'Text', ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal', View: 'View', StyleSheet: { create: (styles: unknown) => styles },
};
const CTAButton = load(resolve('src/components/common/CTAButton.tsx'), {
  'react-native': native,
}).default;
const flatten = (style: any): any => Array.isArray(style)
  ? Object.assign({}, ...style.map(flatten))
  : style || {};

describe('general pressed feedback', () => {
  it('dims immediately, restores the exact base style, and changes no layout', () => {
    const base = [{ padding: 14, backgroundColor: '#111' }, { borderRadius: 12 }];
    const style = withPressedFeedback(base);
    assert.strictEqual(style({ pressed: false }), base);
    assert.deepEqual(flatten(style({ pressed: true })), { ...flatten(base), opacity: 0.76 });
    assert.strictEqual(style({ pressed: false }), base);
  });

  it('preserves style callbacks and never adds active feedback when disabled', () => {
    const base = { opacity: 0.45, padding: 12 };
    const states: boolean[] = [];
    const style = withPressedFeedback(({ pressed }) => {
      states.push(pressed);
      return base;
    }, true);
    assert.strictEqual(style({ pressed: true }), base);
    assert.strictEqual(style({ pressed: false }), base);
    assert.deepEqual(states, [true, false]);
  });

  it('connects the actual CTA without wrapping or delaying its action', () => {
    let calls = 0;
    const onPress = () => { calls++; };
    const node = CTAButton({ label: '주문하기', testID: 'cta', onPress, style: { flex: 1 } });
    assert.equal(node.type, 'Pressable');
    assert.equal(node.props.testID, 'cta');
    assert.equal(node.props.disabled, false);
    assert.strictEqual(node.props.onPress, onPress);
    const idle = flatten(node.props.style({ pressed: false }));
    assert.deepEqual(flatten(node.props.style({ pressed: true })), { ...idle, opacity: 0.76 });
    assert.equal(calls, 0, 'feedback alone does not execute the action');
    node.props.onPress();
    assert.equal(calls, 1, 'the original action runs synchronously once');
    assert.deepEqual(flatten(node.props.style({ pressed: false })), idle);
    assert.equal(elements(node, 'Text')[0].props.numberOfLines, undefined);
  });

  for (const state of ['disabled', 'loading', 'blocked']) {
    it(`keeps ${state} CTA inert even if a pressed style is evaluated`, () => {
      const node = CTAButton({ label: '실행', state, onPress: () => {} });
      assert.equal(node.props.disabled, true);
      assert.deepEqual(node.props.style({ pressed: true }), node.props.style({ pressed: false }));
      assert.equal(elements(node, 'ActivityIndicator').length, state === 'loading' ? 1 : 0);
    });
  }

  it('does not advertise an action on a CTA with no handler', () => {
    const node = CTAButton({ label: '준비 중' });
    assert.deepEqual(node.props.style({ pressed: true }), node.props.style({ pressed: false }));
  });
});

describe('touch coverage and exclusions', () => {
  it('covers direct action Pressables and uses their existing disabled condition', () => {
    const covered = new Set<string>();
    const excluded: string[] = [];
    for (const file of readdirSync('src', { recursive: true }) as string[]) {
      if (!file.endsWith('.tsx')) continue;
      const source = ts.createSourceFile(file, readFileSync(resolve('src', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'Pressable') {
          const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
          const attr = (name: string) => attrs.find((a) => a.name.getText(source) === name);
          const expression = (name: string) => {
            const init = attr(name)?.initializer;
            return init && ts.isJsxExpression(init) ? init.expression : undefined;
          };
          const style = expression('style');
          if (file === 'components/common/BottomSheetBackdrop.tsx' || !attr('onPress')) {
            excluded.push(file);
            assert.ok(style && !ts.isCallExpression(style), `${file}: non-action keeps its static style`);
          } else {
            assert.ok(style && ts.isCallExpression(style), `${file}: missing feedback`);
            assert.equal(style.expression.getText(source), 'withPressedFeedback', file);
            if (attr('disabled')) {
              const guard = style.arguments[1]?.getText(source);
              const disabled = expression('disabled')?.getText(source);
              assert.equal(guard, file.endsWith('/CTAButton.tsx') ? 'disabled || !onPress' : disabled, file);
            }
            covered.add(file);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    assert.deepEqual(excluded.sort(), [
      'components/common/BottomSheetBackdrop.tsx',
      'screens/record/RecordOrderListScreen.tsx',
    ]);
    for (const file of [
      'components/common/CTAButton.tsx', 'components/tradingAccount/AccountSwitcher.tsx',
      'components/states/ErrorState.tsx', 'features/market/MarketAssetRow.tsx',
      'screens/auth/LoginScreen.tsx', 'screens/auth/SignupScreen.tsx',
      'screens/home/GeneralAccountHome.tsx', 'screens/home/SeasonAccountHome.tsx',
      'screens/market/MarketScreen.tsx', 'screens/market/MarketSearchScreen.tsx',
      'screens/ranking/RankingScreen.tsx', 'screens/my/MyScreen.tsx',
      'screens/order/OrderScreen.tsx', 'screens/wallet/WalletFxScreen.tsx',
    ]) assert.ok(covered.has(file), file);
  });

  it('leaves backdrop dismissal and its transparent touch surface unchanged', () => {
    const Backdrop = load(resolve('src/components/common/BottomSheetBackdrop.tsx'), { 'react-native': native }).default;
    let closes = 0;
    const onClose = () => { closes++; };
    const tree = Backdrop({ visible: true, onClose, children: 'sheet content' });
    const backdrop = elements(tree, 'Pressable')[0];
    assert.deepEqual(backdrop.props.style, { flex: 1 });
    assert.equal(backdrop.props.android_ripple, undefined);
    assert.strictEqual(backdrop.props.onPress, onClose);
    assert.strictEqual(tree.props.onRequestClose, onClose);
    backdrop.props.onPress();
    assert.equal(closes, 1);
  });

  it('keeps feedback outside the chart gesture subtree', () => {
    const read = (file: string) => readFileSync(resolve('src/components/charts', file), 'utf8');
    for (const file of ['CandlestickGestures.native.tsx', 'CandlestickGestures.web.tsx', 'CandlestickChartRenderer.tsx']) {
      assert.doesNotMatch(read(file), /withPressedFeedback|<Pressable|android_ripple/);
    }
    const source = read('CandlestickChart.tsx');
    const gestureStart = source.indexOf('<CandlestickGestures');
    const gestureEnd = source.indexOf('</CandlestickGestures>');
    assert.ok(gestureStart > 0 && gestureEnd > gestureStart);
    assert.doesNotMatch(source.slice(gestureStart, gestureEnd), /withPressedFeedback|<Pressable/);
    assert.match(source.slice(gestureEnd), /style=\{withPressedFeedback\(styles.resetButton\)\}/);
    assert.equal((source.match(/withPressedFeedback\(/g) ?? []).length, 1);
  });

  it('preserves market row memoization across unrelated ticker updates', () => {
    const React = require('react');
    const { MarketAssetRow } = load(resolve('src/features/market/MarketAssetRow.tsx'), {
      react: { ...React, useMemo: (fn: () => unknown) => fn() }, 'react-native': native,
    });
    const props = { item: { id: 'btc' }, ticker: { assetId: 'btc' }, isStale: false, onPress: () => {} };
    assert.equal(MarketAssetRow.compare(props, { ...props }), true);
    assert.equal(MarketAssetRow.compare(props, { ...props, ticker: { ...props.ticker } }), false);
    assert.equal(MarketAssetRow.compare(props, { ...props, isStale: true }), false);
    assert.equal(MarketAssetRow.compare(props, { ...props, item: { ...props.item } }), false);
    assert.equal(MarketAssetRow.compare(props, { ...props, onPress: () => {} }), false);
  });
});
