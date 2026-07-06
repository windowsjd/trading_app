export type KisFixedAssetUniverseEntry = {
  symbol: string;
  kisSymbol: string;
  name: string;
  market: string;
  assetType: 'domestic_stock' | 'us_stock';
  currencyCode: 'KRW' | 'USD';
};

/**
 * Fixed 40-symbol KIS watchlist (15 domestic + 25 US) selected by project
 * decision as the high-liquidity MVP universe. This is the default used when
 * KIS_DOMESTIC_SYMBOLS/KIS_US_SYMBOLS are not set, and the seed source for
 * `scripts/seed-kis-fixed-asset-universe.ts`.
 */
export const KIS_FIXED_ASSET_UNIVERSE: readonly KisFixedAssetUniverseEntry[] =
  [
    { symbol: '005930', kisSymbol: '005930', name: 'Samsung Electronics', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '000660', kisSymbol: '000660', name: 'SK Hynix', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '034020', kisSymbol: '034020', name: 'Doosan Enerbility', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '010140', kisSymbol: '010140', name: 'Samsung Heavy Industries', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '042660', kisSymbol: '042660', name: 'Hanwha Ocean', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '005380', kisSymbol: '005380', name: 'Hyundai Motor', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '000270', kisSymbol: '000270', name: 'Kia', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '035420', kisSymbol: '035420', name: 'NAVER', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '035720', kisSymbol: '035720', name: 'Kakao', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '068270', kisSymbol: '068270', name: 'Celltrion', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '051910', kisSymbol: '051910', name: 'LG Chem', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '066570', kisSymbol: '066570', name: 'LG Electronics', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '086520', kisSymbol: '086520', name: 'Ecopro', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '247540', kisSymbol: '247540', name: 'Ecopro BM', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
    { symbol: '028300', kisSymbol: '028300', name: 'HLB', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },

    { symbol: 'NVDA', kisSymbol: 'NAS:NVDA', name: 'NVIDIA Corp.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'TSLA', kisSymbol: 'NAS:TSLA', name: 'Tesla Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'AMD', kisSymbol: 'NAS:AMD', name: 'Advanced Micro Devices Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'AAPL', kisSymbol: 'NAS:AAPL', name: 'Apple Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'AMZN', kisSymbol: 'NAS:AMZN', name: 'Amazon.com Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'MSFT', kisSymbol: 'NAS:MSFT', name: 'Microsoft Corp.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'GOOGL', kisSymbol: 'NAS:GOOGL', name: 'Alphabet Inc. Class A', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'META', kisSymbol: 'NAS:META', name: 'Meta Platforms Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'PLTR', kisSymbol: 'NAS:PLTR', name: 'Palantir Technologies Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'INTC', kisSymbol: 'NAS:INTC', name: 'Intel Corp.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'SOFI', kisSymbol: 'NAS:SOFI', name: 'SoFi Technologies Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'RIVN', kisSymbol: 'NAS:RIVN', name: 'Rivian Automotive Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'MARA', kisSymbol: 'NAS:MARA', name: 'MARA Holdings Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'WBD', kisSymbol: 'NAS:WBD', name: 'Warner Bros. Discovery Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'CSCO', kisSymbol: 'NAS:CSCO', name: 'Cisco Systems Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'MU', kisSymbol: 'NAS:MU', name: 'Micron Technology Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'QCOM', kisSymbol: 'NAS:QCOM', name: 'Qualcomm Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'PYPL', kisSymbol: 'NAS:PYPL', name: 'PayPal Holdings Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'MSTR', kisSymbol: 'NAS:MSTR', name: 'MicroStrategy Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'SMCI', kisSymbol: 'NAS:SMCI', name: 'Super Micro Computer Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'F', kisSymbol: 'NYS:F', name: 'Ford Motor Co.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'BAC', kisSymbol: 'NYS:BAC', name: 'Bank of America Corp.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'PFE', kisSymbol: 'NYS:PFE', name: 'Pfizer Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'T', kisSymbol: 'NYS:T', name: 'AT&T Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
    { symbol: 'UBER', kisSymbol: 'NYS:UBER', name: 'Uber Technologies Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  ];

export const KIS_FIXED_DOMESTIC_SYMBOLS: readonly string[] =
  KIS_FIXED_ASSET_UNIVERSE.filter(
    (entry) => entry.assetType === 'domestic_stock',
  ).map((entry) => entry.kisSymbol);

export const KIS_FIXED_US_SYMBOLS: readonly string[] =
  KIS_FIXED_ASSET_UNIVERSE.filter(
    (entry) => entry.assetType === 'us_stock',
  ).map((entry) => entry.kisSymbol);
