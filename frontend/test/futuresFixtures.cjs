function futuresFixture(accountId = 'A', options = {}) {
  // Model evidence captured before the HTTP response/render, rather than a
  // zero-age timestamp that can cross the screen clock during async query reads.
  // One second models feed/HTTP delay within the unchanged five-second policy.
  const observedAt = Date.now() - 1000;
  const at = new Date(observedAt - (options.stale ? 6000 : 0)).toISOString();
  const referenceAt = new Date(observedAt).toISOString();
  const mode = options.mode ?? 'ENABLED';
  const capabilities = { tradingMode: mode, canOpen: mode === 'ENABLED', canIncrease: mode === 'ENABLED', canReduce: mode !== 'DISABLED', canClose: mode !== 'DISABLED', reason: null };
  const instrument = { id: 'btc', isActive: true, productType: 'synthetic_perpetual', settlementCurrency: 'USD', underlying: { assetId: 'asset-btc', symbol: 'BTCUSDT', name: '비트코인', market: 'BINANCE', displayPriceDecimals: 2 }, markPrice: options.large ? '9876543210123456.12345678' : '101', referencePrice: '102', markState: options.stale ? 'unavailable_or_stale' : 'fresh', markEvidence: { snapshotId: 'mark', source: 'binance_usdm_mark_ws', effectiveAt: at, capturedAt: at }, referencePriceEvidence: { effectiveAt: options.oldReference ? new Date(Date.now() - 60000).toISOString() : referenceAt, capturedAt: referenceAt } };
  const position = { id: accountId + ':position', tradingAccountId: accountId, instrumentId: 'btc', direction: options.direction ?? 'long', marginMode: options.marginMode ?? 'isolated', leverage: options.leverage ?? 100, quantity: '2', averageEntryPrice: '100', isolatedMargin: '2', realizedPnl: '0.12345678', initialMargin: '2', markNotional: options.stale ? null : options.large ? '9876543210123456.12345678' : '202', roi: options.stale ? null : '-106.172839', instrument, markPrice: instrument.markPrice, referencePrice: '102', markUnrealizedPnl: options.large ? '-9876543210123456.12345678' : '-2.12345678', markState: instrument.markState, markEvidence: instrument.markEvidence, referencePriceEvidence: instrument.referencePriceEvidence, risk: options.stale ? null : { unrealizedPnl: '-2', initialRequirement: '2.02', maintenanceMargin: '1.01', estimatedCloseFee: '0.2', liquidationRequirement: '1.21', liquidationBuffer: '-1.21', liquidationPrice: '99.5' } };
  const cross = options.position && position.marginMode === 'cross';
  return {
    catalog: { tradingAccountId: accountId, evaluatedAt: referenceAt, capabilities, instruments: options.empty ? [] : [instrument] },
    positions: { tradingAccountId: accountId, evaluatedAt: referenceAt, capabilities, positions: options.position ? [position] : [], collateral: { balanceAmount: '10000', totalMarginUsed: cross ? '0' : options.position ? '2' : '0', freeCollateral: options.stale && cross ? null : '9995' }, cross: { positionIds: cross ? [position.id] : [], evaluatedAt: referenceAt, markState: instrument.markState, metrics: options.stale ? null : { crossBaseCollateral: '10000', crossUnrealizedPnl: '-2', crossEquity: '9998', crossInitialMarginRequirement: '2.02', crossMaintenanceRequirement: '1.21', crossFreeCollateral: '9995.98', liquidationBuffer: '9996.79' } } },
    executions: { tradingAccountId: accountId, pagination: { limit: 20, offset: 0, total: 1, returned: 1, nextOffset: null }, executions: [{ id: 'execution', instrument, operation: 'open', direction: position.direction, quantity: '2', executionPrice: '100', realizedPnl: '0', feeAmount: '0.2', executedAt: at }] },
    liquidations: { tradingAccountId: accountId, pagination: { limit: 20, offset: 0, total: 1, returned: 1, nextOffset: null }, liquidations: [{ id: 'liquidation', marginMode: position.marginMode, realizedPnl: '-200', feeAmount: '0.2', settledFee: '0.1', settledCash: '-2', bankruptcyShortfall: '198.2', executedAt: at, closes: [{ positionId: 'old-position', instrumentId: 'btc', direction: 'long', quantity: '2', executionPrice: '0.1', markSnapshot: { symbol: 'BTCUSDT' } }] }] },
    final: { tradingAccountId: accountId, settlement: null },
  };
}
const accounts = [
  { id: 'A', mode: 'general', status: 'active', season: null },
  { id: 'B', mode: 'season', status: 'active', season: { seasonId: 'season', seasonName: '테스트 시즌', seasonStatus: 'active', participantStatus: 'active', startAt: new Date(Date.now() - 86400000).toISOString(), endAt: new Date(Date.now() + 86400000).toISOString() } },
];
module.exports = { futuresFixture, accounts };
