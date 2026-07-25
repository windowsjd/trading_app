import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  selectDisplayPriceKrw,
  selectDisplayPriceKrwState,
  selectDisplayPriceSource,
} from './displayPricePolicy.ts';
import type { AssetTickerMessage } from './assetTickerPolicy.ts';

const restPrice = {
  priceKrwState: 'available',
  priceKrw: '343.00000000',
  priceSource: { sourceType: 'provider_api', sourceName: 'binance_public_rest_24hr_ticker' },
};

function ticker(overrides: Partial<AssetTickerMessage> = {}): AssetTickerMessage {
  return {
    type: 'asset_ticker',
    assetId: 'asset-doge',
    priceLocal: '0.24560000',
    priceKrw: '343.84000000',
    priceKrwState: 'available',
    priceSource: { sourceType: 'provider_api', sourceName: 'binance_spot_ws_ticker' },
    ...overrides,
  };
}

describe('detail display price policy (ticker-as-a-set)', () => {
  it('uses the ticker local+KRW pair when the ticker KRW is available', () => {
    assert.equal(selectDisplayPriceKrw(ticker(), restPrice), '343.84000000');
    assert.equal(selectDisplayPriceKrwState(ticker(), restPrice), 'available');
  });

  it('never fills a ticker-unavailable KRW with the old REST KRW', () => {
    const unavailable = ticker({ priceKrw: null, priceKrwState: 'unavailable' });

    // Latest local price + PAST KRW would be two moments shown as one quote.
    assert.equal(selectDisplayPriceKrw(unavailable, restPrice), null);
    assert.equal(
      selectDisplayPriceKrwState(unavailable, restPrice),
      'unavailable',
    );
  });

  it('falls back to the REST pair only when there is NO ticker', () => {
    assert.equal(selectDisplayPriceKrw(null, restPrice), '343.00000000');
    assert.equal(selectDisplayPriceKrwState(null, restPrice), 'available');
    assert.equal(
      selectDisplayPriceKrw(null, { ...restPrice, priceKrwState: 'unavailable' }),
      null,
    );
    assert.equal(selectDisplayPriceKrw(null, null), null);
    assert.equal(selectDisplayPriceKrwState(null, null), undefined);
  });

  it('captions the displayed price with ITS source, not the REST one', () => {
    const source = selectDisplayPriceSource(ticker(), restPrice) as {
      sourceName?: string;
    };
    assert.equal(source?.sourceName, 'binance_spot_ws_ticker');

    const restSource = selectDisplayPriceSource(null, restPrice) as {
      sourceName?: string;
    };
    assert.equal(restSource?.sourceName, 'binance_public_rest_24hr_ticker');
  });

  it('reports null source when the displayed ticker carries none', () => {
    assert.equal(
      selectDisplayPriceSource(ticker({ priceSource: undefined }), restPrice),
      null,
    );
  });
});
