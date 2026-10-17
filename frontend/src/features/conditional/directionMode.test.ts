import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DIRECTION_REQUIRED,
  LIVE_PRICE_UNAVAILABLE,
  MARKET_STATE_UNAVAILABLE,
  OFF_SESSION_REGISTRATION_NOTICE,
  OFF_SESSION_UNSUPPORTED,
  getConditionalRegistrationErrorMessage,
  resolveConditionalDirectionMode,
  shouldRefreshAfterRegistrationError,
} from './directionMode.ts';

const both = ['KRX', 'US'];
const mode = (assetType: string, marketStatus: string | null | undefined, offSessionMarkets: string[] | undefined = both) =>
  resolveConditionalDirectionMode({ assetType, marketStatus, offSessionMarkets });

describe('conditional direction mode (2026-10-18)', () => {
  it('crypto never closes: always automatic, whatever the status says', () => {
    for (const status of ['always_open', 'closed', 'unknown', null, undefined])
      assert.deepEqual(mode('crypto', status), { mode: 'auto' });
  });

  it('a stock in its regular session decides 이상/이하 from the current price', () => {
    assert.deepEqual(mode('domestic_stock', 'open'), { mode: 'auto' });
    assert.deepEqual(mode('us_stock', 'open'), { mode: 'auto' });
    // In session the server capability does not matter.
    assert.deepEqual(resolveConditionalDirectionMode({ assetType: 'domestic_stock', marketStatus: 'open', offSessionMarkets: undefined }), { mode: 'auto' });
  });

  it('a confirmed-closed stock market lets the user choose, per listed market', () => {
    assert.deepEqual(mode('domestic_stock', 'closed'), { mode: 'manual' });
    assert.deepEqual(mode('us_stock', 'closed'), { mode: 'manual' });
    // US is listed only while its conditional orders are supported.
    assert.deepEqual(mode('us_stock', 'closed', ['KRX']), { mode: 'blocked', reason: OFF_SESSION_UNSUPPORTED });
    assert.deepEqual(mode('domestic_stock', 'closed', ['KRX']), { mode: 'manual' });
  });

  it('an older server (no offSessionMarkets) never registers a closed market', () => {
    for (const offSessionMarkets of [undefined, null, []])
      assert.deepEqual(resolveConditionalDirectionMode({ assetType: 'domestic_stock', marketStatus: 'closed', offSessionMarkets }),
        { mode: 'blocked', reason: OFF_SESSION_UNSUPPORTED }, String(offSessionMarkets));
  });

  it('an unknown market state is never taken for a closure', () => {
    for (const status of ['unknown', 'calendar_unavailable', '', null, undefined])
      assert.deepEqual(mode('domestic_stock', status), { mode: 'blocked', reason: MARKET_STATE_UNAVAILABLE }, String(status));
  });

  it('keeps the three situations apart in its copy', () => {
    assert.equal(OFF_SESSION_REGISTRATION_NOTICE, '정규장 외 시간입니다. 감시 방향을 선택하면 조건주문을 등록할 수 있으며, 다음 정규장부터 감시합니다.');
    assert.equal(LIVE_PRICE_UNAVAILABLE, '현재가를 확인할 수 없습니다. 시세가 업데이트된 후 다시 시도해주세요.');
    assert.equal(new Set([OFF_SESSION_REGISTRATION_NOTICE, LIVE_PRICE_UNAVAILABLE, MARKET_STATE_UNAVAILABLE, OFF_SESSION_UNSUPPORTED, DIRECTION_REQUIRED]).size, 5);
    assert.match(MARKET_STATE_UNAVAILABLE, /시장 운영 상태를 확인할 수 없어/);
  });

  it('maps the registration refusals to this form\'s words and re-reads the screen after them', () => {
    assert.equal(getConditionalRegistrationErrorMessage('CONDITIONAL_PRICE_UNAVAILABLE'), LIVE_PRICE_UNAVAILABLE);
    assert.equal(getConditionalRegistrationErrorMessage('MARKET_CALENDAR_UNAVAILABLE'), MARKET_STATE_UNAVAILABLE);
    assert.equal(getConditionalRegistrationErrorMessage('CONDITIONAL_BUY_ALREADY_MET'), null, 'the shared copy stays');
    assert.equal(getConditionalRegistrationErrorMessage(null), null);
    for (const code of ['CONDITIONAL_PRICE_UNAVAILABLE', 'MARKET_CALENDAR_UNAVAILABLE', 'CONDITIONAL_BUY_ALREADY_MET', 'CONDITIONAL_SELL_ALREADY_MET'])
      assert.equal(shouldRefreshAfterRegistrationError(code), true, code);
    for (const code of ['INSUFFICIENT_BALANCE', 'CONDITIONAL_BUY_LIMIT_EXCEEDED', null])
      assert.equal(shouldRefreshAfterRegistrationError(code), false, String(code));
  });
});
