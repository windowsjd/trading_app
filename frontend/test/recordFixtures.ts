// Deliberately inconsistent capital/asset vs PnL to catch frontend recomputation.
export function recordDetail({ state = 'available', status = 'settled', long = false } = {}) {
  const asset = (id, pnl, rate, valuationState = 'available') => ({
    assetId: id, symbol: id === 'best' ? '005930' : 'TSLA', market: id === 'best' ? 'KRX' : 'NASDAQ',
    name: long ? '대한민국 미래산업 우량주 투자기업 특별 우선주 ABCDEFGHIJKLMNOPQRSTUVWXYZ' : id === 'best' ? '삼성전자' : 'Tesla',
    assetType: 'domestic_stock', currencyCode: 'KRW', positionState: 'open', valuationState,
    realizedPnlLocal: '100', realizedPnlKrw: '100', unrealizedPnlLocal: '200', unrealizedPnlKrw: '200',
    totalPnlKrw: pnl, returnRate: rate, returnRateState: rate === null ? 'unavailable' : 'available',
  });
  const best = asset('best', long ? '1234567890123456' : '520000', '18.2');
  const worst = asset('worst', long ? '-1234567890123456' : '-180000', '-7.3');
  const missing = asset('missing', '0', null, 'unavailable');
  return {
    state: 'available',
    season: { id: 'record-0', name: long ? '대한민국 모의투자 챔피언십 특별 경쟁 시즌 ABCDEFGHIJKLMNOPQRSTUVWXYZ' : '시즌 1', status, startAt: '2026-09-01T00:00:00Z', endAt: '2026-09-30T00:00:00Z' },
    participant: { id: 'participant-1', initialCapitalKrw: '10000000', finalRank: 100000, finalTier: long ? 'Gold 대한민국 특별 경쟁 등급 ABCDEFGHIJKLMNOPQRSTUVWXYZ' : 'Gold' },
    performance: { state: state === 'unavailable' ? 'unavailable' : 'available', totalAssetKrw: long ? '1234567890123456' : '11234000', returnRate: '12.34', maxDrawdown: '99', snapshotDate: 'private snapshot', capturedAt: 'private timestamp', message: 'RAW_BACKEND_ERROR' },
    activitySummary: { orders: { total: 15, submitted: 1, executed: 8, canceled: 2, rejected: 1 }, exchanges: { total: 2 }, walletTransactions: { total: 18 }, positions: { open: 5 } },
    profitAnalysis: { state, totalPnlKrw: state === 'unavailable' ? '0' : long ? '1234567890123456' : '777777', totalRealizedPnlKrw: state === 'unavailable' ? '0' : '900000', totalUnrealizedPnlKrw: state === 'unavailable' ? '0' : '-122223',
      bestAsset: best, worstAsset: worst, items: [worst, best, ...(state === 'partial_unavailable' ? [missing] : [])], valuationErrors: [{ assetId: 'missing', code: 'RAW_ASSET_ERROR', message: 'RAW_BACKEND_ERROR' }] },
  };
}
export const recordEquity = {
  state: 'available', seasonId: 'record-0',
  points: [
    { time: '2026-09-01', totalAssetKrw: '10000000', returnRate: '0', capturedAt: '2026-09-01T00:00:00Z' },
    { time: '2026-09-12', totalAssetKrw: '12000000', returnRate: '20', capturedAt: '2026-09-12T00:00:00Z' },
    { time: '2026-09-30', totalAssetKrw: '11234000', returnRate: '12.34', capturedAt: '2026-09-30T00:00:00Z' },
  ], pagination: { limit: 500, offset: 0, total: 3, returned: 3, nextOffset: null },
};
