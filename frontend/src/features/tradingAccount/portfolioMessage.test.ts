import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TradingAccountPortfolioDto } from './api.ts';
import { getPortfolioNotice } from './portfolioMessage.ts';

function unavailablePortfolio(): TradingAccountPortfolioDto {
  return {
    tradingAccountId: 'account-1',
    mode: 'general',
    status: 'active',
    state: 'unavailable',
    summary: null,
    allocation: {
      state: 'unavailable',
      cashKrwValue: '0.00000000',
      domesticStockValueKrw: '0.00000000',
      usStockValueKrw: '0.00000000',
      cryptoValueKrw: '0.00000000',
    },
    sectionErrors: [
      {
        section: 'summary',
        code: 'ASSET_PRICE_UNAVAILABLE',
        message:
          'Asset price snapshot is unavailable for asset f1bda54a-5762-4d16-a5b0-76f56327356c.',
      },
    ],
    reason: 'ASSET_PRICE_UNAVAILABLE',
    message:
      'Asset price snapshot is unavailable for asset f1bda54a-5762-4d16-a5b0-76f56327356c.',
  };
}

describe('portfolio user message', () => {
  it('maps price failures to Korean copy without leaking backend details', () => {
    const notice = getPortfolioNotice(unavailablePortfolio());
    const serialized = JSON.stringify(notice);

    assert.equal(notice?.title, '일부 시세 조회 불가');
    assert.match(notice?.message ?? '', /현금 잔액과 보유 수량/);
    assert.ok(!serialized.includes('Asset price snapshot'));
    assert.ok(!serialized.includes('f1bda54a'));
    assert.ok(!serialized.includes('effective_at_'));
  });
});
