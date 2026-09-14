import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getAssetTradingWarning } from './tradingUx.ts';
import { getTradingAccountCapabilities } from '../tradingAccount/capabilities.ts';

describe('asset market state is separate from selected-account permission', () => {
  it('does not warn for a healthy asset', () => {
    assert.equal(
      getAssetTradingWarning({ tradable: true, tradeBlockedReason: null }),
      null,
    );
  });
  for (const reason of [
    'SEASON_NOT_ACTIVE',
    'SEASON_NOT_JOINED',
    'PARTICIPANT_EXCLUDED',
    'PARTICIPANT_NOT_ACTIVE',
    'TRADING_ACCOUNT_NOT_ACTIVE',
  ]) {
    it(`ignores cached ${reason} in asset UX without granting account permission`, () => {
      assert.equal(
        getAssetTradingWarning({
          tradable: false,
          tradeBlockedReason: ` ${reason.toLowerCase()} `,
        }),
        null,
      );
      const season = {
        seasonStatus: 'active' as const,
        startAt: '2026-01-01',
        endAt: '2027-01-01',
        participantStatus: 'excluded' as const,
      };
      const account = {
        mode: 'season' as const,
        status: 'active' as const,
        season: season as never,
      };
      const caps = getTradingAccountCapabilities(
        account,
        Date.parse('2026-06-01'),
      )!;
      assert.equal(caps.canTrade, false);
      assert.equal(caps.canExchange, false);
      assert.equal(caps.canRead, true);
      assert.equal(caps.canCancelOrder, true);
    });
  }
  for (const reason of [
    'ASSET_INACTIVE',
    'MARKET_CLOSED',
    'PRICE_UNAVAILABLE',
    'PRICE_STALE',
    'UNKNOWN',
    'PROVIDER_UNAVAILABLE',
  ]) {
    it(`preserves the actual asset restriction ${reason}`, () => {
      assert.ok(
        getAssetTradingWarning({ tradable: false, tradeBlockedReason: reason }),
      );
    });
  }
  it('keeps an unexplained asset restriction visible', () => {
    assert.ok(getAssetTradingWarning({ tradable: false }));
  });
});
