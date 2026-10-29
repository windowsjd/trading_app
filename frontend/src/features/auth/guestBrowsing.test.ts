import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  GUEST_CANDLE_REFRESH_MS,
  GUEST_DETAIL_REFRESH_MS,
  GUEST_LIST_REFRESH_MS,
  guestReadConfig,
  guestRefetchInterval,
  isGuestBrowsing,
  isGuestSignInRequired,
  retryGuestRead,
  setGuestBrowsing,
} from './guestBrowsing.ts';

const require = createRequire(import.meta.url);
const status = (code: number) => ({ isAxiosError: true, response: { status: code, data: { error: { code: 'UNAUTHORIZED' } } } });

describe('guest browsing state', () => {
  afterEach(() => setGuestBrowsing(false));

  it('is off until the login screen starts it', () => {
    assert.equal(isGuestBrowsing(), false);
    assert.equal(guestReadConfig() === undefined, true);
    assert.equal(isGuestSignInRequired(status(401)), false, 'a member 401 stays the session-expiry path');
    assert.equal(retryGuestRead(0, status(401)), true, 'members keep the default single retry');
    assert.equal(retryGuestRead(1, status(500)), false);
  });

  it('sends a guest read as a public request and treats its 401 as sign-in, not a failure', () => {
    setGuestBrowsing(true);
    assert.deepEqual(guestReadConfig(), { skipSessionAuth: true });
    assert.equal(isGuestSignInRequired(status(401)), true);
    assert.equal(isGuestSignInRequired(status(500)), false);
    assert.equal(isGuestSignInRequired(new Error('Network Error')), false);
    assert.equal(retryGuestRead(0, status(401)), false, 'a refused market is final');
    assert.equal(retryGuestRead(0, status(503)), true, 'a blip still retries once');
    assert.equal(retryGuestRead(1, status(503)), false);
  });
});

describe('guest market re-reads (no realtime socket)', () => {
  afterEach(() => setGuestBrowsing(false));

  it('never polls a member, and polls a guest only while the screen is in front', () => {
    assert.equal(guestRefetchInterval(true, GUEST_LIST_REFRESH_MS), false, 'members have the socket');
    setGuestBrowsing(true);
    assert.equal(guestRefetchInterval(false, GUEST_LIST_REFRESH_MS), false, 'a screen behind another is not polled');
    const interval = guestRefetchInterval(true, GUEST_DETAIL_REFRESH_MS);
    assert.equal(typeof interval, 'function');
    if (typeof interval !== 'function') return;
    assert.equal(interval({ state: { error: null } }), GUEST_DETAIL_REFRESH_MS);
    assert.equal(interval({ state: { error: status(503) } }), GUEST_DETAIL_REFRESH_MS, 'an outage keeps being re-read');
    assert.equal(interval({ state: { error: status(401) } }), false, 'a refused market has nothing to refresh');
  });

  it('keeps detail fastest and charts slowest', () => {
    assert.equal(GUEST_DETAIL_REFRESH_MS < GUEST_LIST_REFRESH_MS && GUEST_LIST_REFRESH_MS < GUEST_CANDLE_REFRESH_MS, true);
  });
});

describe('account-free market reads opt in only while browsing', () => {
  const { load } = require('../../../test/ledgerTestHarness.cjs');

  // The real API modules over a recording transport; the guest flag is the
  // module the harness loads for them, so it is flipped through that instance.
  function apis() {
    const calls: Array<{ url: string; config: unknown }> = [];
    const client = {
      apiClient: {
        get: async (url: string, config?: unknown) => {
          calls.push({ url, config });
          return { data: { data: { assets: [], pagination: { nextOffset: null }, candles: [] } } };
        },
      },
    };
    const guest = require(resolve('src/features/auth/guestBrowsing.ts'));
    const market = load(resolve('src/features/market/api.ts'), { '../../services/api/client': client });
    const asset = load(resolve('src/features/asset/api.ts'), { '../../services/api/client': client });
    const futures = load(resolve('src/features/futures/api.ts'), { '../../services/api/client': client });
    const wallet = load(resolve('src/features/wallet/api.ts'), { '../../services/api/client': client });
    return { calls, guest, market, asset, futures, wallet };
  }

  it('members send market reads exactly as before; guests send them without credentials', async () => {
    const h = apis();
    try {
      h.guest.setGuestBrowsing(false);
      await h.market.getAssets({ assetType: 'crypto' });
      await h.asset.getAssetDetail('asset-1');
      await h.asset.getAssetCandles('asset-1', { range: '1d', interval: '5m' });
      assert.deepEqual(h.calls.map((call) => call.config === undefined), [true, true, true]);

      h.guest.setGuestBrowsing(true);
      await h.market.getAssets({ assetType: 'crypto' });
      await h.asset.getAssetDetail('asset-1');
      await h.asset.getAssetCandles('asset-1', { range: '1d', interval: '5m' });
      assert.deepEqual(h.calls.slice(3).map((call) => call.config), [
        { skipSessionAuth: true }, { skipSessionAuth: true }, { skipSessionAuth: true },
      ]);
      assert.deepEqual(h.calls.slice(3).map((call) => call.url.split('?')[0]), [
        '/assets', '/assets/asset-1', '/assets/asset-1/candles',
      ]);
    } finally {
      h.guest.setGuestBrowsing(false);
    }
  });

  it('futures market data and the USD/KRW display rate follow the same rule; account futures never do', async () => {
    const h = apis();
    try {
      for (const guest of [false, true]) {
        h.guest.setGuestBrowsing(guest);
        const before = h.calls.length;
        // The recording transport's body is not a contract chart (the read then
        // refuses it); only what was sent matters here.
        await h.futures.getFuturesInstrumentCandles('fut-1').catch(() => {});
        await h.futures.getFuturesMarketInstruments().catch(() => {});
        await h.wallet.getCurrentFxRate('USD', 'KRW', false).catch(() => {});
        await h.futures.getFuturesInstruments('account-1').catch(() => {});
        const sent = h.calls.slice(before);
        assert.deepEqual(sent.map((call) => call.url.split('?')[0]), [
          '/futures/instruments/fut-1/candles', '/futures/instruments', '/fx/rates/current', '/trading-accounts/account-1/futures/instruments',
        ]);
        const publicRead = (config: unknown) => (config as { skipSessionAuth?: boolean } | undefined)?.skipSessionAuth === true;
        assert.deepEqual(sent.map((call) => publicRead(call.config)), guest ? [true, true, true, false] : [false, false, false, false]);
      }
    } finally {
      h.guest.setGuestBrowsing(false);
    }
  });
});
