import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  guestReadConfig,
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
    return { calls, guest, market, asset };
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
});
