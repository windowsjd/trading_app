import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { getFeedbackPalette } from './pressFeedback.ts';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { load, elements } = require('../../../test/ledgerTestHarness.cjs');
const { interactionHarness } = require('../../../test/interactionTestHarness.cjs');
const native = { ...interactionHarness().native, Pressable: 'Pressable' };

it('uses a subtle neutral wash in light/dark without changing financial colors', () => {
  for (const color of [0xff111111, 0xff1b2530, 0xff0066cc, 0xffcccccc, 0xffa13e3b, 0xff315f9b, 0xff16803a]) {
    assert.deepEqual(getFeedbackPalette(color), { washOpacity: 0.055, washColor: '#fff' });
  }
  for (const color of [0xfffafafa, 0xffffffff, null]) {
    assert.deepEqual(getFeedbackPalette(color), { washOpacity: 0.065, washColor: '#000' });
  }
});

describe('touch coverage and exclusions', () => {
  it('covers direct action Pressables and uses their existing disabled condition', () => {
    const covered = new Set<string>();
    const excluded: string[] = [];
    for (const file of readdirSync('src', { recursive: true }) as string[]) {
      if (!file.endsWith('.tsx')) continue;
      const source = ts.createSourceFile(file, readFileSync(resolve('src', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ['Pressable', 'ActionPressable'].includes(node.tagName.getText(source))) {
          const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
          const attr = (name: string) => attrs.find((a) => a.name.getText(source) === name);
          const expression = (name: string) => {
            const init = attr(name)?.initializer;
            return init && ts.isJsxExpression(init) ? init.expression : undefined;
          };
          const style = expression('style');
          if (attr('feedback')?.initializer?.getText(source) === '"none"') {
            assert.equal(file, 'features/market/MarketSortControl.tsx', 'only sort directions may opt out');
            assert.equal(attr('feedback')?.initializer?.getText(source), '"none"');
          }
          if (file === 'components/common/ActionPressable.tsx') return;
          if (file === 'components/common/BottomSheetBackdrop.tsx' || !attr('onPress')) {
            excluded.push(file);
            assert.ok(style && !ts.isCallExpression(style), `${file}: non-action keeps its static style`);
          } else {
            assert.equal(node.tagName.getText(source), 'ActionPressable', `${file}: missing common interaction`);
            assert.match(readFileSync(resolve('src', file), 'utf8'), /import ActionPressable from ['"].*\/ActionPressable['"]/);
            assert.ok(style && !ts.isCallExpression(style), `${file}: base style stays static`);
            covered.add(file);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    assert.deepEqual(excluded.sort(), [
      'components/common/BottomSheetBackdrop.tsx',
      'screens/history/TradeHistoryScreen.tsx',
    ]);
    for (const file of [
      'components/common/CTAButton.tsx', 'components/tradingAccount/AccountSwitcher.tsx',
      'components/charts/ChartTimeframeSelector.tsx',
      'components/states/ErrorState.tsx', 'features/market/MarketAssetRow.tsx',
      'screens/auth/LoginScreen.tsx', 'screens/auth/SignupScreen.tsx',
      'components/tradingAccount/PositionAssetRow.tsx', 'screens/wallet/WalletScreen.tsx',
      'screens/market/MarketScreen.tsx', 'screens/market/MarketSearchScreen.tsx',
      'screens/ranking/RankingScreen.tsx', 'screens/my/MyScreen.tsx',
      'screens/order/OrderPanel.tsx', 'screens/wallet/WalletFxScreen.tsx',
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
      assert.doesNotMatch(read(file), /ActionPressable|<Pressable|android_ripple/);
    }
    const source = read('CandlestickChart.tsx');
    const gestureStart = source.indexOf('<CandlestickGestures');
    const gestureEnd = source.indexOf('</CandlestickGestures>');
    assert.ok(gestureStart > 0 && gestureEnd > gestureStart);
    assert.doesNotMatch(source.slice(gestureStart, gestureEnd), /ActionPressable|<Pressable/);
    assert.match(source.slice(gestureEnd), /<ActionPressable\s+style=\{styles.resetButton\}/);
    assert.equal((source.match(/<ActionPressable/g) ?? []).length, 1);
  });

  it('preserves market row memoization across unrelated ticker updates', () => {
    const React = require('react');
    const { MarketAssetRow } = load(resolve('src/features/market/MarketAssetRow.tsx'), {
      react: { ...React, useMemo: (fn: () => unknown) => fn() }, 'react-native': native,
      '../../components/states/AdminDiagnosticPanel': { default: () => null, __esModule: true },
    });
    const props = { item: { id: 'btc' }, ticker: { assetId: 'btc' }, isStale: false, onPress: () => {} };
    assert.equal(MarketAssetRow.compare(props, { ...props }), true);
    assert.equal(MarketAssetRow.compare(props, { ...props, ticker: { ...props.ticker } }), false);
    assert.equal(MarketAssetRow.compare(props, { ...props, isStale: true }), false);
    assert.equal(MarketAssetRow.compare(props, { ...props, item: { ...props.item } }), false);
    assert.equal(MarketAssetRow.compare(props, { ...props, onPress: () => {} }), false);
  });
});
