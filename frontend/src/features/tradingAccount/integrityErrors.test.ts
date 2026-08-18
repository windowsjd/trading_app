import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyAccountError,
  getIntegrityErrorMessage,
  isCapabilityLimitCode,
  isMissingSelectedAccountError,
  isTradingAccountIntegrityCode,
  TRADING_ACCOUNT_INTEGRITY_CODES,
} from './integrityErrors.ts';

function apiError(status: number, code?: string) {
  return {
    isAxiosError: true,
    response: {
      status,
      data: code ? { error: { code, message: 'server message' } } : {},
    },
  };
}

describe('structural integrity errors are never empty data', () => {
  it('classifies every integrity code as integrity', () => {
    for (const code of TRADING_ACCOUNT_INTEGRITY_CODES) {
      assert.equal(
        classifyAccountError(apiError(500, code)),
        'integrity',
        `${code} must be an integrity fault`,
      );
      assert.ok(isTradingAccountIntegrityCode(code));
    }
  });

  it('gives an integrity fault a retry/contact message, not an empty state', () => {
    const message = getIntegrityErrorMessage(
      apiError(500, 'GENERAL_PERFORMANCE_INTEGRITY'),
    );

    assert.ok(message);
    // Must not read as "no data yet" or "coming soon".
    assert.ok(!/데이터가 없습니다/.test(message!));
    assert.ok(!/준비 중입니다\.$/.test(message!));
    assert.match(message!, /고객센터|다시 시도/);
  });

  it('returns no integrity message for a non-integrity error', () => {
    assert.equal(getIntegrityErrorMessage(apiError(500, 'SOMETHING_ELSE')), null);
    assert.equal(getIntegrityErrorMessage(apiError(404, 'TRADING_ACCOUNT_NOT_FOUND')), null);
  });

  it('covers the ranking and settlement integrity codes from 작업 8', () => {
    for (const code of [
      'SEASON_RANKING_SCOPE_REPAIR_REQUIRED',
      'SEASON_RANKING_SCOPE_MISMATCH',
      'SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED',
      'SEASON_RANKING_SOURCE_SCOPE_MISMATCH',
      'FINAL_RESULTS_INTEGRITY',
      'AD_REWARD_CLAIM_INTEGRITY',
    ]) {
      assert.equal(classifyAccountError(apiError(500, code)), 'integrity');
    }
  });
});

describe('capability limits are kept separate from damage', () => {
  it('classifies the remaining FX gate as a capability limit', () => {
    for (const code of ['GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED']) {
      assert.equal(classifyAccountError(apiError(409, code)), 'capability_limit');
      assert.ok(isCapabilityLimitCode(code));
      // And never as integrity: they are not damage and never will be.
      assert.equal(isTradingAccountIntegrityCode(code), false);
    }
  });

  it('does not fold TRADING_ACCOUNT_NOT_ACTIVE into the not-implemented message', () => {
    assert.equal(
      classifyAccountError(apiError(409, 'TRADING_ACCOUNT_NOT_ACTIVE')),
      'account_not_active',
    );
  });
});

describe('other error kinds', () => {
  it('keeps 401 on the existing auth path', () => {
    assert.equal(classifyAccountError(apiError(401, 'UNAUTHORIZED')), 'unauthorized');
    // 401 wins even if a code is present.
    assert.equal(classifyAccountError(apiError(401)), 'unauthorized');
  });

  it('treats the shared 404 as "not my account" without probing existence', () => {
    assert.equal(
      classifyAccountError(apiError(404, 'TRADING_ACCOUNT_NOT_FOUND')),
      'account_not_found',
    );
    assert.ok(isMissingSelectedAccountError(apiError(404, 'TRADING_ACCOUNT_NOT_FOUND')));
    // Unknown id and another user's id are deliberately identical server-side,
    // and the client does not try to tell them apart.
    assert.ok(isMissingSelectedAccountError(apiError(404)));
  });

  it('leaves transient price/FX section errors alone', () => {
    // These arrive INSIDE a success envelope as sectionErrors, so they never
    // reach this classifier as thrown errors at all.
    assert.equal(classifyAccountError(apiError(500, 'FX_RATE_UNAVAILABLE')), 'other');
    assert.equal(classifyAccountError(apiError(500, 'ASSET_PRICE_UNAVAILABLE')), 'other');
  });

  it('classifies an unknown failure as other rather than guessing', () => {
    assert.equal(classifyAccountError(new Error('boom')), 'other');
    assert.equal(classifyAccountError(undefined), 'other');
  });
});
