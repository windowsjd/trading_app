import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getLastSessionCloseLabel,
  getLastSessionCloseNotice,
  isLastSessionClosePrice,
} from './lastSessionClose.ts';

const lastClose = {
  priceSource: {
    sourceType: 'provider_api',
    sourceName: 'tiingo_eod',
    snapshotId: null,
    fallbackUsed: true,
    fallbackReason: 'market_closed_last_close',
  },
  // Friday 2026-10-16 16:00 EDT = Saturday 05:00 KST.
  priceEffectiveAt: '2026-10-16T20:00:00.000Z',
};

describe('last session close (closed US market, display only)', () => {
  it('names the price a close without its session date', () => {
    assert.equal(getLastSessionCloseLabel(lastClose), '종가');
    assert.equal(
      getLastSessionCloseNotice(lastClose),
      '미국 정규장 마감 · 종가 (실시간 시세 아님)',
    );
    // No date in either line, whichever New York session it closed (e.g. an
    // early 13:00 EST close), and the label never depends on that date.
    for (const priceEffectiveAt of ['2026-11-27T18:00:00.000Z', null, 'invalid']) {
      const price = { ...lastClose, priceEffectiveAt };
      assert.equal(getLastSessionCloseLabel(price), '종가');
      assert.equal(/\d/.test(getLastSessionCloseNotice(price) ?? ''), false);
    }
  });

  it('leaves every other price unlabeled', () => {
    for (const priceSource of [
      { sourceName: 'tiingo_us_reference_price', fallbackReason: null },
      { sourceName: 'manual-price', fallbackReason: 'no_provider_snapshot' },
      'tiingo_eod',
      null,
      undefined,
    ]) {
      assert.equal(isLastSessionClosePrice(priceSource), false);
      assert.equal(
        getLastSessionCloseLabel({ ...lastClose, priceSource }) === null,
        true,
      );
      assert.equal(
        getLastSessionCloseNotice({ ...lastClose, priceSource }) === null,
        true,
      );
    }
    assert.equal(getLastSessionCloseLabel(null) === null, true);
  });
});
