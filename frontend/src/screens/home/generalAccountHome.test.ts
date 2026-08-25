import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(
  path.join(process.cwd(), 'src/screens/home/GeneralAccountHome.tsx'),
  'utf8',
);

describe('GeneralAccountHome independent financial reads', () => {
  it('does not gate wallet or position queries on portfolio availability', () => {
    assert.match(source, /getTradingAccountPortfolio\(accountId\)/u);
    assert.match(source, /getTradingAccountWallets\(accountId\)/u);
    assert.match(source, /getTradingAccountPositions\(accountId/u);
    assert.ok(!source.includes('enabled: available'));
    assert.ok(!source.includes('enabled: portfolioAvailable'));
  });

  it('renders loading and error branches before reading wallet amounts', () => {
    assert.match(source, /walletsQuery\.isLoading[\s\S]*SectionSkeleton/u);
    assert.match(
      source,
      /walletsQuery\.isError[\s\S]*지갑 요약을 불러오지 못했습니다/u,
    );
    assert.match(source, /getKnownWalletBalanceAmount/u);
    assert.ok(!source.includes('getWalletBalanceAmount(walletsQuery.data'));
  });

  it('does not turn missing position query data into an empty list', () => {
    assert.ok(!source.includes('positionsQuery.data?.positions ?? []'));
    assert.match(source, /!positions[\s\S]*보유 종목을 확인할 수 없습니다/u);
    assert.match(source, /getPositionDisplay\(position\)/u);
    assert.match(source, /시세 조회 불가/u);
  });

  it('does not render raw portfolio exception messages', () => {
    assert.ok(!source.includes('portfolio.message'));
    assert.ok(!source.includes('sectionErrors[0]?.message'));
    assert.match(source, /getPortfolioNotice\(portfolio\)/u);
  });

  it('never renders a season-only capability reason', () => {
    assert.match(source, /getCapabilityBlockMessage\(/u);
    assert.ok(!source.includes('CAPABILITY_BLOCK_MESSAGE['));
    assert.doesNotMatch(source, /season_not_active/iu);
  });
});
