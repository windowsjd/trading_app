import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FINANCIAL_COLORS, financial, resolveFinancialColor } from './financialColors.ts';
import { BUY_COLOR, SELL_COLOR } from '../features/order/sideColors.ts';
import { UP_COLOR, DOWN_COLOR } from '../components/charts/candleColors.ts';
import { semantic } from './tokens.ts';

const rgb = (hex: string) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
const green = (hex: string) => { const [r, g, b] = rgb(hex); assert.ok(g > r && g > b, hex); };
const red = (hex: string) => { const [r, g, b] = rgb(hex); assert.ok(r > g && r > b, hex); };
const blue = (hex: string) => { const [r, g, b] = rgb(hex); assert.ok(b > g && b > r, hex); };

test('single financial palette keeps side, rate, cashflow and candle meanings in both modes', () => {
  for (const mode of ['light', 'dark'] as const) {
    green(resolveFinancialColor(financial.buy, mode));
    red(resolveFinancialColor(financial.sell, mode));
    red(resolveFinancialColor(financial.rise, mode));
    blue(resolveFinancialColor(financial.fall, mode));
    green(resolveFinancialColor(financial.credit, mode));
    red(resolveFinancialColor(financial.debit, mode));
  }
  green(BUY_COLOR); red(SELL_COLOR); green(UP_COLOR); red(DOWN_COLOR);
  assert.equal(BUY_COLOR, FINANCIAL_COLORS.buyAction);
  assert.equal(SELL_COLOR, FINANCIAL_COLORS.sellAction);
  assert.equal(UP_COLOR, FINANCIAL_COLORS.candleUp);
  assert.equal(DOWN_COLOR, FINANCIAL_COLORS.candleDown);
});

test('financial resolver only accepts its own explicit tokens, independent of neutral colors', () => {
  assert.equal(new Set([...Object.values(semantic), ...Object.values(financial)]).size,
    Object.keys(semantic).length + Object.keys(financial).length);
  for (const mode of ['light', 'dark'] as const) {
    for (const color of ['#16a34a', '#dc2626', '#fff', '#202a35', 'transparent', ...Object.values(semantic)]) {
      assert.equal(resolveFinancialColor(color, mode), color);
    }
  }
});
