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
  it('names the New York trading date, not the Seoul date', () => {
    assert.equal(getLastSessionCloseLabel(lastClose), '10/16 종가');
    assert.equal(
      getLastSessionCloseNotice(lastClose),
      '미국 정규장 마감 · 10/16 종가 (실시간 시세 아님)',
    );
    // An early (13:00 EST) close stays on its own date as well.
    assert.equal(
      getLastSessionCloseLabel({
        ...lastClose,
        priceEffectiveAt: '2026-11-27T18:00:00.000Z',
      }),
      '11/27 종가',
    );
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
    }
    assert.equal(getLastSessionCloseLabel(null) === null, true);
    assert.equal(
      getLastSessionCloseLabel({ ...lastClose, priceEffectiveAt: null }) ===
        null,
      true,
    );
  });
});
