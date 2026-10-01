import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { load, elements } from '../../../test/ledgerTestHarness.cjs';
import { holding } from '../../../test/positionFixture.ts';
import { semantic, resolveSemanticStyle } from '../../theme/tokens.ts';
import { financial, getFinancialColors } from '../../theme/financialColors.ts';

const Row = load(resolve('src/components/tradingAccount/PositionAssetRow.tsx'), {
  'react-native': { Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles } },
}).default;
const find = (tree, id) => elements(tree).find((node) => node.props.testID === id);

describe('shared PositionAssetRow', () => {
  it('shows identity beside a value/quantity/return column and keeps unit prices hidden', () => {
    const position = holding('samsung', { quantity: '10.000000' });
    const tree = Row({ position, testID: 'holding', onPress() {} });
    assert.equal(find(tree, 'holding-name').props.children, '삼성전자');
    assert.deepEqual(elements(find(tree, 'holding-values'), 'Text').map((node) => node.props.children), [
      '1,120,000원', '10주', '+4.82%',
    ]);
    const text = elements(tree, 'Text').map((node) => node.props.children).join(' ');
    assert.doesNotMatch(text, /평균\s*매입가|현재가|현재 단가|987,654|80,000/);
    const valueStyle = find(tree, 'holding-value').props.style;
    const quantityStyle = find(tree, 'holding-quantity').props.style;
    const rateStyle = find(tree, 'holding-return').props.style[0];
    assert.ok(valueStyle.fontSize > rateStyle.fontSize && rateStyle.fontSize > quantityStyle.fontSize);
    assert.equal(quantityStyle.color, semantic.secondary);
    assert.equal(quantityStyle.fontWeight, '400');
  });

  for (const state of ['stale_cache', 'unavailable']) {
    it(`${state} retains the known crypto quantity independently of valuation`, () => {
      const position = holding('btc', { assetType: 'crypto', market: 'BINANCE', symbol: 'BTCUSDT', quantity: '0.00080500' });
      Object.assign(position.valuation, { state });
      const tree = Row({ position, testID: 'holding', onPress() {} });
      assert.equal(find(tree, 'holding-quantity').props.children, '0.000805 BTC');
      assert.equal(find(tree, 'holding-value').props.children, state === 'unavailable' ? '-' : '1,120,000원');
      assert.equal(find(tree, 'holding-return').props.children, state === 'unavailable' ? '-' : '+4.82%');
      assert.match(find(tree, 'holding-notice').props.children, state === 'unavailable' ? /현재 시세 조회 불가/ : /이전 시세/);
    });
  }

  for (const mode of ['light', 'dark'] as const) for (const preference of ['red_blue', 'green_red'] as const) {
    it(`${mode}/${preference} uses financial direction only for returns`, () => {
      const colors = { text: 'primary', secondary: 'secondary' };
      for (const [returnRate, role] of [['4.82', 'rise'], ['-2.14', 'fall'], ['0', 'neutral']] as const) {
        const position = holding();
        Object.assign(position.valuation, { returnRate });
        const tree = Row({ position, testID: 'holding', onPress() {} });
        const rate = find(tree, 'holding-return');
        assert.equal(rate.props.style[1].color, role === 'neutral' ? semantic.secondary : financial[role]);
        const resolved = resolveSemanticStyle(rate.props.style, colors as any, mode, preference);
        const color = Object.assign({}, ...resolved.flat(Infinity)).color;
        assert.equal(color, role === 'neutral' ? 'secondary' : getFinancialColors(mode, preference)[role]);
        assert.equal(find(tree, 'holding-value').props.style.color, undefined);
        assert.equal(find(tree, 'holding-quantity').props.style.color, semantic.secondary);
      }
    });
  }
});
