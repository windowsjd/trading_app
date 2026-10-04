import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(
  path.join(process.cwd(), 'src/screens/home/GeneralAccountHome.tsx'),
  'utf8',
);

const holdings = readFileSync(path.join(process.cwd(), 'src/screens/home/HomeHoldings.tsx'), 'utf8');

describe('GeneralAccountHome independent financial reads', () => {
  it('does not gate position queries on portfolio availability', () => {
    assert.match(source, /getTradingAccountPortfolio\(accountId\)/u);
    assert.match(holdings, /getTradingAccountPositions\(accountId/u);
    assert.ok(!source.includes('enabled: available'));
    assert.ok(!source.includes('enabled: portfolioAvailable'));
  });

  it('moves cash and history to Wallet instead of repeating its cards', () => {
    assert.doesNotMatch(source, /walletsQuery|지갑 요약|자산 구성|onOpenLedger|onOpenOrders/u);
  });

  it('does not turn missing position query data into an empty list', () => {
    assert.ok(!source.includes('positionsQuery.data?.positions ?? []'));
    assert.match(holdings, /!positions[\s\S]*보유 종목을 확인할 수 없습니다/u);
    assert.match(holdings, /<PositionAssetRow/u);
    assert.doesNotMatch(source, /평균 매입가|현재가/u);
  });

  it('does not render raw portfolio exception messages', () => {
    assert.ok(!source.includes('portfolio.message'));
    assert.ok(!source.includes('sectionErrors[0]?.message'));
    assert.match(source, /getPortfolioNotice\(portfolio\)/u);
  });

  it('has no exchange-only capability notice or wiring', () => {
    assert.doesNotMatch(source, /환전하기|환전 안내|onOpenFx|capabilities|CTAButton/u);
  });
});
