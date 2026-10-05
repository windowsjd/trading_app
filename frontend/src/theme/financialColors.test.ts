import assert from 'node:assert/strict';
import { test } from 'node:test';
import { financial, getFinancialColors, parseFinancialColorPreference, resolveFinancialColor } from './financialColors.ts';
import { BUY_COLOR, SELL_COLOR } from '../features/order/sideColors.ts';
import { UP_COLOR, DOWN_COLOR } from '../components/charts/candleColors.ts';
import { semantic } from './tokens.ts';

function luminance(hex: string) {
  const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

test('new, invalid and missing preferences use Red/Blue; Green/Red is explicit', () => {
  for (const value of [null, '', 'unknown', 'red_blue']) assert.equal(parseFinancialColorPreference(value), 'red_blue');
  assert.equal(parseFinancialColorPreference('green_red'), 'green_red');
  assert.equal(resolveFinancialColor(financial.buy, 'light'), '#a13e3b');
});

for (const mode of ['light', 'dark'] as const) for (const preference of ['red_blue', 'green_red'] as const) {
  test(`${mode} ${preference}: text/surfaces retain their theme policy; actions/candles have separate roles`, () => {
    const colors = getFinancialColors(mode, preference);
    const expected = mode === 'light'
      ? preference === 'red_blue' ? ['#a13e3b', '#315f9b'] : ['#16803a', '#a13e3b']
      : preference === 'red_blue' ? ['#ff8b86', '#8cbaff'] : ['#79d68b', '#ff8b86'];
    const actions = preference === 'red_blue' ? ['#d1110b', '#0a5ac2'] : ['#16803a', '#d1110b'];
    const candles = preference === 'red_blue' ? ['#d1110b', '#0a5ac2'] : [expected[0], '#d1110b'];
    const surfaces = mode === 'light'
      ? preference === 'red_blue' ? ['#fef2f2', '#eff6ff'] : ['#f0fdf4', '#fef2f2']
      : preference === 'red_blue' ? ['#38232a', '#1e304b'] : ['#1d392b', '#38232a'];
    for (const role of ['buy', 'rise'] as const) assert.equal(colors[role], expected[0]);
    for (const role of ['sell', 'fall'] as const) assert.equal(colors[role], expected[1]);
    assert.equal(colors.buyAction, actions[0]);
    assert.equal(colors.sellAction, actions[1]);
    assert.equal(colors.candleUp, candles[0]);
    assert.equal(colors.candleDown, candles[1]);
    assert.equal(colors.buySurface, surfaces[0]);
    assert.equal(colors.sellSurface, surfaces[1]);
    assert.notEqual(colors.fall, colors.candleDown);
    if (preference === 'red_blue') assert.notEqual(colors.rise, colors.candleUp);
    assert.equal(resolveFinancialColor(BUY_COLOR, mode, preference), colors.buyAction);
    assert.equal(resolveFinancialColor(SELL_COLOR, mode, preference), colors.sellAction);
    assert.equal(resolveFinancialColor(UP_COLOR, mode, preference), colors.candleUp);
    assert.equal(resolveFinancialColor(DOWN_COLOR, mode, preference), colors.candleDown);
    for (const color of [colors.buy, colors.sell]) {
      for (const bg of mode === 'light' ? ['#fcfcfd', '#ffffff', '#f7f8fa'] : ['#15171c', '#1c1d21', '#292a2f']) {
        assert.ok(contrast(color, bg) >= 4.5, `${color} on ${bg}`);
      }
    }
    for (const side of ['buy', 'sell'] as const) {
      assert.ok(contrast(colors[side], colors[`${side}Surface`]) >= 4.5);
      assert.ok(contrast('#ffffff', colors[`${side}Action`]) >= 4.5);
    }
    assert.equal(colors.credit, getFinancialColors(mode).credit);
    assert.equal(colors.debit, getFinancialColors(mode).debit);
  });
}

test('only explicit financial tokens resolve; status, brand and cashflow retain their meanings', () => {
  assert.equal(new Set([...Object.values(semantic), ...Object.values(financial)]).size,
    Object.keys(semantic).length + Object.keys(financial).length);
  for (const preference of ['red_blue', 'green_red'] as const) for (const mode of ['light', 'dark'] as const) {
    for (const color of ['#16a34a', '#dc2626', '#fff', '#202a35', 'transparent', ...Object.values(semantic)]) {
      assert.equal(resolveFinancialColor(color, mode, preference), color);
    }
  }
});
