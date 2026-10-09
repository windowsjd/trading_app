import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { getFuturesPositionDisplay, futuresHolding } from './positionDisplay.ts';
import { formatMoneyDecimal, formatSignedPercent } from '../../utils/format.ts';
const require = createRequire(import.meta.url);
const { futuresFixture } = require('../../../test/futuresFixtures.cjs');

it('formats full Decimal money with unit-consistent signs without float loss', () => {
  assert.equal(formatMoneyDecimal('-9876543210123456.12345678', 'USD', true), '-$9,876,543,210,123,456.12');
  assert.equal(formatMoneyDecimal('9876543210123456.9', 'KRW'), '9,876,543,210,123,457원');
  assert.equal(formatMoneyDecimal('0', 'USD', true), '$0');
  assert.equal(formatMoneyDecimal(null, 'USD', true), '-');
  assert.equal(formatSignedPercent('-99.999'), '-100%');
});
for (const direction of ['long', 'short']) for (const marginMode of ['cross', 'isolated']) {
  it(`${direction}/${marginMode} only displays the canonical projection with fresh Mark evidence`, () => {
    const data = futuresFixture('A', { position: true, direction, marginMode }).positions;
    const p = futuresHolding(data.positions[0]);
    const now = Date.now();
    for (const [pnl, roi, role] of [['2', '7', 'rise'], ['-2', '-7', 'fall'], ['0', '0', 'neutral']]) {
      Object.assign(p, { markNotional: '9876.5432', markUnrealizedPnl: pnl, roi });
      const display = getFuturesPositionDisplay(p, data.evaluatedAt, now);
      assert.equal(display.notional, '$9,876.54');
      assert.equal(display.pnlDirection, role);
      assert.equal(display.direction, direction.toUpperCase());
      assert.equal(display.roi, formatSignedPercent(roi));
    }
    for (const evidence of [null, { effectiveAt: new Date(now - 6000).toISOString(), capturedAt: data.evaluatedAt },
      { effectiveAt: new Date(now + 1).toISOString(), capturedAt: new Date(now + 1).toISOString() }]) {
      p.markEvidence = evidence;
      const display = getFuturesPositionDisplay(p, data.evaluatedAt, now);
      assert.equal(display.performance, '-'); assert.equal(display.notional, '-');
      assert.equal(display.direction, direction.toUpperCase()); assert.match(display.margin, /100x/);
    }
  });
}
