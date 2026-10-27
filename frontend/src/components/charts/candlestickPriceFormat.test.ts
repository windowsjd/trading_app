import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatChartPrice } from './candlestickPriceFormat.ts';

/**
 * Chart price precision. Every price the chart draws — y-axis, current-price
 * label, crosshair label, accessibility summary — goes through
 * `formatChartPrice`, so these cases describe all four at once.
 */
describe('formatChartPrice', () => {
  it('renders a low-priced coin at its declared precision', () => {
    // DOGE tickSize 0.00001 → 5. The old chart formatter showed $0.25 here.
    assert.equal(formatChartPrice(0.2456, 'USD', 5), '$0.2456');
    assert.notEqual(formatChartPrice(0.2456, 'USD', 5), '$0.25');
    // XRP / XLM tickSize 0.0001 → 4.
    assert.equal(formatChartPrice(2.1457, 'USD', 4), '$2.1457');
    assert.equal(formatChartPrice(0.2895, 'USD', 4), '$0.2895');
  });

  it('handles the 8-decimal floor of a very cheap coin', () => {
    assert.equal(formatChartPrice(0.00000012, 'USD', 8), '$0.00000012');
    assert.ok(!formatChartPrice(0.00000012, 'USD', 8).includes('e'));
  });

  it('supports 0 decimals', () => {
    assert.equal(formatChartPrice(106234.56, 'USD', 0), '$106,235');
  });

  it('falls back to the 2-decimal USD policy without a precision', () => {
    assert.equal(formatChartPrice(106234.567, 'USD', null), '$106,234.57');
    assert.equal(formatChartPrice(106234.567, 'USD', undefined), '$106,234.57');
  });

  it('keeps the KRW policy regardless of the declared precision', () => {
    assert.equal(formatChartPrice(71300, 'KRW', null), '71,300원');
    assert.equal(formatChartPrice(71300.4, 'KRW', 5), '71,300원');
  });

  it('formats the computed floats the axis and crosshair produce', () => {
    // An interpolated grid value / a price under the crosshair carries float
    // noise; the label must still land on the asset's precision.
    const minY = 0.2451;
    const range = 0.0009999999999999998;
    const gridValue = minY + (range * 2) / 4;
    assert.equal(formatChartPrice(gridValue, 'USD', 5), '$0.2456');

    const crosshairPrice = minY + (1 - 40 / 200) * range;
    assert.equal(formatChartPrice(crosshairPrice, 'USD', 5), '$0.2459');
  });

  it('renders a missing price as "-" rather than a wrong number', () => {
    assert.equal(formatChartPrice(null, 'USD', 5), '-');
    assert.equal(formatChartPrice(undefined, 'USD', 5), '-');
    assert.equal(formatChartPrice(Number.NaN, 'USD', 5), '-');
  });

  it('converts a dollar price into won; only a converted won keeps carried-over decimals', () => {
    const rate = 1384.45;
    assert.equal(formatChartPrice(189.5, 'KRW', null, rate), '262,353원', 'US stock: whole won');
    assert.equal(formatChartPrice(100000, 'KRW', 0, rate), '138,445,000원');
    assert.equal(formatChartPrice(0.24561, 'KRW', 2, rate), '340.03원', 'DOGE');
    assert.equal(formatChartPrice(0.00001, 'KRW', 5, rate), '0.01384원', 'PEPE, not 0원');
    assert.equal(formatChartPrice(Number.NaN, 'KRW', 2, rate), '-');
    assert.equal(formatChartPrice(null, 'KRW', 2, rate), '-');
    // Not converted: a won price of its own is whole won whatever is declared.
    assert.equal(formatChartPrice(71300.4, 'KRW', 5), '71,300원');
    assert.equal(formatChartPrice(0.2456, 'USD', 5, undefined), '$0.2456');
  });
});
