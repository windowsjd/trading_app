import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getOrderRealizedPnlDisplay } from './financialDisplay.ts';
import { financial } from '../../theme/financialColors.ts';
import { semantic } from '../../theme/tokens.ts';

const shown = (value: string | null | undefined, currency: string | null | undefined) => {
  const display = getOrderRealizedPnlDisplay(value, currency);
  return display.available ? `${display.text}|${display.color}` : 'unavailable';
};

describe('order history SELL realized PnL (server-stored per-order figure)', () => {
  it('signs the figure in its own currency with the rise/fall colors', () => {
    assert.equal(shown('12345.67800000', 'KRW'), `+12,346원|${financial.rise}`);
    assert.equal(shown('-20.14000000', 'KRW'), `-20원|${financial.fall}`);
    assert.equal(shown('99.50000000', 'USD'), `+$99.5|${financial.rise}`);
    assert.equal(shown('-1234.56780000', 'USD'), `-$1,234.57|${financial.fall}`);
  });

  it('an exact zero, or a figure shown as zero, is neutral 0 — not unavailable', () => {
    assert.equal(shown('0.00000000', 'KRW'), `0원|${semantic.text}`);
    assert.equal(shown('0.40000000', 'KRW'), `0원|${semantic.text}`);
    assert.equal(shown('-0.00400000', 'USD'), `$0|${semantic.text}`);
  });

  it('keeps every digit of a long figure (no float conversion)', () => {
    assert.equal(
      shown('-1234567890123456.12345678', 'KRW'),
      `-1,234,567,890,123,456원|${financial.fall}`,
    );
  });

  it('a missing or unusable figure is unavailable, never 0', () => {
    for (const value of [null, undefined, '', 'abc', '1e5', 'NaN']) {
      assert.equal(shown(value, 'KRW'), 'unavailable', String(value));
    }
    assert.equal(shown('10.00000000', 'JPY'), 'unavailable');
    assert.equal(shown('10.00000000', null), 'unavailable');
  });
});
