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
    assert.match(notice?.message ?? '', /현금 잔액과 보유 종목/);
    assert.ok(!serialized.includes('Asset price snapshot'));
    assert.ok(!serialized.includes('f1bda54a'));
    assert.ok(!serialized.includes('effective_at_'));
  });

  it('a settled result with or without a rank keeps its totals final; only an unreadable one is "조회 불가"', () => {
    const settled = (finalResult: TradingAccountPortfolioDto['finalResult']): TradingAccountPortfolioDto => ({
      ...unavailablePortfolio(), mode: 'season', status: 'closed', state: 'available', summary: null, finalResult,
      sectionErrors: [{ section: 'allocation', code: 'FINAL_ALLOCATION_UNAVAILABLE', message: 'x' }],
      reason: undefined, message: undefined,
    });
    const notQualified = getPortfolioNotice(settled({
      state: 'not_qualified', reason: 'FINAL_RANKING_NOT_QUALIFIED', resultSource: 'season_participants',
      totalAssetKrw: '1', returnRate: '0', returnRateMethod: 'initial_capital', rank: null, tier: null,
      maxDrawdown: '0', totalFillCount: 0, reachedReturnAt: null, tradedInstrumentCount: 1,
      recognizedTurnoverKrw: null, endAt: '2026-10-01T00:00:00.000Z', capturedAt: null,
    }));
    assert.equal(notQualified?.title, '최종 자산 비중 조회 불가');
    const unreadable = getPortfolioNotice(settled({ state: 'unavailable', reason: 'FINAL_RANKING_UNAVAILABLE' }));
    assert.equal(unreadable?.title, '최종 결과 조회 불가');
  });
});
