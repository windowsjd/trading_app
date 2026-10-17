export type KisFixedAssetUniverseEntry = {
  symbol: string;
  kisSymbol: string;
  name: string;
  market: string;
  assetType: 'domestic_stock' | 'us_stock';
  currencyCode: 'KRW' | 'USD';
  /**
   * First regular session on its exchange (YYYY-MM-DD), recorded only for a
   * stock listed inside the longest chart window (576 sessions). The chart
   * history audit reports sessions before it as "limited by listing", never
   * as missing data.
   */
  listedOn?: string;
};

/**
 * First phase (MVP, project decision): 15 domestic + 25 US high-liquidity
 * stocks. Besides seeding, these are the KIS runtime defaults below.
 */
// One entry per line keeps the universe reviewable as a table.
// prettier-ignore
export const FIRST_PHASE_UNIVERSE: readonly KisFixedAssetUniverseEntry[] = [
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

/**
 * 2026-10-17 expansion: 55 domestic + 75 US stocks ranked by 2026
 * year-to-date cumulative trading value through 2026-10-16 (KRX KRW / US USD;
 * selection evidence in
 * docs/investigations/2026-10-17-stock-expansion-us100-kr70/). Prices come
 * from KOSCOM (domestic) and Tiingo (US) only: none of these is on the KIS
 * watchlist (KIS serves at most 41 subscriptions).
 */
// One entry per line keeps the universe reviewable as a table.
// prettier-ignore
export const EXPANSION_2026_10_17: readonly KisFixedAssetUniverseEntry[] = [
  // Domestic 55, by 2026 YTD KRX trading value (KIS market J = KRX only).
  { symbol: '009150', kisSymbol: '009150', name: 'Samsung Electro-Mechanics', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '402340', kisSymbol: '402340', name: 'SK Square', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '006400', kisSymbol: '006400', name: 'Samsung SDI', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '042700', kisSymbol: '042700', name: 'Hanmi Semiconductor', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '047040', kisSymbol: '047040', name: 'Daewoo E&C', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '036930', kisSymbol: '036930', name: 'Jusung Engineering', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '010170', kisSymbol: '010170', name: 'Taihan Fiberoptics', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '012450', kisSymbol: '012450', name: 'Hanwha Aerospace', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '012330', kisSymbol: '012330', name: 'Hyundai Mobis', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '032820', kisSymbol: '032820', name: 'Woori Technology', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '011070', kisSymbol: '011070', name: 'LG Innotek', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '080220', kisSymbol: '080220', name: 'Jeju Semiconductor', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '001440', kisSymbol: '001440', name: 'Taihan Cable & Solution', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '105560', kisSymbol: '105560', name: 'KB Financial Group', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '006800', kisSymbol: '006800', name: 'Mirae Asset Securities', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '079550', kisSymbol: '079550', name: 'LIG Defense & Aerospace', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '196170', kisSymbol: '196170', name: 'Alteogen', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '329180', kisSymbol: '329180', name: 'HD Hyundai Heavy Industries', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '010120', kisSymbol: '010120', name: 'LS ELECTRIC', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '028260', kisSymbol: '028260', name: 'Samsung C&T', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '403870', kisSymbol: '403870', name: 'HPSP', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '272210', kisSymbol: '272210', name: 'Hanwha Systems', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '009830', kisSymbol: '009830', name: 'Hanwha Solutions', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '005490', kisSymbol: '005490', name: 'POSCO Holdings', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '373220', kisSymbol: '373220', name: 'LG Energy Solution', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '000720', kisSymbol: '000720', name: 'Hyundai E&C', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '298040', kisSymbol: '298040', name: 'Hyosung Heavy Industries', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '267260', kisSymbol: '267260', name: 'HD Hyundai Electric', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '475150', kisSymbol: '475150', name: 'SK eternix', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '064350', kisSymbol: '064350', name: 'Hyundai Rotem', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '007660', kisSymbol: '007660', name: 'ISU Petasys', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '055550', kisSymbol: '055550', name: 'Shinhan Financial Group', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '240810', kisSymbol: '240810', name: 'Wonik IPS', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '000150', kisSymbol: '000150', name: 'Doosan Corp.', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '278470', kisSymbol: '278470', name: 'APR', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '090710', kisSymbol: '090710', name: 'Hyulim Robot', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '032830', kisSymbol: '032830', name: 'Samsung Life Insurance', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '000250', kisSymbol: '000250', name: 'Sam Chun Dang Pharm', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '006340', kisSymbol: '006340', name: 'Dawon Cable', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '277810', kisSymbol: '277810', name: 'Rainbow Robotics', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '353200', kisSymbol: '353200', name: 'Daeduck Electronics', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '017670', kisSymbol: '017670', name: 'SK Telecom', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '034730', kisSymbol: '034730', name: 'SK Inc.', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '015760', kisSymbol: '015760', name: 'KEPCO', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '047810', kisSymbol: '047810', name: 'Korea Aerospace Industries', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '322000', kisSymbol: '322000', name: 'HD Hyundai Energy Solutions', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '064400', kisSymbol: '064400', name: 'LG CNS', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW', listedOn: '2025-02-05' },
  { symbol: '086790', kisSymbol: '086790', name: 'Hana Financial Group', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '307950', kisSymbol: '307950', name: 'Hyundai AutoEver', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '028050', kisSymbol: '028050', name: 'Samsung E&A', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '454910', kisSymbol: '454910', name: 'Doosan Robotics', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '096770', kisSymbol: '096770', name: 'SK Innovation', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '108490', kisSymbol: '108490', name: 'ROBOTIS', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '058470', kisSymbol: '058470', name: 'Leeno Industrial', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },
  { symbol: '298380', kisSymbol: '298380', name: 'ABL Bio', market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW' },

  // US 75, by 2026 YTD dollar volume (estimate: Σ close × consolidated volume).
  // listedOn = first session of the current listing inside the 576-session window
  // (NBIS: Nasdaq trading resumed 2024-10-21 after the 2022 suspension).
  { symbol: 'SNDK', kisSymbol: 'NAS:SNDK', name: 'Sandisk Corp.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD', listedOn: '2025-02-24' },
  { symbol: 'AVGO', kisSymbol: 'NAS:AVGO', name: 'Broadcom Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'SPCX', kisSymbol: 'NAS:SPCX', name: 'Space Exploration Technologies Corp. Class A', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD', listedOn: '2026-06-12' },
  { symbol: 'GOOG', kisSymbol: 'NAS:GOOG', name: 'Alphabet Inc. Class C', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'MRVL', kisSymbol: 'NAS:MRVL', name: 'Marvell Technology Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'ORCL', kisSymbol: 'NYS:ORCL', name: 'Oracle Corp.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'LITE', kisSymbol: 'NAS:LITE', name: 'Lumentum Holdings Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'AMAT', kisSymbol: 'NAS:AMAT', name: 'Applied Materials Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'WDC', kisSymbol: 'NAS:WDC', name: 'Western Digital Corp.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'NFLX', kisSymbol: 'NAS:NFLX', name: 'Netflix Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'NBIS', kisSymbol: 'NAS:NBIS', name: 'Nebius Group N.V.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD', listedOn: '2024-10-21' },
  { symbol: 'LLY', kisSymbol: 'NYS:LLY', name: 'Eli Lilly and Co.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'STX', kisSymbol: 'NAS:STX', name: 'Seagate Technology Holdings PLC', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'LRCX', kisSymbol: 'NAS:LRCX', name: 'Lam Research Corp.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'WMT', kisSymbol: 'NAS:WMT', name: 'Walmart Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'JPM', kisSymbol: 'NYS:JPM', name: 'JPMorgan Chase & Co.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'BE', kisSymbol: 'NYS:BE', name: 'Bloom Energy Corp.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'CRWV', kisSymbol: 'NAS:CRWV', name: 'CoreWeave Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD', listedOn: '2025-03-28' },
  { symbol: 'XOM', kisSymbol: 'NYS:XOM', name: 'ExxonMobil Holdings Corp.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'CRM', kisSymbol: 'NYS:CRM', name: 'Salesforce Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'DELL', kisSymbol: 'NYS:DELL', name: 'Dell Technologies Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'UNH', kisSymbol: 'NYS:UNH', name: 'UnitedHealth Group Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'V', kisSymbol: 'NYS:V', name: 'Visa Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'HOOD', kisSymbol: 'NAS:HOOD', name: 'Robinhood Markets Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'GEV', kisSymbol: 'NYS:GEV', name: 'GE Vernova Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'APP', kisSymbol: 'NAS:APP', name: 'AppLovin Corp.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'NOW', kisSymbol: 'NYS:NOW', name: 'ServiceNow Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'BRK.B', kisSymbol: 'NYS:BRK.B', name: 'Berkshire Hathaway Inc. Class B', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'CAT', kisSymbol: 'NYS:CAT', name: 'Caterpillar Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'GS', kisSymbol: 'NYS:GS', name: 'Goldman Sachs Group Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'COST', kisSymbol: 'NAS:COST', name: 'Costco Wholesale Corp.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'KLAC', kisSymbol: 'NAS:KLAC', name: 'KLA Corp.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'PANW', kisSymbol: 'NAS:PANW', name: 'Palo Alto Networks Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'IREN', kisSymbol: 'NAS:IREN', name: 'IREN Ltd.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'CVX', kisSymbol: 'NYS:CVX', name: 'Chevron Corp.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'RKLB', kisSymbol: 'NAS:RKLB', name: 'Rocket Lab Corp.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'JNJ', kisSymbol: 'NYS:JNJ', name: 'Johnson & Johnson', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'COHR', kisSymbol: 'NYS:COHR', name: 'Coherent Corp.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'TXN', kisSymbol: 'NAS:TXN', name: 'Texas Instruments Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'CRWD', kisSymbol: 'NAS:CRWD', name: 'CrowdStrike Holdings Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'GLW', kisSymbol: 'NYS:GLW', name: 'Corning Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'IBM', kisSymbol: 'NYS:IBM', name: 'International Business Machines Corp.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'MA', kisSymbol: 'NYS:MA', name: 'Mastercard Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'COIN', kisSymbol: 'NAS:COIN', name: 'Coinbase Global Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'VRT', kisSymbol: 'NYS:VRT', name: 'Vertiv Holdings Co.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'GE', kisSymbol: 'NYS:GE', name: 'GE Aerospace', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'C', kisSymbol: 'NYS:C', name: 'Citigroup Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'INTU', kisSymbol: 'NAS:INTU', name: 'Intuit Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'HD', kisSymbol: 'NYS:HD', name: 'Home Depot Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'BA', kisSymbol: 'NYS:BA', name: 'Boeing Co.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'ABBV', kisSymbol: 'NYS:ABBV', name: 'AbbVie Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'ADI', kisSymbol: 'NAS:ADI', name: 'Analog Devices Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'SNOW', kisSymbol: 'NYS:SNOW', name: 'Snowflake Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'BKNG', kisSymbol: 'NAS:BKNG', name: 'Booking Holdings Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'PG', kisSymbol: 'NYS:PG', name: 'Procter & Gamble Co.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'ADBE', kisSymbol: 'NAS:ADBE', name: 'Adobe Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'ASTS', kisSymbol: 'NAS:ASTS', name: 'AST SpaceMobile Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'CRDO', kisSymbol: 'NAS:CRDO', name: 'Credo Technology Group Holding Ltd.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'KO', kisSymbol: 'NYS:KO', name: 'Coca-Cola Co.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'WFC', kisSymbol: 'NYS:WFC', name: 'Wells Fargo & Co.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'MRK', kisSymbol: 'NYS:MRK', name: 'Merck & Co. Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'SHOP', kisSymbol: 'NAS:SHOP', name: 'Shopify Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'CRCL', kisSymbol: 'NYS:CRCL', name: 'Circle Internet Group Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD', listedOn: '2025-06-05' },
  { symbol: 'ALAB', kisSymbol: 'NAS:ALAB', name: 'Astera Labs Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'ACN', kisSymbol: 'NYS:ACN', name: 'Accenture PLC', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'MRNA', kisSymbol: 'NAS:MRNA', name: 'Moderna Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'AAOI', kisSymbol: 'NAS:AAOI', name: 'Applied Optoelectronics Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'APH', kisSymbol: 'NYS:APH', name: 'Amphenol Corp.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'VZ', kisSymbol: 'NYS:VZ', name: 'Verizon Communications Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'ANET', kisSymbol: 'NYS:ANET', name: 'Arista Networks Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'TMO', kisSymbol: 'NYS:TMO', name: 'Thermo Fisher Scientific Inc.', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'TER', kisSymbol: 'NAS:TER', name: 'Teradyne Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'MCD', kisSymbol: 'NYS:MCD', name: "McDonald's Corp.", market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'MS', kisSymbol: 'NYS:MS', name: 'Morgan Stanley', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
  { symbol: 'PEP', kisSymbol: 'NAS:PEP', name: 'PepsiCo Inc.', market: 'NAS', assetType: 'us_stock', currencyCode: 'USD' },
];

/**
 * 2026-10-17 replacement for the delisted WBD (see `RETIRED_FIXED_ASSETS`):
 * the next stock by the same 2026 YTD trading-value ranking and rule R1 —
 * ABT, new-name rank #76 right after PEP (#75), overall #100 (evidence:
 * docs/investigations/2026-10-17-stock-expansion-us100-kr70/research/us/
 * us_ranked_pool.csv; NYSE common stock, Tiingo row NYSE|Stock|USD).
 */
// prettier-ignore
export const REPLACEMENT_2026_10_17: readonly KisFixedAssetUniverseEntry[] = [
  { symbol: 'ABT', kisSymbol: 'NYS:ABT', name: 'Abbott Laboratories', market: 'NYS', assetType: 'us_stock', currencyCode: 'USD' },
];

export type KisRetiredAssetEntry = {
  symbol: string;
  market: string;
  assetType: 'domestic_stock' | 'us_stock';
  /** KST date the stock left the universe (YYYY-MM-DD). */
  retiredOn: string;
  reason: string;
};

/**
 * Former members that are no longer tradable. Their `assets` rows stay (Asset
 * id, candles, orders, positions are history); the seed only keeps them
 * `isActive=false`, so a rerun never re-activates them, and they leave every
 * default list derived below (Tiingo official symbols, KIS defaults).
 */
export const RETIRED_FIXED_ASSETS: readonly KisRetiredAssetEntry[] = [
  {
    symbol: 'WBD',
    market: 'NAS',
    assetType: 'us_stock',
    retiredOn: '2026-10-17',
    reason:
      'Delisted 2026-10-06 (SEC Form 25-NSE; Form 15 2026-10-16); replaced by ABT',
  },
];

function isRetired(entry: { market: string; symbol: string }): boolean {
  return RETIRED_FIXED_ASSETS.some(
    (retired) =>
      retired.market === entry.market && retired.symbol === entry.symbol,
  );
}

/**
 * The fixed stock universe: 70 domestic + 100 US. It is the seed source for
 * `scripts/seed-kis-fixed-asset-universe.ts` and the Tiingo official symbol
 * default. Existing rows keep their Asset IDs; entries are only appended, and
 * a retired member is filtered out (its row is deactivated, never deleted).
 */
export const KIS_FIXED_ASSET_UNIVERSE: readonly KisFixedAssetUniverseEntry[] = [
  ...FIRST_PHASE_UNIVERSE,
  ...EXPANSION_2026_10_17,
  ...REPLACEMENT_2026_10_17,
].filter((entry) => !isRetired(entry));

/**
 * KIS runtime defaults when KIS_DOMESTIC_SYMBOLS/KIS_US_SYMBOLS are not set:
 * the first phase only. The KIS watchlist is capped at 41 symbols
 * (`KIS_MAX_WATCHLIST_SIZE`) and every provider-config read builds it, so the
 * 100-stock US universe must never become its default.
 */
export const KIS_FIXED_DOMESTIC_SYMBOLS: readonly string[] =
  FIRST_PHASE_UNIVERSE.filter(
    (entry) => entry.assetType === 'domestic_stock' && !isRetired(entry),
  ).map((entry) => entry.kisSymbol);

export const KIS_FIXED_US_SYMBOLS: readonly string[] =
  FIRST_PHASE_UNIVERSE.filter(
    (entry) => entry.assetType === 'us_stock' && !isRetired(entry),
  ).map((entry) => entry.kisSymbol);
