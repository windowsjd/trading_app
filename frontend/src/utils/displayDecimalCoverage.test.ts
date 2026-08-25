import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

function read(sourcePath: string) {
  return readFileSync(path.join(process.cwd(), 'src', sourcePath), 'utf8');
}

describe('app-wide decimal display coverage', () => {
  it('routes direct decimal fields through display formatters', () => {
    const orderMapper = read('features/order/mapper.ts');
    const walletMapper = read('features/wallet/mapper.ts');
    const recordApi = read('features/record/api.ts');
    const seasonJoin = read('screens/season/SeasonJoinScreen.tsx');
    const walletScreen = read('screens/wallet/WalletFxScreen.tsx');

    for (const source of [orderMapper, walletMapper, recordApi]) {
      assert.match(source, /formatDisplayDecimal/u);
    }
    assert.match(
      seasonJoin,
      /formatDisplayDecimal\(season\.tradeFeeRate\)/u,
    );
    assert.match(
      seasonJoin,
      /formatDisplayDecimal\(season\.fxFeeRate\)/u,
    );
    assert.match(
      walletScreen,
      /formatDisplayDecimal\(rateQuery\.data\.rate\)/u,
    );
  });

  it('formats USD wallet balances and generic chart labels consistently', () => {
    const generalHome = read('screens/home/GeneralAccountHome.tsx');
    const seasonHome = read('screens/home/SeasonAccountHome.tsx');
    const lineChart = read('components/charts/LineChart.tsx');
    const donutChart = read('components/charts/DonutChart.tsx');

    assert.match(generalHome, /formatUsd\(usdBalance\)/u);
    assert.match(seasonHome, /formatUsd\(usdBalance\)/u);
    assert.match(lineChart, /formatDisplayDecimal\(value\.toFixed\(2\)\)/u);
    assert.match(donutChart, /formatPercent\(percentage, 1\)/u);
  });
});
