import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fitFontSize, fitPriceFontSize, formatEnteredAmount, getOrderSummaryBadge } from './stockOrderSummary.ts';

describe('stock order card rules', () => {
  it('shows an entered amount exactly: separators, no rounding, trailing zeros dropped', () => {
    assert.equal(formatEnteredAmount('1270000', 'KRW'), '1,270,000원');
    assert.equal(formatEnteredAmount('70000.5', 'KRW'), '70,000.5원', 'a fractional limit is shown as sent, not rounded');
    assert.equal(formatEnteredAmount('189.1234', 'USD'), '$189.1234');
    assert.equal(formatEnteredAmount('12.000000', null), '12');
    assert.equal(formatEnteredAmount('.5', null), '0.5');
    assert.equal(formatEnteredAmount('0012', null), '12');
    assert.equal(formatEnteredAmount('abc', 'KRW'), 'abc', 'non-decimals pass through untouched');
  });

  it('expected handling follows the known session, never a fill', () => {
    assert.deepEqual(getOrderSummaryBadge('closed', 'limit'), { label: '정규장 대기', tone: 'warning' });
    assert.deepEqual(getOrderSummaryBadge('closed', 'market'), { label: '주문 불가', tone: 'error' });
    assert.deepEqual(getOrderSummaryBadge('closed', 'loc'), { label: '주문 불가', tone: 'error' });
    assert.deepEqual(getOrderSummaryBadge('open', 'market'), { label: '즉시 체결', tone: 'info' });
    assert.deepEqual(getOrderSummaryBadge('open', 'limit'), { label: '체결 대기', tone: 'warning' });
    assert.deepEqual(getOrderSummaryBadge('open', 'loc'), { label: '종가 대기', tone: 'warning' });
    for (const status of ['unknown', 'always_open', null, undefined]) {
      assert.equal(getOrderSummaryBadge(status, 'market'), null, `no claim for ${status}`);
    }
    assert.equal(getOrderSummaryBadge('open', 'conditional'), null);
  });

  it('a figure longer than its row shrinks (down to 10) instead of breaking between digits', () => {
    assert.equal(fitFontSize('140,140원', 111, 1, 10, 15), 15, 'fits: unchanged');
    // 14 narrow glyphs (8.4em) + 원 = 9.4em in a 111pt row.
    assert.equal(fitFontSize('97,456,238,880원', 111, 1, 10, 15), 11);
    assert.equal(fitFontSize('97,456,238,880원', 111, 1.5, 10, 15), 10, 'never below the floor: then it wraps');
    assert.equal(fitFontSize('7,300,074 KRW', 0, 1, 10, 13), 13, 'unmeasured rows keep their size');
  });

  it('fits the 시세 price to its column within 16–24 before the font scale', () => {
    assert.equal(fitPriceFontSize('1,272,000원', 0), 22, 'before the column is measured');
    assert.equal(fitPriceFontSize('1,272,000원', 300), 24);
    // 9 narrow glyphs (0.6em) + 원 (1em) = 6.4em in a 120pt column.
    assert.equal(fitPriceFontSize('1,272,000원', 120), 18);
    assert.equal(fitPriceFontSize('12,345,678,000원', 120), 16, 'never below 16: long values wrap instead');
    assert.equal(fitPriceFontSize('$189.12', 140, 1.5), 22);
    assert.equal(fitPriceFontSize('1,272,000원', 120, 2), 16);
  });
});
