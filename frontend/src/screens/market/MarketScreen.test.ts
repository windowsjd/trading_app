import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

function read(sourcePath: string) {
  return readFileSync(path.join(process.cwd(), 'src', sourcePath), 'utf8');
}

const marketScreen = read('screens/market/MarketScreen.tsx');
const marketSearch = read('screens/market/MarketSearchScreen.tsx');
const marketApi = read('features/market/api.ts');
const marketRow = read('features/market/MarketAssetRow.tsx');
const viewStates = read('models/enums/viewState.ts');

describe('MarketScreen partial-price warning policy', () => {
  it('keeps API price errors without rendering the main-market warning', () => {
    assert.match(marketApi, /priceErrors\?: AssetPriceErrorDto\[\]/u);
    assert.doesNotMatch(marketScreen, /hasPriceErrors/u);
    assert.doesNotMatch(marketScreen, /market_partial_price_unavailable/u);
    assert.doesNotMatch(
      marketScreen,
      /일부 종목 시세를 아직 불러오지 못했습니다\./u,
    );
    assert.doesNotMatch(viewStates, /market_partial_price_unavailable/u);
  });

  it('continues to render every API item through the existing price policy', () => {
    assert.match(marketScreen, /data=\{items\}/u);
    assert.match(marketScreen, /renderItem=\{\(\{ item \}\) =>/u);
    assert.match(marketScreen, /<MarketAssetRow/u);
    assert.match(marketRow, /getAssetPriceText\(displayItem\)/u);
  });

  it('keeps the realtime reconnect warning', () => {
    assert.match(marketScreen, /\{showReconnectBanner \? \(/u);
    assert.match(
      marketScreen,
      /실시간 연결이 불안정합니다\. 마지막 수신 가격을 표시하고\s+있습니다\./u,
    );
    assert.match(marketScreen, /style=\{styles\.inlineWarning\}/u);
  });

  it('keeps normal pagination and does not add an account-mode warning branch', () => {
    assert.match(marketScreen, /marketQuery\.hasNextPage/u);
    assert.match(marketScreen, /marketQuery\.fetchNextPage\(\)/u);
    assert.doesNotMatch(marketScreen, /selectedAccount\?\.mode\s*===/u);
  });

  it('leaves the separate search-result warning unchanged', () => {
    assert.match(
      marketSearch,
      /일부 검색 결과의 시세를 아직 불러오지 못했습니다\./u,
    );
  });
});
