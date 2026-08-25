import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

function read(sourcePath: string) {
  return readFileSync(path.join(process.cwd(), 'src', sourcePath), 'utf8');
}

const marketRow = read('features/market/MarketAssetRow.tsx');
const marketScreen = read('screens/market/MarketScreen.tsx');
const marketSearch = read('screens/market/MarketSearchScreen.tsx');
const assetDetail = read('screens/asset/AssetDetailScreen.tsx');
const orderScreen = read('screens/order/OrderScreen.tsx');
const orderMapper = read('features/order/mapper.ts');
const recordMapper = read('features/record/api.ts');
const recordOrderList = read('screens/record/RecordOrderListScreen.tsx');
const generalAccountHome = read('screens/home/GeneralAccountHome.tsx');
const walletFxScreen = read('screens/wallet/WalletFxScreen.tsx');

describe('numeric asset symbol display contract', () => {
  it('uses shared helpers across market, detail, order and record surfaces', () => {
    assert.match(marketRow, /getAssetSymbolMarketDisplay\(displayItem\)/u);
    assert.match(marketSearch, /getAssetSymbolMarketDisplay\(item\)/u);
    assert.match(assetDetail, /getAssetNameDisplay\(asset\)/u);
    assert.match(orderScreen, /getAssetNameDisplay\(asset\)/u);
    assert.match(orderMapper, /getAssetNameDisplay\(asset\)/u);
    assert.match(recordMapper, /getAssetSymbolDisplay\(/u);
    assert.match(recordOrderList, /display\.symbol \?/u);
  });

  it('keeps numeric-symbol search wired to the API query', () => {
    assert.match(marketSearch, /search:\s*trimmedSearchText \|\| undefined/u);
    assert.match(marketSearch, /placeholder="종목명 또는 심볼 검색"/u);
    assert.match(marketSearch, /message="종목명 또는 심볼로 검색할 수 있습니다\."/u);
  });

  it('does not render raw market-row symbols or dangling separators', () => {
    assert.doesNotMatch(marketRow, /\{displayItem\.symbol\}\s*·/u);
    assert.doesNotMatch(marketSearch, /\{item\.symbol\}\s*·/u);
  });
});

describe('general-account season reason display contract', () => {
  it('passes the selected account mode through market list and search rows', () => {
    assert.match(marketScreen, /accountMode=\{selectedAccount\?\.mode\}/u);
    assert.match(marketRow, /getAssetTradeBlockedReasonDisplay\(/u);
    assert.match(marketSearch, /getAssetTradeBlockedReasonDisplay\(/u);
  });

  it('sanitizes asset reasons on detail and order surfaces', () => {
    assert.match(assetDetail, /getAssetTradeBlockedReasonDisplay\(/u);
    assert.match(orderScreen, /getAssetTradeBlockedReasonDisplay\(/u);
    assert.doesNotMatch(assetDetail, /asset\.tradeBlockedReason\s*\?\?/u);
    assert.doesNotMatch(orderScreen, /asset\.tradeBlockedReason\s*\?\?/u);
  });

  it('uses account-aware capability and API-error messages', () => {
    assert.match(generalAccountHome, /getCapabilityBlockMessage\(/u);
    assert.match(orderScreen, /capabilities\?\.isGeneral === true/u);
    assert.match(walletFxScreen, /capabilities\?\.isGeneral === true/u);
    assert.doesNotMatch(generalAccountHome, /CAPABILITY_BLOCK_MESSAGE\[/u);
  });
});

const datetimeSources = [
  'components/charts/CandlestickChart.tsx',
  'features/order/mapper.ts',
  'features/record/api.ts',
  'features/reward/api.ts',
  'features/wallet/mapper.ts',
  'screens/home/PortfolioScreen.tsx',
  'screens/home/SeasonAccountHome.tsx',
  'screens/home/WalletTransactionsScreen.tsx',
  'screens/ranking/RankingScreen.tsx',
  'screens/record/RecordProfitAnalysisScreen.tsx',
  'screens/record/RecordSeasonDetailScreen.tsx',
  'screens/record/RecordSeasonListScreen.tsx',
  'screens/season/SeasonJoinScreen.tsx',
  'screens/wallet/WalletFxScreen.tsx',
];

describe('KST timestamp display contract', () => {
  it('routes every current user-facing timestamp surface through the helper', () => {
    for (const sourcePath of datetimeSources) {
      assert.match(read(sourcePath), /formatKstDateTime/u, sourcePath);
    }
  });

  it('keeps date-only fields out of the datetime formatter', () => {
    const ranking = read('screens/ranking/RankingScreen.tsx');
    const recordDetail = read('screens/record/RecordSeasonDetailScreen.tsx');
    assert.doesNotMatch(ranking, /formatKstDateTime\([^)]*rankingDate/u);
    assert.doesNotMatch(recordDetail, /formatKstDateTime\([^)]*snapshotDate/u);
  });
});
